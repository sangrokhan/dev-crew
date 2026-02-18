from __future__ import annotations

from typing import Callable

from .models import JobRecord, JobState, PlanV1, ReportV1


class PlanApprovalRejectedError(RuntimeError):
    pass


class JobRunner:
    """Coordinates the phase-2 workflow with explicit state transitions."""

    def run(
        self,
        job: JobRecord,
        plan_factory: Callable[[JobRecord], PlanV1],
        build_executor: Callable[[JobRecord, PlanV1], ReportV1],
        approval_checker: Callable[[JobRecord, PlanV1], bool],
    ) -> ReportV1:
        job.transition_to(JobState.CONTEXT_COLLECTING, "Collecting repository context")

        job.transition_to(JobState.PLANNING, "Running fan-out agents and aggregating plan")
        plan = plan_factory(job)

        if plan.approvals.requires_plan_approval:
            job.transition_to(JobState.AWAITING_PLAN_APPROVAL, "Waiting for manual plan approval")
            if not approval_checker(job, plan):
                job.transition_to(JobState.FAILED, "Plan approval rejected")
                raise PlanApprovalRejectedError(f"Plan approval rejected for job {job.job_id}")

        job.transition_to(JobState.EXECUTING, "Executing build/test steps")
        report = self._execute_with_auto_fix(job, plan, build_executor)

        job.transition_to(JobState.REPORTING, "Generating final report")
        if report.failures:
            job.transition_to(
                JobState.FAILED,
                "Report contains unresolved failures",
                metadata={"failures": report.failures},
            )
        else:
            job.transition_to(JobState.COMPLETED, "Workflow completed successfully")
        return report

    def _execute_with_auto_fix(
        self,
        job: JobRecord,
        plan: PlanV1,
        build_executor: Callable[[JobRecord, PlanV1], ReportV1],
    ) -> ReportV1:
        max_rounds = job.retry_policy.auto_fix_max_rounds
        report = build_executor(job, plan)

        round_index = 1
        while report.failures and round_index < max_rounds:
            job.transition_to(
                JobState.AUTO_FIXING,
                "Build failed, starting auto-fix round",
                metadata={
                    "round": round_index,
                    "max_rounds": max_rounds,
                    "failures": report.failures,
                },
            )
            job.transition_to(
                JobState.EXECUTING,
                "Retrying build after auto-fix round",
                metadata={"next_round": round_index + 1},
            )
            report = build_executor(job, plan)
            round_index += 1

        return report
