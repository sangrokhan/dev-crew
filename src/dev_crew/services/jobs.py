from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dev_crew.models import JobEvent, JobRecord, JobState
from dev_crew.orchestration import CrewAIOrchestrator
from dev_crew.queue.in_memory import InMemoryJobQueue
from dev_crew.runtime import (
    DockerSandboxConfig,
    DockerSandboxExecutor,
    EscalationManager,
    JobBudgetConfig,
    JobBudgetGuard,
    JsonlAuditLogger,
)
from dev_crew.storage.sqlite import SqliteJobStore


TERMINAL_STATES = {JobState.COMPLETED, JobState.FAILED, JobState.CANCELED}


class JobNotFoundError(RuntimeError):
    pass


class IdempotencyConflictError(RuntimeError):
    pass


@dataclass
class CreateJobResult:
    job: JobRecord
    reused: bool


class JobService:
    def __init__(
        self,
        store: SqliteJobStore,
        queue: InMemoryJobQueue,
        *,
        workspace_root: str = ".",
        budget_config: JobBudgetConfig | None = None,
        audit_logger: JsonlAuditLogger | None = None,
        escalation_manager: EscalationManager | None = None,
        sandbox_executor: DockerSandboxExecutor | None = None,
        orchestrator: CrewAIOrchestrator | None = None,
    ) -> None:
        self.store = store
        self.queue = queue
        self.workspace_root = str(Path(workspace_root).expanduser().resolve())
        self.budget_config = budget_config or JobBudgetConfig()
        self.audit_logger = audit_logger or JsonlAuditLogger(".dev_crew/audit.log")
        self.escalation_manager = escalation_manager or EscalationManager(
            ".dev_crew/escalations.log",
            audit_logger=self.audit_logger,
        )
        self.sandbox_executor = sandbox_executor or DockerSandboxExecutor(DockerSandboxConfig())
        self.orchestrator = orchestrator or CrewAIOrchestrator(
            workspace_root=self.workspace_root,
            enabled=True,
            dry_run=True,
        )

    async def create_job(
        self,
        *,
        goal: str,
        repo: str,
        base_branch: str = "main",
        idempotency_key: str | None = None,
    ) -> CreateJobResult:
        request_hash = self._request_hash(goal=goal, repo=repo, base_branch=base_branch)
        if idempotency_key:
            existing = self.store.get_idempotency(idempotency_key)
            if existing:
                stored_hash, job_id = existing
                if stored_hash != request_hash:
                    raise IdempotencyConflictError(
                        "idempotency key already used with different request payload"
                    )
                existing_job = self.store.get_job(job_id)
                if not existing_job:
                    raise JobNotFoundError(f"idempotent job not found: {job_id}")
                return CreateJobResult(job=existing_job, reused=True)

        job_id = str(uuid.uuid4())
        work_branch = f"crew/{job_id[:8]}"
        job = JobRecord(
            job_id=job_id,
            goal=goal,
            repo=repo,
            base_branch=base_branch,
            work_branch=work_branch,
            history=[
                JobEvent(
                    at=datetime.now(timezone.utc),
                    state=JobState.RECEIVED,
                    message="Job created",
                    metadata={
                        "idempotency_key": idempotency_key or "",
                        "event_type": "workflow_step",
                        "step": "request",
                        "phase": "received",
                        "call_order": 1,
                        "details": {
                            "goal": goal,
                            "repo": repo,
                            "base_branch": base_branch,
                            "work_branch": work_branch,
                        },
                    },
                )
            ],
        )
        self.store.create_job(job)
        self.audit_logger.log(
            job_id=job.job_id,
            category="job",
            action="created",
            metadata={
                "goal": goal,
                "repo": repo,
                "base_branch": base_branch,
                "work_branch": work_branch,
            },
        )
        self.audit_logger.log(
            job_id=job.job_id,
            category="workflow",
            action="request:received",
            metadata={
                "step": "request",
                "phase": "received",
                "call_order": 1,
                "details": {
                    "goal": goal,
                    "repo": repo,
                    "base_branch": base_branch,
                    "work_branch": work_branch,
                },
            },
        )

        if idempotency_key:
            self.store.create_idempotency(idempotency_key, request_hash, job_id)

        await self.queue.enqueue(job_id)
        return CreateJobResult(job=job, reused=False)

    def get_job(self, job_id: str) -> JobRecord:
        job = self.store.get_job(job_id)
        if not job:
            raise JobNotFoundError(f"job not found: {job_id}")
        return job

    def list_events(self, job_id: str, after_id: int = 0) -> list[dict]:
        return [
            {
                "id": row.id,
                "job_id": row.job_id,
                "at": row.at,
                "state": row.state,
                "message": row.message,
                "metadata": json.loads(row.metadata_json),
            }
            for row in self.store.list_event_rows(job_id=job_id, after_id=after_id)
        ]

    def list_escalations(self, job_id: str) -> list[dict]:
        return [
            {
                "escalation_id": escalation.escalation_id,
                "at": escalation.at,
                "job_id": escalation.job_id,
                "severity": escalation.severity,
                "reason": escalation.reason,
                "metadata": escalation.metadata,
            }
            for escalation in self.escalation_manager.list_for_job(job_id)
        ]

    async def process_job(self, job_id: str) -> None:
        job = self.store.get_job(job_id)
        if not job:
            return
        if job.current_state in TERMINAL_STATES:
            return

        budget_guard = JobBudgetGuard(
            self.budget_config,
            initial_transitions=self._count_state_transitions(job),
        )

        try:
            await self._advance(
                job,
                JobState.CONTEXT_COLLECTING,
                "Collecting repository context",
                budget_guard=budget_guard,
            )
            self._record_workflow_step(
                job,
                step="pan_out",
                phase="started",
                message="Fan-out started for specialist agents",
            )
            crew_result = self.orchestrator.run(job)
            self._record_workflow_step(
                job,
                step="pan_out",
                phase="completed",
                message="Fan-out completed for specialist agents",
                details={
                    "roles": crew_result.metadata.get("workflow", {}).get("pan_out_roles", []),
                    "task_count": len(crew_result.metadata.get("tasks", [])),
                },
            )
            self._record_agent_decisions(job, crew_result.metadata)
            self._record_workflow_step(
                job,
                step="pan_in",
                phase="completed",
                message="Leader pan-in synthesis completed",
                details={
                    "roles": crew_result.metadata.get("workflow", {}).get("pan_in_roles", []),
                    "summary": crew_result.summary,
                },
            )
            await self._advance(
                job,
                JobState.PLANNING,
                "Running CrewAI leader fan-out for specialist agents",
                budget_guard=budget_guard,
                metadata={
                    "crewai_summary": crew_result.summary,
                    "crewai": crew_result.metadata,
                },
            )
            self._record_workflow_step(
                job,
                step="aggregation",
                phase="completed",
                message="Specialist outputs aggregated into plan context",
                details={"crewai_summary": crew_result.summary},
            )
            self.audit_logger.log(
                job_id=job.job_id,
                category="crewai",
                action="orchestration",
                metadata={
                    "summary": crew_result.summary,
                    "metadata": crew_result.metadata,
                    "raw_output": crew_result.raw_output or "",
                },
            )
            await self._advance(
                job,
                JobState.AWAITING_PLAN_APPROVAL,
                "Plan approval checkpoint reached (manual gate)",
                budget_guard=budget_guard,
            )
            await self._advance(
                job,
                JobState.EXECUTING,
                "Executing implementation and test workflow",
                budget_guard=budget_guard,
            )
            await self._run_build_in_sandbox(job, budget_guard)
            await self._advance(
                job,
                JobState.REPORTING,
                "Generating execution report",
                budget_guard=budget_guard,
            )
            await self._advance(
                job,
                JobState.COMPLETED,
                "Job completed",
                budget_guard=budget_guard,
            )
            self._record_workflow_step(
                job,
                step="final_conclusion",
                phase="completed",
                message="Final conclusion recorded",
                details={"result": "completed"},
            )
        except Exception as exc:
            try:
                self._record_workflow_step(
                    job,
                    step="final_conclusion",
                    phase="failed",
                    message="Final conclusion recorded",
                    details={
                        "result": "failed",
                        "error": str(exc),
                        "failed_state": job.current_state.value,
                    },
                )
            except Exception:
                pass
            escalation = self.escalation_manager.create(
                job_id=job.job_id,
                severity="high",
                reason="Job processing failed",
                metadata={"error": str(exc), "state": job.current_state.value},
            )
            if job.current_state not in TERMINAL_STATES:
                try:
                    await self._advance(
                        job,
                        JobState.FAILED,
                        "Job failed during processing",
                        metadata={
                            "error": str(exc),
                            "escalation_id": escalation.escalation_id,
                        },
                        budget_guard=budget_guard,
                        enforce_budget=False,
                    )
                except Exception:
                    pass

    async def _run_build_in_sandbox(self, job: JobRecord, budget_guard: JobBudgetGuard) -> None:
        budget_guard.consume_tool_call()
        sandbox_result = self.sandbox_executor.run(
            command=["pytest", "-q"],
            host_workspace=self.workspace_root,
        )
        self.audit_logger.log(
            job_id=job.job_id,
            category="tool_call",
            action="sandbox_run",
            metadata={
                "command": sandbox_result.command,
                "returncode": sandbox_result.returncode,
                "stdout": sandbox_result.stdout,
                "stderr": sandbox_result.stderr,
                "duration_ms": sandbox_result.duration_ms,
                "sandbox": sandbox_result.sandbox,
                "target_repo": job.repo,
            },
        )
        self._record_workflow_step(
            job,
            step="execution",
            phase="completed" if sandbox_result.returncode == 0 else "failed",
            message="Sandbox test execution finished",
            details={
                "command": sandbox_result.command,
                "returncode": sandbox_result.returncode,
                "duration_ms": sandbox_result.duration_ms,
            },
        )
        await asyncio.sleep(0)

    async def _advance(
        self,
        job: JobRecord,
        state: JobState,
        message: str,
        budget_guard: JobBudgetGuard,
        metadata: dict | None = None,
        enforce_budget: bool = True,
    ) -> None:
        if enforce_budget:
            budget_guard.consume_transition()
        previous_state = job.current_state
        call_order = len(job.history) + 1
        enriched_metadata: dict[str, Any] = {
            "event_type": "state_transition",
            "from_state": previous_state.value,
            "to_state": state.value,
            "call_order": call_order,
        }
        if metadata:
            enriched_metadata.update(metadata)
        job.transition_to(state, message, metadata=enriched_metadata)
        event = job.history[-1]
        self.store.append_event(job.job_id, event)
        self.audit_logger.log(
            job_id=job.job_id,
            category="state_transition",
            action=f"{previous_state.value}->{state.value}",
            metadata={
                "message": message,
                "metadata": event.metadata,
            },
        )
        await asyncio.sleep(0)

    def _record_workflow_step(
        self,
        job: JobRecord,
        *,
        step: str,
        phase: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        call_order = len(job.history) + 1
        metadata = {
            "event_type": "workflow_step",
            "step": step,
            "phase": phase,
            "call_order": call_order,
            "details": details or {},
        }
        event = JobEvent(
            at=datetime.now(timezone.utc),
            state=job.current_state,
            message=message,
            metadata=metadata,
        )
        job.history.append(event)
        self.store.append_event(job.job_id, event)
        self.audit_logger.log(
            job_id=job.job_id,
            category="workflow",
            action=f"{step}:{phase}",
            metadata=metadata,
        )

    def _record_agent_decisions(self, job: JobRecord, crew_metadata: dict[str, Any]) -> None:
        tasks = crew_metadata.get("tasks", [])
        if not isinstance(tasks, list):
            return

        for task in tasks:
            if not isinstance(task, dict):
                continue
            role = str(task.get("role", "unknown"))
            phase = str(task.get("phase", "pan_out" if role != "leader" else "pan_in"))
            task_name = str(task.get("name", "unknown"))
            call_order = len(job.history) + 1
            metadata = {
                "event_type": "agent_decision",
                "agent_role": role,
                "task_name": task_name,
                "phase": phase,
                "call_order": call_order,
                "decision": f"{role} planned task {task_name}",
                "async_execution": bool(task.get("async_execution", False)),
            }
            event = JobEvent(
                at=datetime.now(timezone.utc),
                state=job.current_state,
                message=f"Agent decision recorded: {role} -> {task_name}",
                metadata=metadata,
            )
            job.history.append(event)
            self.store.append_event(job.job_id, event)
            self.audit_logger.log(
                job_id=job.job_id,
                category="agent",
                action="decision_recorded",
                metadata=metadata,
            )

    @staticmethod
    def _count_state_transitions(job: JobRecord) -> int:
        if not job.history:
            return 0

        transitions = 0
        previous_state = job.history[0].state
        for event in job.history[1:]:
            if event.state != previous_state:
                transitions += 1
                previous_state = event.state
        return transitions

    @staticmethod
    def _request_hash(*, goal: str, repo: str, base_branch: str) -> str:
        payload = {"goal": goal, "repo": repo, "base_branch": base_branch}
        encoded = json.dumps(payload, ensure_ascii=True, sort_keys=True).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()
