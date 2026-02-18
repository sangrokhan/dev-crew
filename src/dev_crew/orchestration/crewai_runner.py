from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dev_crew.models import JobRecord


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
    ) -> None:
        self.workspace_root = str(Path(workspace_root).expanduser().resolve())
        self.enabled = enabled
        self.dry_run = dry_run
        self.llm = llm
        self.manager_llm = manager_llm
        self.verbose = verbose

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

        default_llm = OfflineEchoLLM()
        agent_llm: Any = self.llm if self.llm else default_llm
        manager_llm: Any = self.manager_llm if self.manager_llm else agent_llm
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
