from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from dev_crew.api.schemas import (
    JobCreateRequest,
    JobCreateResponse,
    JobStatusResponse,
    LLMModelResponse,
    LLMModelsCatalogResponse,
    LLMUsageSnapshotResponse,
    LLMProviderCatalogResponse,
)
from dev_crew.llm import FileTokenStore, LLMUsageTracker, ModelCatalogService, ProviderId
from dev_crew.models import JobState
from dev_crew.orchestration import CrewAIOrchestrator
from dev_crew.queue.in_memory import InMemoryJobQueue
from dev_crew.runtime import (
    DockerSandboxConfig,
    DockerSandboxExecutor,
    EscalationManager,
    JobBudgetConfig,
    JsonlAuditLogger,
)
from dev_crew.services.jobs import (
    IdempotencyConflictError,
    JobNotFoundError,
    JobService,
)
from dev_crew.storage.sqlite import SqliteJobStore


def _default_db_path() -> str:
    return os.getenv("DEV_CREW_DB_PATH", ".dev_crew/jobs.db")


def _default_audit_log_path() -> str:
    return os.getenv("DEV_CREW_AUDIT_LOG_PATH", ".dev_crew/audit.log")


def _default_escalation_log_path() -> str:
    return os.getenv("DEV_CREW_ESCALATION_LOG_PATH", ".dev_crew/escalations.log")


def _env_text(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _default_local_llm_model() -> str:
    return _env_text("DEV_CREW_LOCAL_LLM_MODEL") or "ollama/llama3.1:8b"


def _default_crewai_llm() -> str:
    return _env_text("DEV_CREW_CREWAI_LLM") or _default_local_llm_model()


def _default_crewai_manager_llm() -> str:
    return _env_text("DEV_CREW_CREWAI_MANAGER_LLM") or _default_crewai_llm()


def _env_flag(name: str, default: str = "0") -> bool:
    return os.getenv(name, default) == "1"


def create_app(db_path: str | None = None) -> FastAPI:
    workspace_root = os.getenv("DEV_CREW_WORKSPACE_ROOT", ".")
    llm_account_id = _env_text("DEV_CREW_LLM_ACCOUNT_ID") or "default"
    codex_client_version = _env_text("DEV_CREW_CODEX_CLIENT_VERSION") or "0.1.0"
    store = SqliteJobStore(db_path or _default_db_path())
    queue = InMemoryJobQueue()
    audit_logger = JsonlAuditLogger(_default_audit_log_path())
    escalation_manager = EscalationManager(_default_escalation_log_path(), audit_logger=audit_logger)
    budget_config = JobBudgetConfig(
        max_state_transitions=int(os.getenv("DEV_CREW_JOB_MAX_STATE_TRANSITIONS", "20")),
        max_tool_calls=int(os.getenv("DEV_CREW_JOB_MAX_TOOL_CALLS", "10")),
    )
    sandbox_executor = DockerSandboxExecutor(
        DockerSandboxConfig(
            image=os.getenv("DEV_CREW_DOCKER_IMAGE", "python:3.13-slim"),
            workdir=os.getenv("DEV_CREW_DOCKER_WORKDIR", "/workspace"),
            timeout_seconds=int(os.getenv("DEV_CREW_DOCKER_TIMEOUT_SECONDS", "120")),
        )
    )
    token_store = FileTokenStore(
        path=_env_text("DEV_CREW_OAUTH_TOKEN_PATH"),
        workspace_root=workspace_root,
        allow_workspace_path=_env_flag("DEV_CREW_OAUTH_ALLOW_WORKSPACE_PATH", "0"),
    )
    usage_tracker = LLMUsageTracker(
        window_minutes=int(os.getenv("DEV_CREW_LLM_USAGE_WINDOW_MINUTES", "60"))
    )
    service = JobService(
        store=store,
        queue=queue,
        workspace_root=os.getenv("DEV_CREW_WORKSPACE_ROOT", "."),
        budget_config=budget_config,
        audit_logger=audit_logger,
        escalation_manager=escalation_manager,
        sandbox_executor=sandbox_executor,
        orchestrator=CrewAIOrchestrator(
            workspace_root=workspace_root,
            enabled=os.getenv("DEV_CREW_USE_CREWAI", "1") == "1",
            dry_run=os.getenv("DEV_CREW_CREWAI_DRY_RUN", "1") == "1",
            llm=_default_crewai_llm(),
            manager_llm=_default_crewai_manager_llm(),
            verbose=os.getenv("DEV_CREW_CREWAI_VERBOSE", "0") == "1",
            token_store=token_store,
            usage_tracker=usage_tracker,
            llm_account_id=llm_account_id,
            llm_request_timeout_seconds=float(
                os.getenv("DEV_CREW_LLM_REQUEST_TIMEOUT_SECONDS", "60")
            ),
            codex_client_version=codex_client_version,
        ),
    )
    model_catalog = ModelCatalogService(
        token_store=token_store,
        account_id=_env_text("DEV_CREW_MODEL_CATALOG_ACCOUNT_ID") or llm_account_id,
        refresh_interval_seconds=int(os.getenv("DEV_CREW_MODEL_CATALOG_REFRESH_SECONDS", "600")),
        request_timeout_seconds=float(
            os.getenv("DEV_CREW_MODEL_CATALOG_HTTP_TIMEOUT_SECONDS", "10")
        ),
        codex_client_version=codex_client_version,
        auto_refresh=_env_flag("DEV_CREW_MODEL_CATALOG_AUTO_REFRESH", "1"),
        startup_refresh=_env_flag("DEV_CREW_MODEL_CATALOG_STARTUP_REFRESH", "1"),
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await queue.start(service.process_job)
        await model_catalog.start()
        yield
        await model_catalog.stop()
        await queue.stop()

    app = FastAPI(title="Dev Crew API", version="0.1.0", lifespan=lifespan)
    app.state.llm_usage_tracker = usage_tracker
    app.state.llm_model_catalog = model_catalog

    @app.post("/jobs", response_model=JobCreateResponse)
    async def create_job(
        payload: JobCreateRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> JobCreateResponse:
        try:
            result = await service.create_job(
                goal=payload.goal,
                repo=payload.repo,
                base_branch=payload.base_branch,
                idempotency_key=idempotency_key,
            )
        except IdempotencyConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        return JobCreateResponse(
            job_id=result.job.job_id,
            state=result.job.current_state.value,
            reused=result.reused,
        )

    @app.get("/jobs/{job_id}", response_model=JobStatusResponse)
    async def get_job(job_id: str) -> JobStatusResponse:
        try:
            job = service.get_job(job_id)
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        return JobStatusResponse(
            job_id=job.job_id,
            goal=job.goal,
            repo=job.repo,
            base_branch=job.base_branch,
            work_branch=job.work_branch,
            state=job.current_state.value,
            history_count=len(job.history),
            last_event=job.history[-1] if job.history else None,
        )

    @app.get("/jobs/{job_id}/events")
    async def stream_job_events(job_id: str) -> StreamingResponse:
        try:
            service.get_job(job_id)
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        async def event_generator() -> AsyncIterator[str]:
            last_seen_id = 0
            while True:
                events = service.list_events(job_id, after_id=last_seen_id)
                for event in events:
                    last_seen_id = event["id"]
                    yield f"id: {event['id']}\n"
                    yield "event: job_event\n"
                    yield f"data: {json.dumps(event, ensure_ascii=True)}\n\n"

                job = service.get_job(job_id)
                if job.current_state in {JobState.COMPLETED, JobState.FAILED, JobState.CANCELED}:
                    break
                await asyncio.sleep(0.25)

            yield "event: done\n"
            yield f"data: {json.dumps({'job_id': job_id}, ensure_ascii=True)}\n\n"

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    @app.get("/jobs/{job_id}/escalations")
    async def list_job_escalations(job_id: str) -> list[dict]:
        try:
            service.get_job(job_id)
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return service.list_escalations(job_id)

    @app.get("/llm/models", response_model=LLMModelsCatalogResponse)
    async def list_llm_models(
        force_refresh: bool = Query(default=False),
        provider: ProviderId | None = Query(default=None),
    ) -> LLMModelsCatalogResponse:
        if force_refresh:
            await model_catalog.refresh(provider=provider)
        provider_rows, model_rows = model_catalog.snapshot(provider=provider)
        return LLMModelsCatalogResponse(
            refresh_interval_seconds=model_catalog.refresh_interval_seconds,
            auto_refresh=model_catalog.auto_refresh,
            providers=[
                LLMProviderCatalogResponse.model_validate(row.model_dump(mode="json"))
                for row in provider_rows
            ],
            models=[LLMModelResponse.model_validate(row.model_dump(mode="json")) for row in model_rows],
        )

    @app.post("/llm/models/refresh", response_model=LLMModelsCatalogResponse)
    async def refresh_llm_models(
        provider: ProviderId | None = Query(default=None),
    ) -> LLMModelsCatalogResponse:
        await model_catalog.refresh(provider=provider)
        provider_rows, model_rows = model_catalog.snapshot(provider=provider)
        return LLMModelsCatalogResponse(
            refresh_interval_seconds=model_catalog.refresh_interval_seconds,
            auto_refresh=model_catalog.auto_refresh,
            providers=[
                LLMProviderCatalogResponse.model_validate(row.model_dump(mode="json"))
                for row in provider_rows
            ],
            models=[LLMModelResponse.model_validate(row.model_dump(mode="json")) for row in model_rows],
        )

    @app.get("/llm/usage", response_model=LLMUsageSnapshotResponse)
    async def get_llm_usage(
        provider: ProviderId | None = Query(default=None),
        model: str | None = Query(default=None),
    ) -> LLMUsageSnapshotResponse:
        snapshot = usage_tracker.snapshot(provider=provider, model=model)
        return LLMUsageSnapshotResponse.model_validate(snapshot)

    @app.post("/llm/usage/reset", response_model=LLMUsageSnapshotResponse)
    async def reset_llm_usage() -> LLMUsageSnapshotResponse:
        usage_tracker.reset()
        return LLMUsageSnapshotResponse.model_validate(usage_tracker.snapshot())

    return app


app = create_app()
