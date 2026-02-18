from __future__ import annotations

from pydantic import BaseModel, Field

from dev_crew.models import JobEvent


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
