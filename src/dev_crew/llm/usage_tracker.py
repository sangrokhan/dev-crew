from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Lock

from .models import ProviderId


@dataclass
class _UsageEvent:
    provider: ProviderId
    model: str
    timestamp: datetime
    prompt_tokens: int
    completion_tokens: int
    success: bool

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass
class _UsageTotals:
    provider: ProviderId
    model: str
    total_calls: int = 0
    success_calls: int = 0
    error_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    last_called_at: datetime | None = None


class LLMUsageTracker:
    def __init__(self, *, window_minutes: int = 60) -> None:
        self.window_minutes = max(1, window_minutes)
        self._window = timedelta(minutes=self.window_minutes)
        self._events: deque[_UsageEvent] = deque()
        self._totals: dict[tuple[ProviderId, str], _UsageTotals] = {}
        self._lock = Lock()

    def record_call(
        self,
        *,
        provider: ProviderId,
        model: str,
        prompt: str,
        output: str,
        success: bool,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        timestamp: datetime | None = None,
    ) -> None:
        model_id = model.strip()
        if not model_id:
            return

        event_time = timestamp or datetime.now(timezone.utc)
        if event_time.tzinfo is None:
            event_time = event_time.replace(tzinfo=timezone.utc)
        else:
            event_time = event_time.astimezone(timezone.utc)

        used_prompt_tokens = prompt_tokens if prompt_tokens is not None else _estimate_tokens(prompt)
        used_completion_tokens = (
            completion_tokens if completion_tokens is not None else _estimate_tokens(output)
        )
        used_prompt_tokens = max(0, used_prompt_tokens)
        used_completion_tokens = max(0, used_completion_tokens)

        with self._lock:
            self._prune_locked(now=event_time)
            key = (provider, model_id)
            totals = self._totals.get(key)
            if totals is None:
                totals = _UsageTotals(provider=provider, model=model_id)
                self._totals[key] = totals

            totals.total_calls += 1
            totals.success_calls += 1 if success else 0
            totals.error_calls += 0 if success else 1
            totals.prompt_tokens += used_prompt_tokens
            totals.completion_tokens += used_completion_tokens
            totals.last_called_at = event_time

            self._events.append(
                _UsageEvent(
                    provider=provider,
                    model=model_id,
                    timestamp=event_time,
                    prompt_tokens=used_prompt_tokens,
                    completion_tokens=used_completion_tokens,
                    success=success,
                )
            )

    def reset(self) -> None:
        with self._lock:
            self._events.clear()
            self._totals.clear()

    def snapshot(
        self,
        *,
        provider: ProviderId | None = None,
        model: str | None = None,
    ) -> dict:
        now = datetime.now(timezone.utc)
        model_filter = model.strip() if isinstance(model, str) else None
        if model_filter == "":
            model_filter = None

        with self._lock:
            self._prune_locked(now=now)
            window_counters: dict[tuple[ProviderId, str], dict[str, int]] = {}
            for event in self._events:
                key = (event.provider, event.model)
                row = window_counters.setdefault(
                    key,
                    {
                        "calls": 0,
                        "success_calls": 0,
                        "error_calls": 0,
                        "prompt_tokens": 0,
                        "completion_tokens": 0,
                    },
                )
                row["calls"] += 1
                row["success_calls"] += 1 if event.success else 0
                row["error_calls"] += 0 if event.success else 1
                row["prompt_tokens"] += event.prompt_tokens
                row["completion_tokens"] += event.completion_tokens

            models = []
            for (row_provider, row_model), totals in self._totals.items():
                if provider and row_provider != provider:
                    continue
                if model_filter and row_model != model_filter:
                    continue
                window = window_counters.get((row_provider, row_model), {})
                total_tokens = totals.prompt_tokens + totals.completion_tokens
                window_prompt = window.get("prompt_tokens", 0)
                window_completion = window.get("completion_tokens", 0)
                models.append(
                    {
                        "provider": row_provider.value,
                        "model": row_model,
                        "total_calls": totals.total_calls,
                        "success_calls": totals.success_calls,
                        "error_calls": totals.error_calls,
                        "total_prompt_tokens": totals.prompt_tokens,
                        "total_completion_tokens": totals.completion_tokens,
                        "total_tokens": total_tokens,
                        "window_calls": window.get("calls", 0),
                        "window_success_calls": window.get("success_calls", 0),
                        "window_error_calls": window.get("error_calls", 0),
                        "window_prompt_tokens": window_prompt,
                        "window_completion_tokens": window_completion,
                        "window_total_tokens": window_prompt + window_completion,
                        "last_called_at": totals.last_called_at.isoformat()
                        if totals.last_called_at
                        else None,
                    }
                )

            models.sort(key=lambda row: (row["provider"], row["model"]))

            return {
                "window_minutes": self.window_minutes,
                "generated_at": now.isoformat(),
                "model_count": len(models),
                "models": models,
            }

    def _prune_locked(self, *, now: datetime) -> None:
        cutoff = now - self._window
        while self._events and self._events[0].timestamp < cutoff:
            self._events.popleft()


def _estimate_tokens(text: str) -> int:
    normalized = text.strip()
    if not normalized:
        return 0
    # Lightweight fallback estimator when provider token usage is unavailable.
    return max(1, (len(normalized) + 3) // 4)

