import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from dev_crew.api.app import create_app


def _wait_for_terminal_state(client: TestClient, job_id: str, timeout_sec: float = 3.0) -> str:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        response = client.get(f"/jobs/{job_id}")
        assert response.status_code == 200
        state = response.json()["state"]
        if state in {"completed", "failed", "canceled"}:
            return state
        time.sleep(0.02)
    raise AssertionError("job did not reach terminal state in time")


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    items: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if raw:
            items.append(json.loads(raw))
    return items


def test_budget_limit_triggers_escalation(monkeypatch, tmp_path: Path) -> None:
    audit_log = tmp_path / "audit.log"
    escalation_log = tmp_path / "escalations.log"

    monkeypatch.setenv("DEV_CREW_AUDIT_LOG_PATH", str(audit_log))
    monkeypatch.setenv("DEV_CREW_ESCALATION_LOG_PATH", str(escalation_log))
    monkeypatch.setenv("DEV_CREW_JOB_MAX_STATE_TRANSITIONS", "2")
    monkeypatch.setenv("DEV_CREW_JOB_MAX_TOOL_CALLS", "10")
    monkeypatch.setenv("DEV_CREW_DOCKER_DRY_RUN", "1")

    app = create_app(str(tmp_path / "jobs.db"))

    with TestClient(app) as client:
        create = client.post(
            "/jobs",
            json={"goal": "Phase6 budget", "repo": "org/repo", "base_branch": "main"},
        )
        assert create.status_code == 200
        job_id = create.json()["job_id"]

        state = _wait_for_terminal_state(client, job_id)
        assert state == "failed"

        escalations = client.get(f"/jobs/{job_id}/escalations")
        assert escalations.status_code == 200
        escalation_items = escalations.json()
        assert len(escalation_items) >= 1

    audit_items = _read_jsonl(audit_log)
    escalation_items = _read_jsonl(escalation_log)
    assert any(item["category"] == "escalation" for item in audit_items)
    assert len(escalation_items) >= 1


def test_docker_sandbox_audit_log_written(monkeypatch, tmp_path: Path) -> None:
    audit_log = tmp_path / "audit.log"
    escalation_log = tmp_path / "escalations.log"

    monkeypatch.setenv("DEV_CREW_AUDIT_LOG_PATH", str(audit_log))
    monkeypatch.setenv("DEV_CREW_ESCALATION_LOG_PATH", str(escalation_log))
    monkeypatch.setenv("DEV_CREW_JOB_MAX_STATE_TRANSITIONS", "20")
    monkeypatch.setenv("DEV_CREW_JOB_MAX_TOOL_CALLS", "10")
    monkeypatch.setenv("DEV_CREW_DOCKER_DRY_RUN", "1")

    app = create_app(str(tmp_path / "jobs.db"))

    with TestClient(app) as client:
        create = client.post(
            "/jobs",
            json={"goal": "Phase6 sandbox", "repo": "org/repo", "base_branch": "main"},
        )
        assert create.status_code == 200
        job_id = create.json()["job_id"]

        state = _wait_for_terminal_state(client, job_id)
        assert state == "completed"

    audit_items = _read_jsonl(audit_log)
    tool_calls = [item for item in audit_items if item["category"] == "tool_call"]
    assert tool_calls
    first_command = tool_calls[0]["metadata"]["command"]
    assert first_command[0] == "docker"
