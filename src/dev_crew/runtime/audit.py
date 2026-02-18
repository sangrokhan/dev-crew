from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class AuditEntry:
    at: str
    job_id: str
    category: str
    action: str
    metadata: dict[str, Any]


class JsonlAuditLogger:
    def __init__(self, path: str) -> None:
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, *, job_id: str, category: str, action: str, metadata: dict[str, Any]) -> None:
        entry = AuditEntry(
            at=datetime.now(timezone.utc).isoformat(),
            job_id=job_id,
            category=category,
            action=action,
            metadata=metadata,
        )
        with self.path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(entry.__dict__, ensure_ascii=True) + "\n")

    def read_entries(self, job_id: str | None = None) -> list[AuditEntry]:
        if not self.path.exists():
            return []
        entries: list[AuditEntry] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            raw = line.strip()
            if not raw:
                continue
            payload = json.loads(raw)
            entry = AuditEntry(**payload)
            if job_id is None or entry.job_id == job_id:
                entries.append(entry)
        return entries
