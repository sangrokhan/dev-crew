from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from dev_crew.hooks.observability import EventLogger
from dev_crew.hooks.security import enforce_prompt_policy, mask_sensitive_text

from .models import CustomLLMConfig, LLMRequest, LLMResponse, OAuthProfile, OAuthToken, ProviderId
from .router import ProviderRouter
from .token_store import FileTokenStore


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
    ) -> None:
        self.config = config
        self.router = ProviderRouter(config)
        self.token_store = token_store
        self.logger = logger or EventLogger()

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

        max_attempts = self.config.llm_max_attempts
        backoff = self.config.llm_backoff_schedule_seconds

        attempt = 1
        while True:
            try:
                self.logger.on_llm_call(provider=provider.value, model=request.model, phase="start")
                output = provider_runner(
                    provider,
                    profile.token.access_token,
                    request.model,
                    safe_prompt,
                )
                safe_output = mask_sensitive_text(output)
                self.logger.on_llm_call(provider=provider.value, model=request.model, phase="success")
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
                if attempt >= max_attempts:
                    raise RuntimeError(
                        f"provider call failed after {max_attempts} attempts"
                    ) from exc
                sleep_seconds = backoff[min(attempt - 1, len(backoff) - 1)]
                time.sleep(sleep_seconds)
                attempt += 1

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
        )
        refreshed_profile = OAuthProfile(
            provider=provider,
            account_id=account_id,
            token=refreshed_token,
        )
        self.token_store.save_profile(refreshed_profile)
        self.logger.on_llm_call(provider=provider.value, model=model, phase="token_refreshed")
        return refreshed_profile
