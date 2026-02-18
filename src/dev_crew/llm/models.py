from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, model_validator


class ProviderId(str, Enum):
    OPENAI_CODEX = "openai-codex"
    GOOGLE_ANTIGRAVITY = "google-antigravity"


class OAuthProviderConfig(BaseModel):
    provider: ProviderId
    authorize_url: str
    token_url: str
    client_id: str
    scopes: list[str] = Field(default_factory=list)
    redirect_uri: str = "http://127.0.0.1:1455/callback"


class OAuthToken(BaseModel):
    access_token: str
    refresh_token: str | None = None
    token_type: str = "Bearer"
    expires_at: datetime
    scope: str | None = None

    @property
    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) >= self.expires_at

    @classmethod
    def from_token_response(
        cls,
        payload: dict[str, Any],
        *,
        previous_refresh_token: str | None = None,
    ) -> "OAuthToken":
        expires_in = int(payload.get("expires_in", 3600))
        return cls(
            access_token=payload["access_token"],
            refresh_token=payload.get("refresh_token", previous_refresh_token),
            token_type=payload.get("token_type", "Bearer"),
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=expires_in),
            scope=payload.get("scope"),
        )


class OAuthProfile(BaseModel):
    provider: ProviderId
    account_id: str = "default"
    token: OAuthToken


class LLMRequest(BaseModel):
    model: str
    prompt: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    preferred_provider: ProviderId | None = None


class LLMResponse(BaseModel):
    provider: ProviderId
    model: str
    output: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class CustomLLMConfig(BaseModel):
    default_provider: ProviderId = ProviderId.OPENAI_CODEX
    model_routes: dict[str, ProviderId] = Field(
        default_factory=lambda: {
            "codex": ProviderId.OPENAI_CODEX,
            "gpt": ProviderId.OPENAI_CODEX,
            "antigravity": ProviderId.GOOGLE_ANTIGRAVITY,
            "gemini": ProviderId.GOOGLE_ANTIGRAVITY,
        }
    )
    llm_max_attempts: int = 5
    llm_backoff_schedule_seconds: list[int] = Field(default_factory=lambda: [1, 2, 4, 8, 16])
    oauth_refresh_leeway_seconds: int = 300

    @model_validator(mode="after")
    def validate_retry_config(self) -> "CustomLLMConfig":
        if self.llm_max_attempts < 1:
            raise ValueError("llm_max_attempts must be >= 1")
        if not self.llm_backoff_schedule_seconds:
            raise ValueError("llm_backoff_schedule_seconds must not be empty")
        if any(v <= 0 for v in self.llm_backoff_schedule_seconds):
            raise ValueError("llm_backoff_schedule_seconds must be positive")
        if self.oauth_refresh_leeway_seconds < 0:
            raise ValueError("oauth_refresh_leeway_seconds must be >= 0")
        return self


@dataclass
class OAuthStart:
    provider: ProviderId
    state: str
    code_verifier: str
    code_challenge: str
    authorization_url: str
