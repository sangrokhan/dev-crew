from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from dev_crew.models import JobEvent
from dev_crew.llm.models import ProviderId


class JobCreateRequest(BaseModel):
    goal: str
    repo: str
    base_branch: str = "main"


class JobCreateResponse(BaseModel):
    job_id: str
    state: str
    reused: bool = False


class JobStatusResponse(BaseModel):
    job_id: str
    goal: str
    repo: str
    base_branch: str
    work_branch: str
    state: str
    history_count: int = Field(default=0)
    last_event: JobEvent | None = None


class LLMModelResponse(BaseModel):
    provider: ProviderId
    model_id: str
    display_name: str | None = None
    usage_hint: str = "balanced"
    priority: int = 50
    context_window_tokens: int | None = None
    max_output_tokens: int | None = None
    quota_remaining_fraction: float | None = None
    quota_reset_at: datetime | None = None
    metadata: dict = Field(default_factory=dict)


class LLMUsageWindowResponse(BaseModel):
    label: str
    used_percent: float
    reset_at: datetime | None = None


class LLMUsageSummaryResponse(BaseModel):
    plan: str | None = None
    windows: list[LLMUsageWindowResponse] = Field(default_factory=list)


class LLMProviderCatalogResponse(BaseModel):
    provider: ProviderId
    account_id: str
    model_count: int
    last_refresh_at: datetime | None = None
    last_success_at: datetime | None = None
    next_refresh_at: datetime | None = None
    stale: bool = False
    last_error: str | None = None
    usage: LLMUsageSummaryResponse | None = None


class LLMModelsCatalogResponse(BaseModel):
    refresh_interval_seconds: int
    auto_refresh: bool
    providers: list[LLMProviderCatalogResponse]
    models: list[LLMModelResponse]


class LLMTrackedModelUsageResponse(BaseModel):
    provider: ProviderId
    model: str
    total_calls: int
    success_calls: int
    error_calls: int
    total_prompt_tokens: int
    total_completion_tokens: int
    total_tokens: int
    window_calls: int
    window_success_calls: int
    window_error_calls: int
    window_prompt_tokens: int
    window_completion_tokens: int
    window_total_tokens: int
    last_called_at: datetime | None = None


class LLMUsageSnapshotResponse(BaseModel):
    window_minutes: int
    generated_at: datetime
    model_count: int
    models: list[LLMTrackedModelUsageResponse]
