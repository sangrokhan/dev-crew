from pathlib import Path

import pytest

from dev_crew.hooks.observability import EventLogger
from dev_crew.hooks.security import PolicyViolationError, enforce_prompt_policy, mask_sensitive_text
from dev_crew.llm.client import CustomLLMAdapter, RetryableProviderError
from dev_crew.llm.models import CustomLLMConfig, LLMRequest, OAuthProviderConfig, ProviderId
from dev_crew.llm.oauth_clone import OAuthCloneClient
from dev_crew.llm.router import ProviderRouter
from dev_crew.llm.token_store import FileTokenStore


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
