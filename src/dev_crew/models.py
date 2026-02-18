from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, model_validator


DEFAULT_AGENT_ROLES = [
    "leader",
    "architect",
    "frontend",
    "backend",
    "designer",
    "ci/cd engineer",
    "qa engineer",
    "security engineer",
]


class JobState(str, Enum):
    RECEIVED = "received"
    CONTEXT_COLLECTING = "context_collecting"
    PLANNING = "planning"
    AWAITING_PLAN_APPROVAL = "awaiting_plan_approval"
    EXECUTING = "executing"
    AUTO_FIXING = "auto_fixing"
    REPORTING = "reporting"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELED = "canceled"


ALLOWED_STATE_TRANSITIONS: dict[JobState, set[JobState]] = {
    JobState.RECEIVED: {
        JobState.CONTEXT_COLLECTING,
        JobState.CANCELED,
        JobState.FAILED,
    },
    JobState.CONTEXT_COLLECTING: {
        JobState.PLANNING,
        JobState.CANCELED,
        JobState.FAILED,
    },
    JobState.PLANNING: {
        JobState.AWAITING_PLAN_APPROVAL,
        JobState.EXECUTING,
        JobState.CANCELED,
        JobState.FAILED,
    },
    JobState.AWAITING_PLAN_APPROVAL: {
        JobState.EXECUTING,
        JobState.CANCELED,
        JobState.FAILED,
    },
    JobState.EXECUTING: {
        JobState.AUTO_FIXING,
        JobState.REPORTING,
        JobState.CANCELED,
        JobState.FAILED,
    },
    JobState.AUTO_FIXING: {
        JobState.EXECUTING,
        JobState.CANCELED,
        JobState.FAILED,
    },
    JobState.REPORTING: {
        JobState.COMPLETED,
        JobState.FAILED,
    },
    JobState.COMPLETED: set(),
    JobState.FAILED: set(),
    JobState.CANCELED: set(),
}


class RetryPolicy(BaseModel):
    llm_max_attempts: int = 5
    llm_backoff_schedule_seconds: list[int] = Field(default_factory=lambda: [1, 2, 4, 8, 16])
    llm_max_backoff_seconds: int = 32
    llm_timeout_seconds: int = 60
    llm_total_budget_seconds: int = 120
    auto_fix_max_rounds: int = 5

    @model_validator(mode="after")
    def validate_policy(self) -> "RetryPolicy":
        if self.llm_max_attempts < 1:
            raise ValueError("llm_max_attempts must be >= 1")
        if self.auto_fix_max_rounds < 1:
            raise ValueError("auto_fix_max_rounds must be >= 1")
        if not self.llm_backoff_schedule_seconds:
            raise ValueError("llm_backoff_schedule_seconds must not be empty")
        if any(v <= 0 for v in self.llm_backoff_schedule_seconds):
            raise ValueError("backoff values must be positive")
        if self.llm_max_backoff_seconds < max(self.llm_backoff_schedule_seconds):
            raise ValueError("llm_max_backoff_seconds must be >= max backoff schedule value")
        if self.llm_timeout_seconds <= 0 or self.llm_total_budget_seconds <= 0:
            raise ValueError("timeouts must be positive")
        if self.llm_total_budget_seconds < self.llm_timeout_seconds:
            raise ValueError("llm_total_budget_seconds must be >= llm_timeout_seconds")
        return self


class RateLimitPolicy(BaseModel):
    job_requests_per_minute: int = 30
    system_requests_per_minute: int = 120
    burst: int = 10

    @model_validator(mode="after")
    def validate_policy(self) -> "RateLimitPolicy":
        if self.job_requests_per_minute < 1:
            raise ValueError("job_requests_per_minute must be >= 1")
        if self.system_requests_per_minute < 1:
            raise ValueError("system_requests_per_minute must be >= 1")
        if self.burst < 1:
            raise ValueError("burst must be >= 1")
        return self


class AgentTask(BaseModel):
    id: str
    title: str
    owner_agent: str
    depends_on: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)


class PullRequestDraft(BaseModel):
    title: str
    body: str


class ApprovalPolicy(BaseModel):
    requires_plan_approval: bool = True


class PlanV1(BaseModel):
    tasks: list[AgentTask]
    files_to_change: list[str] = Field(default_factory=list)
    commands: list[str] = Field(default_factory=list)
    test_matrix: list[str] = Field(default_factory=list)
    pr: PullRequestDraft
    risks: list[str] = Field(default_factory=list)
    approvals: ApprovalPolicy = Field(default_factory=ApprovalPolicy)


class ReportV1(BaseModel):
    run_summary: str
    links: list[str] = Field(default_factory=list)
    failures: list[str] = Field(default_factory=list)
    next_actions: list[str] = Field(default_factory=list)


class JobEvent(BaseModel):
    at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    state: JobState
    message: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class JobRecord(BaseModel):
    job_id: str
    goal: str
    repo: str
    base_branch: str = "main"
    work_branch: str
    current_state: JobState = JobState.RECEIVED
    history: list[JobEvent] = Field(default_factory=list)
    retry_policy: RetryPolicy = Field(default_factory=RetryPolicy)
    rate_limit_policy: RateLimitPolicy = Field(default_factory=RateLimitPolicy)

    def transition_to(
        self,
        new_state: JobState,
        message: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        allowed = ALLOWED_STATE_TRANSITIONS[self.current_state]
        if new_state not in allowed:
            raise ValueError(
                f"Invalid transition: {self.current_state.value} -> {new_state.value}. "
                f"Allowed: {[state.value for state in sorted(allowed, key=lambda s: s.value)]}"
            )

        self.current_state = new_state
        self.history.append(
            JobEvent(state=new_state, message=message, metadata=metadata or {})
        )
