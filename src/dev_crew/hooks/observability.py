from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class HookEvent:
    at: datetime
    kind: str
    name: str
    payload: dict[str, Any] = field(default_factory=dict)


class EventLogger:
    def __init__(self) -> None:
        self._events: list[HookEvent] = []

    def record(self, kind: str, name: str, payload: dict[str, Any] | None = None) -> None:
        self._events.append(
            HookEvent(
                at=datetime.now(timezone.utc),
                kind=kind,
                name=name,
                payload=payload or {},
            )
        )

    def on_llm_call(self, provider: str, model: str, phase: str) -> None:
        self.record("llm_call", phase, {"provider": provider, "model": model})

    def on_tool_call(self, tool: str, command: str, returncode: int) -> None:
        self.record("tool_call", tool, {"command": command, "returncode": returncode})

    def list_events(self) -> list[HookEvent]:
        return list(self._events)
