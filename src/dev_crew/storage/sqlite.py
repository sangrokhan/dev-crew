from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from dev_crew.models import JobEvent, JobRecord, JobState, RateLimitPolicy, RetryPolicy


@dataclass
class EventRow:
    id: int
    job_id: str
    at: str
    state: str
    message: str
    metadata_json: str


class SqliteJobStore:
    def __init__(self, db_path: str) -> None:
        self.db_path = Path(db_path).expanduser().resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.db_path), check_same_thread=False)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    goal TEXT NOT NULL,
                    repo TEXT NOT NULL,
                    base_branch TEXT NOT NULL,
                    work_branch TEXT NOT NULL,
                    current_state TEXT NOT NULL,
                    retry_policy_json TEXT NOT NULL,
                    rate_limit_policy_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS job_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    at TEXT NOT NULL,
                    state TEXT NOT NULL,
                    message TEXT NOT NULL,
                    metadata_json TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS idempotency_keys (
                    key TEXT PRIMARY KEY,
                    request_hash TEXT NOT NULL,
                    job_id TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def create_job(self, job: JobRecord) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs (
                    job_id, goal, repo, base_branch, work_branch, current_state,
                    retry_policy_json, rate_limit_policy_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job.job_id,
                    job.goal,
                    job.repo,
                    job.base_branch,
                    job.work_branch,
                    job.current_state.value,
                    json.dumps(job.retry_policy.model_dump(), ensure_ascii=True),
                    json.dumps(job.rate_limit_policy.model_dump(), ensure_ascii=True),
                    now,
                    now,
                ),
            )
            for event in job.history:
                conn.execute(
                    """
                    INSERT INTO job_events (job_id, at, state, message, metadata_json)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        job.job_id,
                        event.at.isoformat(),
                        event.state.value,
                        event.message,
                        json.dumps(event.metadata, ensure_ascii=True),
                    ),
                )
            conn.commit()

    def append_event(self, job_id: str, event: JobEvent) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO job_events (job_id, at, state, message, metadata_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    event.at.isoformat(),
                    event.state.value,
                    event.message,
                    json.dumps(event.metadata, ensure_ascii=True),
                ),
            )
            conn.execute(
                """
                UPDATE jobs
                SET current_state = ?, updated_at = ?
                WHERE job_id = ?
                """,
                (
                    event.state.value,
                    datetime.now(timezone.utc).isoformat(),
                    job_id,
                ),
            )
            conn.commit()

    def get_job(self, job_id: str) -> JobRecord | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT job_id, goal, repo, base_branch, work_branch, current_state,
                       retry_policy_json, rate_limit_policy_json
                FROM jobs
                WHERE job_id = ?
                """,
                (job_id,),
            ).fetchone()
            if not row:
                return None

            event_rows = conn.execute(
                """
                SELECT id, job_id, at, state, message, metadata_json
                FROM job_events
                WHERE job_id = ?
                ORDER BY id ASC
                """,
                (job_id,),
            ).fetchall()

        events = [
            JobEvent(
                at=datetime.fromisoformat(event_row["at"]),
                state=JobState(event_row["state"]),
                message=event_row["message"],
                metadata=json.loads(event_row["metadata_json"]),
            )
            for event_row in event_rows
        ]
        return JobRecord(
            job_id=row["job_id"],
            goal=row["goal"],
            repo=row["repo"],
            base_branch=row["base_branch"],
            work_branch=row["work_branch"],
            current_state=JobState(row["current_state"]),
            retry_policy=RetryPolicy.model_validate(json.loads(row["retry_policy_json"])),
            rate_limit_policy=RateLimitPolicy.model_validate(
                json.loads(row["rate_limit_policy_json"])
            ),
            history=events,
        )

    def list_event_rows(self, job_id: str, after_id: int = 0) -> list[EventRow]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, job_id, at, state, message, metadata_json
                FROM job_events
                WHERE job_id = ? AND id > ?
                ORDER BY id ASC
                """,
                (job_id, after_id),
            ).fetchall()
        return [
            EventRow(
                id=row["id"],
                job_id=row["job_id"],
                at=row["at"],
                state=row["state"],
                message=row["message"],
                metadata_json=row["metadata_json"],
            )
            for row in rows
        ]

    def get_idempotency(self, key: str) -> tuple[str, str] | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT request_hash, job_id
                FROM idempotency_keys
                WHERE key = ?
                """,
                (key,),
            ).fetchone()
        if not row:
            return None
        return (row["request_hash"], row["job_id"])

    def create_idempotency(self, key: str, request_hash: str, job_id: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO idempotency_keys (key, request_hash, job_id)
                VALUES (?, ?, ?)
                """,
                (key, request_hash, job_id),
            )
            conn.commit()
