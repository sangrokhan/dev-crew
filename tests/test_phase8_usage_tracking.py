from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from dev_crew.api.app import create_app
from dev_crew.llm.models import ProviderId
from dev_crew.llm.usage_tracker import LLMUsageTracker


def test_usage_tracker_prunes_outdated_window_events() -> None:
    tracker = LLMUsageTracker(window_minutes=10)
    now = datetime(2026, 2, 18, 12, 0, tzinfo=timezone.utc)

    tracker.record_call(
        provider=ProviderId.OPENAI_CODEX,
        model="codex-mini",
        prompt="old-call",
        output="ok",
        success=True,
        timestamp=now - timedelta(minutes=30),
        prompt_tokens=10,
        completion_tokens=2,
    )
    tracker.record_call(
        provider=ProviderId.OPENAI_CODEX,
        model="codex-mini",
        prompt="recent-call",
        output="ok",
        success=True,
        timestamp=now,
        prompt_tokens=8,
        completion_tokens=4,
    )

    snapshot = tracker.snapshot(provider=ProviderId.OPENAI_CODEX, model="codex-mini")
    assert snapshot["model_count"] == 1
    row = snapshot["models"][0]
    assert row["total_calls"] == 2
    assert row["window_calls"] == 1
    assert row["window_total_tokens"] == 12


def test_llm_usage_api_endpoints(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DEV_CREW_MODEL_CATALOG_AUTO_REFRESH", "0")
    monkeypatch.setenv("DEV_CREW_MODEL_CATALOG_STARTUP_REFRESH", "0")

    app = create_app(str(tmp_path / "jobs.db"))
    with TestClient(app) as client:
        empty = client.get("/llm/usage")
        assert empty.status_code == 200
        assert empty.json()["model_count"] == 0

        tracker = client.app.state.llm_usage_tracker
        tracker.record_call(
            provider=ProviderId.GOOGLE_ANTIGRAVITY,
            model="gemini-2.5-flash",
            prompt="hello",
            output="world",
            success=True,
            prompt_tokens=5,
            completion_tokens=6,
        )
        tracker.record_call(
            provider=ProviderId.OPENAI_CODEX,
            model="gpt-5-codex-mini",
            prompt="abc",
            output="def",
            success=False,
            prompt_tokens=3,
            completion_tokens=0,
        )

        anti_only = client.get("/llm/usage?provider=google-antigravity")
        assert anti_only.status_code == 200
        anti_body = anti_only.json()
        assert anti_body["model_count"] == 1
        assert anti_body["models"][0]["provider"] == "google-antigravity"
        assert anti_body["models"][0]["total_tokens"] == 11

        model_only = client.get("/llm/usage?model=gpt-5-codex-mini")
        assert model_only.status_code == 200
        model_body = model_only.json()
        assert model_body["model_count"] == 1
        assert model_body["models"][0]["error_calls"] == 1

        reset = client.post("/llm/usage/reset")
        assert reset.status_code == 200
        assert reset.json()["model_count"] == 0

