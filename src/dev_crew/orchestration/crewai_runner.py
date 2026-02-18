from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dev_crew.hooks.observability import EventLogger
from dev_crew.llm import CustomLLMAdapter, CustomLLMConfig, FileTokenStore, HttpProviderRunner, LLMUsageTracker
from dev_crew.llm.models import LLMRequest, ProviderId
from dev_crew.models import JobRecord

ProviderRunner = Callable[[ProviderId, str, str, str], str]


class CrewAIExecutionError(RuntimeError):
    pass


@dataclass
class CrewTaskSpec:
    name: str
    role: str
    description: str
    expected_output: str
    async_execution: bool = True


@dataclass
class CrewPlan:
    roles: list[str]
    tasks: list[CrewTaskSpec]


@dataclass
class CrewRunResult:
    summary: str
    metadata: dict[str, Any]
    raw_output: str | None = None


def _messages_to_prompt(messages: Any) -> str:
    if isinstance(messages, str):
        return messages
    if not isinstance(messages, list):
        return str(messages)

    chunks: list[str] = []
    for row in messages:
        if not isinstance(row, dict):
            chunks.append(str(row))
            continue
        role = str(row.get("role") or "user").upper()
        content = _content_to_text(row.get("content"))
        if content:
            chunks.append(f"[{role}]\n{content}")
    return "\n\n".join(chunks)


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces = [_content_to_text(item) for item in content]
        return "\n".join(piece for piece in pieces if piece)
    if isinstance(content, dict):
        if "text" in content:
            return _content_to_text(content.get("text"))
        if "content" in content:
            return _content_to_text(content.get("content"))
        if "parts" in content:
            return _content_to_text(content.get("parts"))
    return ""


class CrewAIOrchestrator:
    """Declares crew agents/tasks and manages parallel execution via CrewAI."""

    def __init__(
        self,
        *,
        workspace_root: str,
        enabled: bool = True,
        dry_run: bool = True,
        llm: str | None = None,
        manager_llm: str | None = None,
        verbose: bool = False,
        token_store: FileTokenStore | None = None,
        usage_tracker: LLMUsageTracker | None = None,
        llm_account_id: str = "default",
        provider_runner: ProviderRunner | None = None,
        oauth_refresh_leeway_seconds: int = 0,
        llm_request_timeout_seconds: float = 60.0,
        codex_client_version: str = "0.1.0",
    ) -> None:
        self.workspace_root = str(Path(workspace_root).expanduser().resolve())
        self.enabled = enabled
        self.dry_run = dry_run
        self.llm = llm
        self.manager_llm = manager_llm
        self.verbose = verbose
        self.llm_account_id = llm_account_id

        self.token_store = token_store or FileTokenStore(workspace_root=self.workspace_root)
        self.usage_tracker = usage_tracker
        self.custom_llm_config = CustomLLMConfig(
            oauth_refresh_leeway_seconds=oauth_refresh_leeway_seconds
        )
        self.custom_llm_logger = EventLogger()
        self.custom_llm_adapter = CustomLLMAdapter(
            config=self.custom_llm_config,
            token_store=self.token_store,
            logger=self.custom_llm_logger,
            usage_tracker=self.usage_tracker,
        )
        self.provider_runner = provider_runner or HttpProviderRunner(
            account_id=llm_account_id,
            request_timeout_seconds=llm_request_timeout_seconds,
            codex_client_version=codex_client_version,
        )

    def build_plan(self, job: JobRecord) -> CrewPlan:
        roles = [
            "leader",
            "architect",
            "frontend",
            "backend",
            "designer",
            "ci/cd engineer",
            "qa engineer",
            "security engineer",
        ]
        repo_context = f"repo={job.repo}, base_branch={job.base_branch}, work_branch={job.work_branch}"

        tasks = [
            CrewTaskSpec(
                name="architecture",
                role="architect",
                description=f"Define technical architecture and interfaces for goal: {job.goal}. {repo_context}",
                expected_output="Architecture decisions and interface contracts.",
                async_execution=True,
            ),
            CrewTaskSpec(
                name="frontend",
                role="frontend",
                description=f"Create frontend implementation plan for goal: {job.goal}. {repo_context}",
                expected_output="Frontend task list and validation points.",
                async_execution=True,
            ),
            CrewTaskSpec(
                name="backend",
                role="backend",
                description=f"Create backend implementation plan for goal: {job.goal}. {repo_context}",
                expected_output="Backend task list and API/database changes.",
                async_execution=True,
            ),
            CrewTaskSpec(
                name="design",
                role="designer",
                description=f"Provide UX/UI considerations for goal: {job.goal}. {repo_context}",
                expected_output="Design constraints and acceptance criteria.",
                async_execution=True,
            ),
            CrewTaskSpec(
                name="cicd",
                role="ci/cd engineer",
                description=f"Define CI/CD and release checks for goal: {job.goal}. {repo_context}",
                expected_output="Pipeline updates and deployment risks.",
                async_execution=True,
            ),
            CrewTaskSpec(
                name="qa",
                role="qa engineer",
                description=f"Define test strategy and edge cases for goal: {job.goal}. {repo_context}",
                expected_output="Test matrix and validation checklist.",
                async_execution=True,
            ),
            CrewTaskSpec(
                name="security",
                role="security engineer",
                description=f"Review security risks for goal: {job.goal}. {repo_context}",
                expected_output="Security risks and mitigations.",
                async_execution=True,
            ),
            CrewTaskSpec(
                name="leader_synthesis",
                role="leader",
                description=(
                    "Aggregate all specialist outputs into an executable plan with priorities, "
                    "dependencies, and explicit acceptance criteria."
                ),
                expected_output="Final consolidated execution plan.",
                async_execution=False,
            ),
        ]
        return CrewPlan(roles=roles, tasks=tasks)

    def run(self, job: JobRecord) -> CrewRunResult:
        plan = self.build_plan(job)
        dry_run_manifest = self._task_manifest_from_plan(plan.tasks)
        if not self.enabled:
            return CrewRunResult(
                summary="CrewAI disabled; skipped orchestration.",
                metadata={
                    "enabled": False,
                    "dry_run": self.dry_run,
                    "roles": plan.roles,
                    "tasks": dry_run_manifest,
                    "workflow": self._workflow_manifest(dry_run_manifest),
                },
            )

        self._prepare_environment()
        if self.dry_run:
            return CrewRunResult(
                summary="CrewAI dry-run completed (agents/tasks declared).",
                metadata={
                    "enabled": True,
                    "dry_run": True,
                    "roles": plan.roles,
                    "tasks": dry_run_manifest,
                    "workflow": self._workflow_manifest(dry_run_manifest),
                },
            )

        crew, task_manifest = self._build_crew(plan)
        try:
            output = crew.kickoff(
                inputs={
                    "goal": job.goal,
                    "repo": job.repo,
                    "base_branch": job.base_branch,
                    "work_branch": job.work_branch,
                }
            )
        except Exception as exc:
            raise CrewAIExecutionError(f"CrewAI kickoff failed: {exc}") from exc

        return CrewRunResult(
            summary="CrewAI execution completed.",
            metadata={
                "enabled": True,
                "dry_run": False,
                "roles": plan.roles,
                "tasks": task_manifest,
                "workflow": self._workflow_manifest(task_manifest),
            },
            raw_output=str(output),
        )

    def _prepare_environment(self) -> None:
        # CrewAI writes internal state under user data dir. In sandboxed runs this path may
        # be unwritable, so redirect HOME into workspace to keep storage local and writable.
        os.environ.setdefault("CREWAI_STORAGE_DIR", "dev_crew")
        os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
        os.environ.setdefault("OTEL_SDK_DISABLED", "true")
        os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
        os.environ.setdefault("CREWAI_DISABLE_TRACKING", "true")
        storage_name = os.environ.get("CREWAI_STORAGE_DIR", "dev_crew")
        test_path = Path.home() / "Library" / "Application Support" / storage_name
        try:
            test_path.mkdir(parents=True, exist_ok=True)
        except Exception:
            os.environ["HOME"] = self.workspace_root
            local_path = Path.home() / "Library" / "Application Support" / storage_name
            local_path.mkdir(parents=True, exist_ok=True)

    def _build_crew(self, plan: CrewPlan) -> tuple[Any, list[dict[str, Any]]]:
        from crewai import Agent, Crew, Process, Task
        from crewai.llms.base_llm import BaseLLM

        class OfflineEchoLLM(BaseLLM):
            def __init__(self) -> None:
                super().__init__(model="offline-echo", provider="offline")

            def call(
                self,
                messages: Any,
                tools: list[dict[str, Any]] | None = None,
                callbacks: list[Any] | None = None,
                available_functions: dict[str, Any] | None = None,
                from_task: Any | None = None,
                from_agent: Any | None = None,
                response_model: Any | None = None,
            ) -> str:
                del tools, callbacks, available_functions, from_task, from_agent, response_model
                if isinstance(messages, str):
                    return f"[offline-echo] {messages[:200]}"
                return "[offline-echo] structured-messages"

        class OAuthAdapterLLM(BaseLLM):
            def __init__(
                self,
                *,
                model: str,
                adapter: CustomLLMAdapter,
                provider_runner: ProviderRunner,
                account_id: str,
            ) -> None:
                super().__init__(model=model, provider="custom-oauth")
                self._adapter = adapter
                self._provider_runner = provider_runner
                self._account_id = account_id

            def call(
                self,
                messages: Any,
                tools: list[dict[str, Any]] | None = None,
                callbacks: list[Any] | None = None,
                available_functions: dict[str, Any] | None = None,
                from_task: Any | None = None,
                from_agent: Any | None = None,
                response_model: Any | None = None,
            ) -> str:
                del tools, callbacks, available_functions, from_task, from_agent, response_model
                prompt = _messages_to_prompt(messages)
                response = self._adapter.invoke(
                    LLMRequest(model=self.model, prompt=prompt),
                    self._provider_runner,
                    account_id=self._account_id,
                )
                output = response.output
                if self.stop:
                    output = self._apply_stop_words(output)
                return output

            def supports_function_calling(self) -> bool:
                return False

        default_llm = OfflineEchoLLM()

        def _resolve_llm(raw_llm: Any, *, fallback: Any) -> Any:
            if raw_llm is None:
                return fallback
            if not isinstance(raw_llm, str):
                return raw_llm
            model = raw_llm.strip()
            if not model:
                return fallback
            if not self._model_uses_custom_adapter(model):
                return model
            return OAuthAdapterLLM(
                model=model,
                adapter=self.custom_llm_adapter,
                provider_runner=self.provider_runner,
                account_id=self.llm_account_id,
            )

        agent_llm: Any = _resolve_llm(self.llm, fallback=default_llm)
        manager_llm: Any = _resolve_llm(self.manager_llm, fallback=agent_llm)
        planning_enabled = bool(self.llm or self.manager_llm)
        planning_llm: Any = manager_llm if planning_enabled else None

        agents_by_role = {
            role: Agent(
                role=role,
                goal=f"Act as {role} to support delivery quality and speed.",
                backstory=f"You are the {role} in a software delivery crew.",
                allow_delegation=(role == "leader"),
                verbose=self.verbose,
                llm=agent_llm,
            )
            for role in plan.roles
        }

        specialist_tasks: list[Any] = []
        leader_task_spec: CrewTaskSpec | None = None
        task_manifest: list[dict[str, Any]] = []
        for task_spec in plan.tasks:
            phase = "pan_in" if task_spec.role == "leader" else "pan_out"
            task_manifest.append(
                {
                    "name": task_spec.name,
                    "role": task_spec.role,
                    "async_execution": task_spec.async_execution,
                    "phase": phase,
                    "description": task_spec.description,
                    "expected_output": task_spec.expected_output,
                    "sequence": len(task_manifest) + 1,
                }
            )
            if task_spec.role == "leader":
                leader_task_spec = task_spec
                continue

            specialist_tasks.append(
                Task(
                    name=task_spec.name,
                    description=task_spec.description,
                    expected_output=task_spec.expected_output,
                    agent=agents_by_role[task_spec.role],
                    async_execution=task_spec.async_execution,
                )
            )

        if not leader_task_spec:
            raise CrewAIExecutionError("leader task spec is missing from Crew plan")

        leader_task = Task(
            name=leader_task_spec.name,
            description=leader_task_spec.description,
            expected_output=leader_task_spec.expected_output,
            agent=agents_by_role["leader"],
            context=specialist_tasks,
            async_execution=False,
        )
        crew_tasks = specialist_tasks + [leader_task]

        crew = Crew(
            name="dev-crew",
            agents=list(agents_by_role.values()),
            tasks=crew_tasks,
            process=Process.sequential,
            verbose=self.verbose,
            manager_llm=manager_llm,
            planning=planning_enabled,
            planning_llm=planning_llm,
            tracing=False,
        )
        return crew, task_manifest

    def _model_uses_custom_adapter(self, model: str) -> bool:
        model_lower = model.lower().strip()
        for prefix in self.custom_llm_config.model_routes:
            if model_lower.startswith(prefix):
                return True
        return False

    @staticmethod
    def _workflow_manifest(task_manifest: list[dict[str, Any]]) -> dict[str, Any]:
        pan_out_tasks = [task for task in task_manifest if task.get("phase") == "pan_out"]
        pan_in_tasks = [task for task in task_manifest if task.get("phase") == "pan_in"]
        return {
            "call_order": [
                "request",
                "pan_out",
                "pan_in",
                "aggregation",
                "final_conclusion",
            ],
            "pan_out_roles": sorted({task["role"] for task in pan_out_tasks}),
            "pan_in_roles": sorted({task["role"] for task in pan_in_tasks}),
            "task_order": [task["name"] for task in task_manifest],
        }

    @staticmethod
    def _task_manifest_from_plan(tasks: list[CrewTaskSpec]) -> list[dict[str, Any]]:
        manifest: list[dict[str, Any]] = []
        for task in tasks:
            phase = "pan_in" if task.role == "leader" else "pan_out"
            manifest.append(
                {
                    "name": task.name,
                    "role": task.role,
                    "async_execution": task.async_execution,
                    "phase": phase,
                    "description": task.description,
                    "expected_output": task.expected_output,
                    "sequence": len(manifest) + 1,
                }
            )
        return manifest
