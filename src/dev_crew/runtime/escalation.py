from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .audit import JsonlAuditLogger


@dataclass
class EscalationRecord:
    escalation_id: str
    at: str
    job_id: str
    severity: str
    reason: str
    metadata: dict[str, Any]


class EscalationManager:
    def __init__(self, path: str, audit_logger: JsonlAuditLogger | None = None) -> None:
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.audit_logger = audit_logger

    def create(
        self,
        *,
        job_id: str,
        severity: str,
        reason: str,
        metadata: dict[str, Any] | None = None,
    ) -> EscalationRecord:
        record = EscalationRecord(
            escalation_id=str(uuid.uuid4()),
            at=datetime.now(timezone.utc).isoformat(),
            job_id=job_id,
            severity=severity,
            reason=reason,
            metadata=metadata or {},
        )
        with self.path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(asdict(record), ensure_ascii=True) + "\n")

        if self.audit_logger:
            self.audit_logger.log(
                job_id=job_id,
                category="escalation",
                action="created",
                metadata={
                    "escalation_id": record.escalation_id,
                    "severity": severity,
                    "reason": reason,
                    "metadata": record.metadata,
                },
            )
        return record

    def list_for_job(self, job_id: str) -> list[EscalationRecord]:
        if not self.path.exists():
            return []
        records: list[EscalationRecord] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            raw = line.strip()
            if not raw:
                continue
            payload = json.loads(raw)
            if payload.get("job_id") == job_id:
                records.append(EscalationRecord(**payload))
        return records
