import json
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from dev_crew.hooks.observability import EventLogger
from dev_crew.hooks.security import PolicyViolationError, enforce_prompt_policy, mask_sensitive_text
from dev_crew.llm.client import CustomLLMAdapter, RetryableProviderError
from dev_crew.llm.models import (
    CustomLLMConfig,
    LLMRequest,
    OAuthProfile,
    OAuthProviderConfig,
    OAuthToken,
    ProviderId,
)
from dev_crew.llm.oauth_clone import OAuthCloneClient
from dev_crew.llm.provider_auth import build_provider_auth_headers, parse_google_antigravity_api_key
from dev_crew.llm.router import ProviderRouter
from dev_crew.llm.token_store import FileTokenStore
from dev_crew.llm.usage_tracker import LLMUsageTracker


def _provider_configs() -> dict[ProviderId, OAuthProviderConfig]:
    return {
        ProviderId.OPENAI_CODEX: OAuthProviderConfig(
            provider=ProviderId.OPENAI_CODEX,
            authorize_url="https://auth.example.com/openai/authorize",
            token_url="https://auth.example.com/openai/token",
            client_id="openai-client",
            scopes=["openid", "profile"],
        ),
        ProviderId.GOOGLE_ANTIGRAVITY: OAuthProviderConfig(
            provider=ProviderId.GOOGLE_ANTIGRAVITY,
            authorize_url="https://auth.example.com/google/authorize",
            token_url="https://auth.example.com/google/token",
            client_id="google-client",
            scopes=["openid", "email"],
        ),
    }


def test_oauth_clone_start_and_complete(tmp_path: Path) -> None:
    store = FileTokenStore(str(tmp_path / "auth-profiles.json"))
    oauth = OAuthCloneClient(_provider_configs(), store)

    start = oauth.start_login(ProviderId.OPENAI_CODEX)
    assert start.code_verifier
    assert start.code_challenge
    assert "code_challenge=" in start.authorization_url

    profile = oauth.complete_login(
        state=start.state,
        auth_code="sample-code",
        token_exchange=lambda **_: {
            "access_token": "access-token-123",
            "refresh_token": "refresh-token-123",
            "expires_in": 3600,
        },
    )

    assert profile.provider == ProviderId.OPENAI_CODEX
    loaded = store.load_profile(ProviderId.OPENAI_CODEX)
    assert loaded is not None
    assert loaded.token.access_token == "access-token-123"


def test_oauth_clone_pending_session_survives_restart(tmp_path: Path) -> None:
    profile_path = tmp_path / "auth-profiles.json"
    pending_path = tmp_path / "oauth-pending.json"

    store1 = FileTokenStore(str(profile_path))
    oauth1 = OAuthCloneClient(_provider_configs(), store1, pending_store_path=str(pending_path))
    start = oauth1.start_login(ProviderId.OPENAI_CODEX)

    store2 = FileTokenStore(str(profile_path))
    oauth2 = OAuthCloneClient(_provider_configs(), store2, pending_store_path=str(pending_path))
    profile = oauth2.complete_login(
        state=start.state,
        auth_code="sample-code",
        token_exchange=lambda **_: {
            "access_token": "access-token-after-restart",
            "refresh_token": "refresh-token-after-restart",
            "expires_in": 3600,
        },
    )

    assert profile.token.access_token == "access-token-after-restart"


def test_oauth_clone_refresh_access_token(tmp_path: Path) -> None:
    store = FileTokenStore(str(tmp_path / "auth-profiles.json"))
    oauth = OAuthCloneClient(_provider_configs(), store)
    start = oauth.start_login(ProviderId.OPENAI_CODEX)
    oauth.complete_login(
        state=start.state,
        auth_code="sample-code",
        token_exchange=lambda **_: {
            "access_token": "access-token-123",
            "refresh_token": "refresh-token-123",
            "expires_in": 3600,
        },
    )

    refreshed = oauth.refresh_access_token(
        provider=ProviderId.OPENAI_CODEX,
        token_refresh=lambda **_: {
            "access_token": "access-token-new",
            # Keep old refresh token if provider does not rotate it.
            "expires_in": 3600,
        },
    )

    assert refreshed.token.access_token == "access-token-new"
    assert refreshed.token.refresh_token == "refresh-token-123"


def test_token_store_rejects_workspace_path(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        FileTokenStore(str(tmp_path / "oauth.json"), workspace_root=str(tmp_path))


def test_token_store_writes_private_permissions(tmp_path: Path) -> None:
    if os.name == "nt":
        pytest.skip("permission bits assertion is posix-only")

    store = FileTokenStore(
        str(tmp_path / "secure" / "auth-profiles.json"),
        workspace_root=str(tmp_path),
        allow_workspace_path=True,
    )
    store.save_profile(
        OAuthProfile(
            provider=ProviderId.OPENAI_CODEX,
            token=OAuthToken(
                access_token="access-token-123",
                refresh_token="refresh-token-123",
                expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            ),
        )
    )

    file_mode = stat.S_IMODE(store.path.stat().st_mode)
    dir_mode = stat.S_IMODE(store.path.parent.stat().st_mode)
    assert file_mode == 0o600
    assert dir_mode == 0o700


def test_router_prefers_model_prefix() -> None:
    router = ProviderRouter(CustomLLMConfig())

    codex_provider = router.resolve_provider(LLMRequest(model="codex-mini", prompt="hi"))
    anti_provider = router.resolve_provider(LLMRequest(model="antigravity-fast", prompt="hi"))

    assert codex_provider == ProviderId.OPENAI_CODEX
    assert anti_provider == ProviderId.GOOGLE_ANTIGRAVITY


def test_security_mask_and_policy_block() -> None:
    text = "token sk-abcdefghijklmnopqrstuvwx and mail a@b.com"
    masked = mask_sensitive_text(text)
    assert "[REDACTED]" in masked
    with pytest.raises(PolicyViolationError):
        enforce_prompt_policy("please run git reset --hard")


def test_custom_llm_adapter_retry_and_logging(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("dev_crew.llm.client.time.sleep", lambda _: None)

    store = FileTokenStore(str(tmp_path / "auth-profiles.json"))
    oauth = OAuthCloneClient(_provider_configs(), store)
    start = oauth.start_login(ProviderId.OPENAI_CODEX)
    oauth.complete_login(
        state=start.state,
        auth_code="sample-code",
        token_exchange=lambda **_: {
            "access_token": "access-token-xyz",
            "expires_in": 3600,
        },
    )

    logger = EventLogger()
    adapter = CustomLLMAdapter(config=CustomLLMConfig(), token_store=store, logger=logger)

    attempts = {"count": 0}

    def provider_runner(provider: ProviderId, token: str, model: str, prompt: str) -> str:
        attempts["count"] += 1
        assert provider == ProviderId.OPENAI_CODEX
        assert token == "access-token-xyz"
        assert model == "codex-mini"
        if attempts["count"] < 3:
            raise RetryableProviderError("temporary failure")
        return f"ok: {prompt}"

    response = adapter.invoke(
        LLMRequest(model="codex-mini", prompt="hello sk-abcdefghijklmnopqrstuvwx"),
        provider_runner,
    )

    assert attempts["count"] == 3
    assert response.provider == ProviderId.OPENAI_CODEX
    assert "[REDACTED]" in response.output
    assert len(logger.list_events()) >= 4


def test_custom_llm_adapter_refreshes_expired_token(tmp_path: Path) -> None:
    store = FileTokenStore(str(tmp_path / "auth-profiles.json"))
    store.save_profile(
        OAuthProfile(
            provider=ProviderId.OPENAI_CODEX,
            token=OAuthToken(
                access_token="expired-token",
                refresh_token="refresh-token-123",
                expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
            ),
        )
    )

    adapter = CustomLLMAdapter(config=CustomLLMConfig(), token_store=store, logger=EventLogger())

    def provider_runner(provider: ProviderId, token: str, model: str, prompt: str) -> str:
        assert provider == ProviderId.OPENAI_CODEX
        assert token == "new-access-token"
        assert model == "codex-mini"
        return f"ok: {prompt}"

    response = adapter.invoke(
        LLMRequest(model="codex-mini", prompt="hello"),
        provider_runner,
        token_refresher=lambda provider, account_id, refresh_token: {
            "access_token": "new-access-token",
            "expires_in": 3600,
        },
    )
    assert response.provider == ProviderId.OPENAI_CODEX

    loaded = store.load_profile(ProviderId.OPENAI_CODEX)
    assert loaded is not None
    assert loaded.token.access_token == "new-access-token"
    assert loaded.token.refresh_token == "refresh-token-123"


def test_custom_llm_adapter_refreshes_before_expiry(tmp_path: Path) -> None:
    store = FileTokenStore(str(tmp_path / "auth-profiles.json"))
    store.save_profile(
        OAuthProfile(
            provider=ProviderId.OPENAI_CODEX,
            token=OAuthToken(
                access_token="almost-expired-token",
                refresh_token="refresh-token-123",
                expires_at=datetime.now(timezone.utc) + timedelta(seconds=30),
            ),
        )
    )

    adapter = CustomLLMAdapter(config=CustomLLMConfig(), token_store=store, logger=EventLogger())
    refresh_calls = {"count": 0}

    def provider_runner(provider: ProviderId, token: str, model: str, prompt: str) -> str:
        assert provider == ProviderId.OPENAI_CODEX
        assert token == "proactive-new-token"
        assert model == "codex-mini"
        return f"ok: {prompt}"

    def token_refresher(provider: ProviderId, account_id: str, refresh_token: str) -> dict:
        del provider, account_id, refresh_token
        refresh_calls["count"] += 1
        return {"access_token": "proactive-new-token", "expires_in": 3600}

    response = adapter.invoke(
        LLMRequest(model="codex-mini", prompt="hello"),
        provider_runner,
        token_refresher=token_refresher,
    )
    assert response.provider == ProviderId.OPENAI_CODEX
    assert refresh_calls["count"] == 1


def test_custom_llm_adapter_skips_refresh_when_not_near_expiry(tmp_path: Path) -> None:
    store = FileTokenStore(str(tmp_path / "auth-profiles.json"))
    store.save_profile(
        OAuthProfile(
            provider=ProviderId.OPENAI_CODEX,
            token=OAuthToken(
                access_token="healthy-token",
                refresh_token="refresh-token-123",
                expires_at=datetime.now(timezone.utc) + timedelta(hours=2),
            ),
        )
    )

    adapter = CustomLLMAdapter(config=CustomLLMConfig(), token_store=store, logger=EventLogger())
    refresh_calls = {"count": 0}

    def provider_runner(provider: ProviderId, token: str, model: str, prompt: str) -> str:
        assert provider == ProviderId.OPENAI_CODEX
        assert token == "healthy-token"
        assert model == "codex-mini"
        return f"ok: {prompt}"

    def token_refresher(provider: ProviderId, account_id: str, refresh_token: str) -> dict:
        del provider, account_id, refresh_token
        refresh_calls["count"] += 1
        return {"access_token": "should-not-be-used", "expires_in": 3600}

    response = adapter.invoke(
        LLMRequest(model="codex-mini", prompt="hello"),
        provider_runner,
        token_refresher=token_refresher,
    )
    assert response.provider == ProviderId.OPENAI_CODEX
    assert refresh_calls["count"] == 0


def test_custom_llm_adapter_uses_antigravity_token_json_payload(tmp_path: Path) -> None:
    store = FileTokenStore(str(tmp_path / "auth-profiles.json"))
    store.save_profile(
        OAuthProfile(
            provider=ProviderId.GOOGLE_ANTIGRAVITY,
            token=OAuthToken(
                access_token="anti-token",
                refresh_token="anti-refresh",
                expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
                project_id="sample-project",
            ),
        )
    )

    adapter = CustomLLMAdapter(config=CustomLLMConfig(), token_store=store, logger=EventLogger())

    def provider_runner(provider: ProviderId, token: str, model: str, prompt: str) -> str:
        assert provider == ProviderId.GOOGLE_ANTIGRAVITY
        assert model == "antigravity-fast"
        parsed = json.loads(token)
        assert parsed == {"token": "anti-token", "projectId": "sample-project"}
        return f"ok: {prompt}"

    response = adapter.invoke(
        LLMRequest(model="antigravity-fast", prompt="hello"),
        provider_runner,
    )
    assert response.provider == ProviderId.GOOGLE_ANTIGRAVITY


def test_oauth_refresh_keeps_existing_project_id_when_missing_from_payload(tmp_path: Path) -> None:
    store = FileTokenStore(str(tmp_path / "auth-profiles.json"))
    store.save_profile(
        OAuthProfile(
            provider=ProviderId.GOOGLE_ANTIGRAVITY,
            token=OAuthToken(
                access_token="old-token",
                refresh_token="anti-refresh",
                expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
                project_id="project-1",
            ),
        )
    )

    adapter = CustomLLMAdapter(config=CustomLLMConfig(), token_store=store, logger=EventLogger())

    def provider_runner(provider: ProviderId, token: str, model: str, prompt: str) -> str:
        del provider, model, prompt
        parsed = json.loads(token)
        assert parsed == {"token": "new-token", "projectId": "project-1"}
        return "ok"

    adapter.invoke(
        LLMRequest(model="antigravity-fast", prompt="hello"),
        provider_runner,
        token_refresher=lambda provider, account_id, refresh_token: {
            "access_token": "new-token",
            "expires_in": 3600,
        },
    )


def test_provider_auth_headers_for_codex_include_optional_account_id() -> None:
    headers = build_provider_auth_headers(
        provider=ProviderId.OPENAI_CODEX,
        api_key="codex-token",
        account_id="acct-1",
    )
    assert headers["Authorization"] == "Bearer codex-token"
    assert headers["ChatGPT-Account-Id"] == "acct-1"


def test_provider_auth_headers_for_antigravity_accept_json_token_payload() -> None:
    token, project_id = parse_google_antigravity_api_key(
        '{"token":"anti-token","projectId":"project-77"}'
    )
    assert token == "anti-token"
    assert project_id == "project-77"

    headers = build_provider_auth_headers(
        provider=ProviderId.GOOGLE_ANTIGRAVITY,
        api_key='{"token":"anti-token","projectId":"project-77"}',
    )
    assert headers["Authorization"] == "Bearer anti-token"


def test_custom_llm_adapter_records_usage_tracker_stats(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("dev_crew.llm.client.time.sleep", lambda _: None)

    store = FileTokenStore(str(tmp_path / "auth-profiles.json"))
    oauth = OAuthCloneClient(_provider_configs(), store)
    start = oauth.start_login(ProviderId.OPENAI_CODEX)
    oauth.complete_login(
        state=start.state,
        auth_code="sample-code",
        token_exchange=lambda **_: {
            "access_token": "access-token-usage",
            "expires_in": 3600,
        },
    )

    tracker = LLMUsageTracker(window_minutes=60)
    adapter = CustomLLMAdapter(
        config=CustomLLMConfig(),
        token_store=store,
        logger=EventLogger(),
        usage_tracker=tracker,
    )

    attempts = {"count": 0}

    def provider_runner(provider: ProviderId, token: str, model: str, prompt: str) -> str:
        del provider, token, model, prompt
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RetryableProviderError("retry once")
        return "ok-output"

    adapter.invoke(
        LLMRequest(
            model="codex-mini",
            prompt="hello usage",
            metadata={"prompt_tokens": 11},
        ),
        provider_runner,
    )

    snapshot = tracker.snapshot(provider=ProviderId.OPENAI_CODEX, model="codex-mini")
    assert snapshot["model_count"] == 1
    row = snapshot["models"][0]
    assert row["total_calls"] == 2
    assert row["success_calls"] == 1
    assert row["error_calls"] == 1
    assert row["total_prompt_tokens"] == 22
    assert row["window_calls"] == 2
