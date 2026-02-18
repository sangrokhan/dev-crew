from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from dev_crew.hooks.observability import EventLogger
from dev_crew.hooks.security import enforce_prompt_policy, mask_sensitive_text

from .models import CustomLLMConfig, LLMRequest, LLMResponse, OAuthProfile, OAuthToken, ProviderId
from .router import ProviderRouter
from .token_store import FileTokenStore
from .usage_tracker import LLMUsageTracker


class RetryableProviderError(RuntimeError):
    pass


class MissingAuthProfileError(RuntimeError):
    pass


class CustomLLMAdapter:
    """
    Custom LLM adapter built in cloned-flow mode.
    OAuth auth/profile lifecycle is separated in OAuthCloneClient.
    """

    def __init__(
        self,
        *,
        config: CustomLLMConfig,
        token_store: FileTokenStore,
        logger: EventLogger | None = None,
        usage_tracker: LLMUsageTracker | None = None,
    ) -> None:
        self.config = config
        self.router = ProviderRouter(config)
        self.token_store = token_store
        self.logger = logger or EventLogger()
        self.usage_tracker = usage_tracker

    def invoke(
        self,
        request: LLMRequest,
        provider_runner: Callable[[ProviderId, str, str, str], str],
        account_id: str = "default",
        token_refresher: Callable[[ProviderId, str, str], dict[str, Any]] | None = None,
    ) -> LLMResponse:
        provider = self.router.resolve_provider(request)
        profile = self.token_store.load_profile(provider, account_id=account_id)
        if not profile:
            raise MissingAuthProfileError(
                f"OAuth profile not found for provider={provider.value}, account_id={account_id}"
            )
        profile = self._refresh_expired_profile(
            provider=provider,
            model=request.model,
            account_id=account_id,
            profile=profile,
            token_refresher=token_refresher,
        )

        safe_prompt = mask_sensitive_text(request.prompt)
        enforce_prompt_policy(safe_prompt)
        prompt_tokens = self._resolve_prompt_tokens(request=request, safe_prompt=safe_prompt)

        max_attempts = self.config.llm_max_attempts
        backoff = self.config.llm_backoff_schedule_seconds

        attempt = 1
        while True:
            try:
                self.logger.on_llm_call(provider=provider.value, model=request.model, phase="start")
                provider_api_key = self._build_provider_api_key(provider=provider, token=profile.token)
                output = provider_runner(
                    provider,
                    provider_api_key,
                    request.model,
                    safe_prompt,
                )
                safe_output = mask_sensitive_text(output)
                self.logger.on_llm_call(provider=provider.value, model=request.model, phase="success")
                self._record_usage(
                    provider=provider,
                    model=request.model,
                    prompt=safe_prompt,
                    output=safe_output,
                    success=True,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=None,
                )
                return LLMResponse(
                    provider=provider,
                    model=request.model,
                    output=safe_output,
                    metadata={"attempt": attempt},
                )
            except RetryableProviderError as exc:
                self.logger.on_llm_call(
                    provider=provider.value,
                    model=request.model,
                    phase="retryable_error",
                )
                self._record_usage(
                    provider=provider,
                    model=request.model,
                    prompt=safe_prompt,
                    output="",
                    success=False,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=0,
                )
                if attempt >= max_attempts:
                    raise RuntimeError(
                        f"provider call failed after {max_attempts} attempts"
                    ) from exc
                sleep_seconds = backoff[min(attempt - 1, len(backoff) - 1)]
                time.sleep(sleep_seconds)
                attempt += 1
            except Exception:
                self._record_usage(
                    provider=provider,
                    model=request.model,
                    prompt=safe_prompt,
                    output="",
                    success=False,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=0,
                )
                raise

    def _refresh_expired_profile(
        self,
        *,
        provider: ProviderId,
        model: str,
        account_id: str,
        profile: OAuthProfile,
        token_refresher: Callable[[ProviderId, str, str], dict[str, Any]] | None,
    ) -> OAuthProfile:
        leeway = timedelta(seconds=self.config.oauth_refresh_leeway_seconds)
        refresh_deadline = datetime.now(timezone.utc) + leeway
        if profile.token.expires_at > refresh_deadline:
            return profile

        refresh_token = profile.token.refresh_token
        if not refresh_token:
            raise MissingAuthProfileError(
                f"OAuth token expired or expiring soon and no refresh token for "
                f"provider={provider.value}, account_id={account_id}"
            )
        if token_refresher is None:
            raise MissingAuthProfileError(
                f"OAuth token expired or expiring soon for provider={provider.value}, "
                f"account_id={account_id}; token_refresher callback is required"
            )

        payload = token_refresher(provider, account_id, refresh_token)
        refreshed_token = OAuthToken.from_token_response(
            payload,
            previous_refresh_token=refresh_token,
            previous_project_id=profile.token.project_id,
        )
        refreshed_profile = OAuthProfile(
            provider=provider,
            account_id=account_id,
            token=refreshed_token,
        )
        self.token_store.save_profile(refreshed_profile)
        self.logger.on_llm_call(provider=provider.value, model=model, phase="token_refreshed")
        return refreshed_profile

    @staticmethod
    def _build_provider_api_key(*, provider: ProviderId, token: OAuthToken) -> str:
        # openclaw parity:
        # - openai-codex: raw bearer token
        # - google-antigravity: token JSON (token + optional projectId)
        if provider == ProviderId.GOOGLE_ANTIGRAVITY:
            payload: dict[str, str] = {"token": token.access_token}
            if token.project_id:
                payload["projectId"] = token.project_id
            return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
        return token.access_token

    def _record_usage(
        self,
        *,
        provider: ProviderId,
        model: str,
        prompt: str,
        output: str,
        success: bool,
        prompt_tokens: int | None,
        completion_tokens: int | None,
    ) -> None:
        if not self.usage_tracker:
            return
        self.usage_tracker.record_call(
            provider=provider,
            model=model,
            prompt=prompt,
            output=output,
            success=success,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )

    @staticmethod
    def _resolve_prompt_tokens(*, request: LLMRequest, safe_prompt: str) -> int | None:
        metadata = request.metadata if isinstance(request.metadata, dict) else {}
        token_usage = metadata.get("token_usage")
        if isinstance(token_usage, dict):
            prompt_tokens = token_usage.get("prompt_tokens")
            if isinstance(prompt_tokens, int):
                return max(0, prompt_tokens)
        prompt_tokens = metadata.get("prompt_tokens")
        if isinstance(prompt_tokens, int):
            return max(0, prompt_tokens)
        if metadata.get("disable_usage_estimation") is True:
            return None
        stripped = safe_prompt.strip()
        if not stripped:
            return 0
        return max(1, (len(stripped) + 3) // 4)
