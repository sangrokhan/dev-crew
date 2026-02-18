import json
import sqlite3
import time
from pathlib import Path

from fastapi.testclient import TestClient

from dev_crew.api.app import create_app


def _wait_for_terminal_state(client: TestClient, job_id: str, timeout_sec: float = 2.0) -> str:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        response = client.get(f"/jobs/{job_id}")
        assert response.status_code == 200
        state = response.json()["state"]
        if state in {"completed", "failed", "canceled"}:
            return state
        time.sleep(0.02)
    raise AssertionError("job did not reach terminal state in time")


def _read_job_events(db_path: Path, job_id: str) -> list[dict]:
    with sqlite3.connect(str(db_path)) as conn:
        rows = conn.execute(
            """
            SELECT id, state, message, metadata_json
            FROM job_events
            WHERE job_id = ?
            ORDER BY id ASC
            """,
            (job_id,),
        ).fetchall()
    return [
        {
            "id": row[0],
            "state": row[1],
            "message": row[2],
            "metadata": json.loads(row[3]),
        }
        for row in rows
    ]


def test_create_and_get_job_flow(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    app = create_app(str(db_path))

    with TestClient(app) as client:
        create = client.post(
            "/jobs",
            json={"goal": "Implement API", "repo": "org/repo", "base_branch": "main"},
        )
        assert create.status_code == 200
        body = create.json()
        job_id = body["job_id"]

        state = _wait_for_terminal_state(client, job_id)
        assert state == "completed"

        status = client.get(f"/jobs/{job_id}")
        assert status.status_code == 200
        status_body = status.json()
        assert status_body["job_id"] == job_id
        assert status_body["history_count"] >= 2

        events = _read_job_events(db_path, job_id)
        workflow_steps = [
            event["metadata"]
            for event in events
            if event["metadata"].get("event_type") == "workflow_step"
        ]
        assert workflow_steps

        workflow_keys = [f"{event['step']}:{event['phase']}" for event in workflow_steps]
        assert "request:received" in workflow_keys
        assert "pan_out:started" in workflow_keys
        assert "pan_out:completed" in workflow_keys
        assert "pan_in:completed" in workflow_keys
        assert "aggregation:completed" in workflow_keys
        assert "final_conclusion:completed" in workflow_keys

        call_orders = [event["call_order"] for event in workflow_steps]
        assert call_orders == sorted(call_orders)
        assert len(call_orders) == len(set(call_orders))

        decisions = [
            event["metadata"]
            for event in events
            if event["metadata"].get("event_type") == "agent_decision"
        ]
        assert decisions
        roles = {decision["agent_role"] for decision in decisions}
        assert "leader" in roles
        assert "backend" in roles


def test_idempotency_reuse_and_conflict(tmp_path: Path) -> None:
    app = create_app(str(tmp_path / "jobs.db"))

    with TestClient(app) as client:
        headers = {"Idempotency-Key": "same-key"}
        payload = {"goal": "Task A", "repo": "org/repo", "base_branch": "main"}

        first = client.post("/jobs", json=payload, headers=headers)
        assert first.status_code == 200

        second = client.post("/jobs", json=payload, headers=headers)
        assert second.status_code == 200
        assert second.json()["reused"] is True
        assert second.json()["job_id"] == first.json()["job_id"]

        conflict = client.post(
            "/jobs",
            json={"goal": "Task B", "repo": "org/repo", "base_branch": "main"},
            headers=headers,
        )
        assert conflict.status_code == 409


def test_sse_events_endpoint(tmp_path: Path) -> None:
    app = create_app(str(tmp_path / "jobs.db"))

    with TestClient(app) as client:
        create = client.post(
            "/jobs",
            json={"goal": "SSE test", "repo": "org/repo", "base_branch": "main"},
        )
        job_id = create.json()["job_id"]

        with client.stream("GET", f"/jobs/{job_id}/events") as response:
            assert response.status_code == 200
            chunks = []
            for line in response.iter_lines():
                if not line:
                    continue
                chunks.append(line)
                if "event: done" in line:
                    break

        assert any("event: job_event" in line for line in chunks)
        assert any("event: done" in line for line in chunks)
