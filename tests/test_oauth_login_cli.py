from __future__ import annotations

import dev_crew.cli.oauth_login as oauth_login
from dev_crew.cli.oauth_login import (
    _exchange_authorization_code,
    _extract_client_id_from_input,
    _parse_manual_callback_input,
    _provider_config_from_env,
    _provider_env_prefix,
)
from dev_crew.llm.models import OAuthProviderConfig, ProviderId
from dev_crew.llm.oauth_clone import OAuthCloneClient
from dev_crew.llm.token_store import FileTokenStore


def test_provider_config_from_env_loads_values() -> None:
    prefix = _provider_env_prefix(ProviderId.OPENAI_CODEX)
    env = {
        f"{prefix}AUTHORIZE_URL": "https://auth.example.com/openai/authorize",
        f"{prefix}TOKEN_URL": "https://auth.example.com/openai/token",
        f"{prefix}CLIENT_ID": "client-openai",
        f"{prefix}CLIENT_SECRET": "secret-openai",
        f"{prefix}SCOPES": "openid,profile email",
    }

    config, client_secret = _provider_config_from_env(
        ProviderId.OPENAI_CODEX,
        redirect_uri="http://127.0.0.1:1455/callback",
        environ=env,
    )

    assert config.provider == ProviderId.OPENAI_CODEX
    assert config.authorize_url == "https://auth.example.com/openai/authorize"
    assert config.token_url == "https://auth.example.com/openai/token"
    assert config.client_id == "client-openai"
    assert config.scopes == ["openid", "profile", "email"]
    assert config.redirect_uri == "http://127.0.0.1:1455/callback"
    assert config.authorize_params == {
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "Codex Desktop",
    }
    assert client_secret == "secret-openai"


def test_provider_config_from_env_uses_openclaw_defaults_for_antigravity() -> None:
    config, client_secret = _provider_config_from_env(ProviderId.GOOGLE_ANTIGRAVITY, environ={})

    assert config.authorize_url == "https://accounts.google.com/o/oauth2/v2/auth"
    assert config.token_url == "https://oauth2.googleapis.com/token"
    assert (
        config.client_id
        == "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
    )
    assert config.redirect_uri == "http://localhost:51121/oauth-callback"
    assert "https://www.googleapis.com/auth/cloud-platform" in config.scopes
    assert client_secret == "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"


def test_provider_config_from_env_uses_openclaw_defaults_for_openai_urls() -> None:
    config, client_secret = _provider_config_from_env(
        ProviderId.OPENAI_CODEX,
        environ={},
    )

    assert config.authorize_url == "https://auth.openai.com/oauth/authorize"
    assert config.token_url == "https://auth.openai.com/oauth/token"
    assert config.redirect_uri == "http://localhost:1455/auth/callback"
    assert config.client_id == "app_EMoamEEZ73f0CkXaXp7hrann"
    assert config.scopes == ["openid", "profile", "email", "offline_access"]
    assert config.authorize_params == {
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "Codex Desktop",
    }
    assert client_secret is None


def test_provider_config_from_env_requires_mandatory_keys_without_defaults(monkeypatch) -> None:
    prefix = _provider_env_prefix(ProviderId.OPENAI_CODEX)
    env = {
        f"{prefix}TOKEN_URL": "https://auth.example.com/openai/token",
    }
    monkeypatch.setattr(oauth_login, "OPENCLAW_PROVIDER_DEFAULTS", {})

    try:
        _provider_config_from_env(ProviderId.OPENAI_CODEX, environ=env)
    except ValueError as exc:
        assert f"{prefix}CLIENT_ID" in str(exc)
    else:
        raise AssertionError("expected ValueError for missing CLIENT_ID")


def test_exchange_authorization_code_posts_expected_payload(
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeResponse:
        status_code = 200
        text = '{"access_token":"access"}'

        @staticmethod
        def json() -> dict[str, object]:
            return {
                "access_token": "access-token-123",
                "refresh_token": "refresh-token-123",
                "expires_in": 3600,
            }

    def fake_post(url: str, *, data: dict[str, str], headers: dict[str, str], timeout: float):
        captured["url"] = url
        captured["data"] = data
        captured["headers"] = headers
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("dev_crew.cli.oauth_login.httpx.post", fake_post)

    config = OAuthProviderConfig(
        provider=ProviderId.OPENAI_CODEX,
        authorize_url="https://auth.example.com/openai/authorize",
        token_url="https://auth.example.com/openai/token",
        client_id="openai-client",
        scopes=["openid"],
        redirect_uri="http://127.0.0.1:1455/callback",
    )
    payload = _exchange_authorization_code(
        provider_config=config,
        code="code-123",
        code_verifier="verifier-abc",
        client_secret="client-secret-xyz",
        timeout_seconds=10.0,
    )

    assert payload["access_token"] == "access-token-123"
    assert captured["url"] == "https://auth.example.com/openai/token"
    assert captured["data"] == {
        "grant_type": "authorization_code",
        "code": "code-123",
        "client_id": "openai-client",
        "redirect_uri": "http://127.0.0.1:1455/callback",
        "code_verifier": "verifier-abc",
        "client_secret": "client-secret-xyz",
    }
    assert captured["headers"] == {"Accept": "application/json"}
    assert captured["timeout"] == 10.0


def test_parse_manual_callback_input_accepts_raw_code() -> None:
    code, state = _parse_manual_callback_input("code-123", "state-abc")
    assert code == "code-123"
    assert state == "state-abc"


def test_parse_manual_callback_input_accepts_redirect_url() -> None:
    code, state = _parse_manual_callback_input(
        "http://127.0.0.1:1455/callback?code=code-123&state=state-abc",
        "state-abc",
    )
    assert code == "code-123"
    assert state == "state-abc"


def test_parse_manual_callback_input_rejects_missing_state() -> None:
    try:
        _parse_manual_callback_input("http://127.0.0.1:1455/callback?code=code-123", "state-abc")
    except RuntimeError as exc:
        assert "missing state" in str(exc)
    else:
        raise AssertionError("expected RuntimeError for missing state")


def test_extract_client_id_from_raw_value() -> None:
    value = _extract_client_id_from_input("client-id-123")
    assert value == "client-id-123"


def test_extract_client_id_from_authorize_url() -> None:
    value = _extract_client_id_from_input(
        "https://auth.openai.com/oauth/authorize?client_id=cid_abc&response_type=code"
    )
    assert value == "cid_abc"


def test_start_login_includes_authorize_extra_params(tmp_path) -> None:
    config, _ = _provider_config_from_env(
        ProviderId.OPENAI_CODEX,
        environ={},
    )
    store = FileTokenStore(
        str(tmp_path / "oauth_tokens.json"),
        workspace_root=str(tmp_path),
        allow_workspace_path=True,
    )
    oauth = OAuthCloneClient({ProviderId.OPENAI_CODEX: config}, store)
    start = oauth.start_login(ProviderId.OPENAI_CODEX)
    assert "id_token_add_organizations=true" in start.authorization_url
    assert "codex_cli_simplified_flow=true" in start.authorization_url
