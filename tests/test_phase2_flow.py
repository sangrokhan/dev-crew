from dev_crew.flow import JobRunner, PlanApprovalRejectedError
from dev_crew.models import (
    AgentTask,
    ApprovalPolicy,
    JobRecord,
    JobState,
    PlanV1,
    PullRequestDraft,
    ReportV1,
    RetryPolicy,
)


def _sample_plan(require_approval: bool = True) -> PlanV1:
    return PlanV1(
        tasks=[
            AgentTask(
                id="T1",
                title="Implement feature",
                owner_agent="backend",
                acceptance_criteria=["tests pass"],
            )
        ],
        files_to_change=["src/dev_crew/flow.py"],
        commands=["pytest -q"],
        test_matrix=["unit"],
        pr=PullRequestDraft(title="feat: sample", body="sample body"),
        risks=["regression risk"],
        approvals=ApprovalPolicy(requires_plan_approval=require_approval),
    )


def test_state_transition_validation() -> None:
    job = JobRecord(
        job_id="job-1",
        goal="test",
        repo="org/repo",
        work_branch="crew/job-1",
    )

    job.transition_to(JobState.CONTEXT_COLLECTING, "context")
    job.transition_to(JobState.PLANNING, "planning")

    try:
        job.transition_to(JobState.COMPLETED, "invalid jump")
        assert False, "Expected ValueError"
    except ValueError:
        pass


def test_auto_fix_retries_until_success() -> None:
    attempts = {"count": 0}

    def plan_factory(_: JobRecord) -> PlanV1:
        return _sample_plan(require_approval=False)

    def build_executor(_: JobRecord, __: PlanV1) -> ReportV1:
        attempts["count"] += 1
        if attempts["count"] < 5:
            return ReportV1(run_summary="failed", failures=["test failure"])
        return ReportV1(run_summary="ok")

    def approval_checker(_: JobRecord, __: PlanV1) -> bool:
        return True

    job = JobRecord(
        job_id="job-2",
        goal="test autofix",
        repo="org/repo",
        work_branch="crew/job-2",
        retry_policy=RetryPolicy(auto_fix_max_rounds=5),
    )

    report = JobRunner().run(job, plan_factory, build_executor, approval_checker)

    assert report.failures == []
    assert attempts["count"] == 5
    assert job.current_state == JobState.COMPLETED
    auto_fix_events = [e for e in job.history if e.state == JobState.AUTO_FIXING]
    assert len(auto_fix_events) == 4


def test_plan_approval_rejection_sets_failed_state() -> None:
    def plan_factory(_: JobRecord) -> PlanV1:
        return _sample_plan(require_approval=True)

    def build_executor(_: JobRecord, __: PlanV1) -> ReportV1:
        return ReportV1(run_summary="should not run")

    def approval_checker(_: JobRecord, __: PlanV1) -> bool:
        return False

    job = JobRecord(
        job_id="job-3",
        goal="approval",
        repo="org/repo",
        work_branch="crew/job-3",
    )

    try:
        JobRunner().run(job, plan_factory, build_executor, approval_checker)
        assert False, "Expected PlanApprovalRejectedError"
    except PlanApprovalRejectedError:
        pass

    assert job.current_state == JobState.FAILED
