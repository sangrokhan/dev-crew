import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from dev_crew.api.app import create_app
from dev_crew.llm.model_catalog import ModelCatalogService
from dev_crew.llm.models import OAuthProfile, OAuthToken, ProviderId
from dev_crew.llm.token_store import FileTokenStore


def _write_profiles(store: FileTokenStore) -> None:
    store.save_profile(
        OAuthProfile(
            provider=ProviderId.OPENAI_CODEX,
            account_id="default",
            token=OAuthToken(
                access_token="codex-token",
                refresh_token="codex-refresh",
                expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            ),
        )
    )
    store.save_profile(
        OAuthProfile(
            provider=ProviderId.GOOGLE_ANTIGRAVITY,
            account_id="default",
            token=OAuthToken(
                access_token="anti-token",
                refresh_token="anti-refresh",
                project_id="project-123",
                expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            ),
        )
    )


def test_model_catalog_refresh_with_mock_transport(tmp_path: Path) -> None:
    store = FileTokenStore(str(tmp_path / "oauth_tokens.json"))
    _write_profiles(store)

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/backend-api/codex/models":
            return httpx.Response(
                200,
                json={
                    "models": [
                        {"id": "codex-mini-latest", "context_window": 128000, "max_output_tokens": 4096},
                        {"id": "codex-pro-latest", "context_window": 256000, "max_output_tokens": 8192},
                    ]
                },
            )
        if path == "/backend-api/wham/usage":
            return httpx.Response(
                200,
                json={
                    "plan_type": "pro",
                    "rate_limit": {
                        "primary_window": {"limit_window_seconds": 10800, "used_percent": 12.5, "reset_at": 10},
                        "secondary_window": {
                            "limit_window_seconds": 86400,
                            "used_percent": 35.0,
                            "reset_at": 20,
                        },
                    },
                },
            )
        if path == "/v1internal:loadCodeAssist":
            return httpx.Response(
                200,
                json={
                    "availablePromptCredits": 70,
                    "planInfo": {"monthlyPromptCredits": 100},
                    "currentTier": {"name": "Gemini Code Assist Standard"},
                    "cloudaicompanionProject": "project-123",
                },
            )
        if path == "/v1internal:fetchAvailableModels":
            return httpx.Response(
                200,
                json={
                    "models": {
                        "gemini-2.5-pro": {
                            "displayName": "Gemini 2.5 Pro",
                            "quotaInfo": {"remainingFraction": 0.8, "resetTime": "2026-01-01T00:00:00Z"},
                        },
                        "gemini-2.5-flash": {
                            "displayName": "Gemini 2.5 Flash",
                            "quotaInfo": {"remainingFraction": 0.2, "resetTime": "2026-01-01T01:00:00Z"},
                        },
                    }
                },
            )
        return httpx.Response(404, json={"error": "not found"})

    transport = httpx.MockTransport(handler)

    async def run() -> tuple[int, int, str | None]:
        catalog = ModelCatalogService(
            token_store=store,
            auto_refresh=False,
            startup_refresh=False,
            transport=transport,
        )
        await catalog.refresh()
        providers, models = catalog.snapshot()
        codex_count = len([row for row in models if row.provider == ProviderId.OPENAI_CODEX])
        anti_count = len([row for row in models if row.provider == ProviderId.GOOGLE_ANTIGRAVITY])
        anti_pro = next(row for row in models if row.model_id == "gemini-2.5-pro")
        anti_flash = next(row for row in models if row.model_id == "gemini-2.5-flash")
        assert anti_pro.usage_hint == "reasoning"
        assert anti_flash.usage_hint == "fast"
        anti_provider = next(
            provider for provider in providers if provider.provider == ProviderId.GOOGLE_ANTIGRAVITY
        )
        assert anti_provider.usage is not None
        assert anti_provider.usage.plan == "Gemini Code Assist Standard"
        return codex_count, anti_count, anti_provider.last_error

    codex_count, anti_count, anti_error = asyncio.run(run())
    assert codex_count == 2
    assert anti_count == 2
    assert anti_error is None


def test_model_catalog_periodic_refresh_runs(tmp_path: Path) -> None:
    store = FileTokenStore(str(tmp_path / "oauth_tokens.json"))
    _write_profiles(store)
    call_counts = {"codex_models": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/backend-api/codex/models":
            call_counts["codex_models"] += 1
            return httpx.Response(200, json={"models": [{"id": "codex-mini-latest"}]})
        if path == "/backend-api/wham/usage":
            return httpx.Response(200, json={})
        if path == "/v1internal:loadCodeAssist":
            return httpx.Response(200, json={})
        if path == "/v1internal:fetchAvailableModels":
            return httpx.Response(200, json={"models": {}})
        return httpx.Response(404, json={"error": "not found"})

    transport = httpx.MockTransport(handler)

    async def run() -> int:
        catalog = ModelCatalogService(
            token_store=store,
            auto_refresh=True,
            startup_refresh=False,
            refresh_interval_seconds=1,
            transport=transport,
        )
        await catalog.start()
        await asyncio.sleep(1.2)
        await catalog.stop()
        return call_counts["codex_models"]

    assert asyncio.run(run()) >= 1


def test_llm_models_api_endpoints(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DEV_CREW_OAUTH_TOKEN_PATH", str(tmp_path / "oauth_tokens.json"))
    monkeypatch.setenv("DEV_CREW_MODEL_CATALOG_AUTO_REFRESH", "0")
    monkeypatch.setenv("DEV_CREW_MODEL_CATALOG_STARTUP_REFRESH", "0")

    app = create_app(str(tmp_path / "jobs.db"))
    with TestClient(app) as client:
        response = client.get("/llm/models")
        assert response.status_code == 200
        body = response.json()
        assert body["models"] == []
        assert len(body["providers"]) == 2

        refresh = client.post("/llm/models/refresh?provider=openai-codex")
        assert refresh.status_code == 200
        refresh_body = refresh.json()
        assert len(refresh_body["providers"]) == 1
        assert refresh_body["providers"][0]["provider"] == "openai-codex"
        assert "OAuth profile not found" in (refresh_body["providers"][0]["last_error"] or "")
