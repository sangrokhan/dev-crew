from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from .models import LLMModelInfo, LLMProviderCatalog, LLMUsageSummary, LLMUsageWindow, ProviderId
from .provider_auth import build_provider_auth_headers, parse_google_antigravity_api_key
from .token_store import FileTokenStore

CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models"
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
ANTIGRAVITY_BASE_URL = "https://cloudcode-pa.googleapis.com"
ANTIGRAVITY_LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist"
ANTIGRAVITY_FETCH_MODELS_PATH = "/v1internal:fetchAvailableModels"
ANTIGRAVITY_METADATA = {
    "ideType": "ANTIGRAVITY",
    "platform": "PLATFORM_UNSPECIFIED",
    "pluginType": "GEMINI",
}


@dataclass
class _ProviderState:
    provider: ProviderId
    account_id: str
    models: list[LLMModelInfo] = field(default_factory=list)
    usage: LLMUsageSummary | None = None
    last_refresh_at: datetime | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None


class ModelCatalogService:
    def __init__(
        self,
        *,
        token_store: FileTokenStore,
        account_id: str = "default",
        refresh_interval_seconds: int = 600,
        request_timeout_seconds: float = 10.0,
        codex_client_version: str = "0.1.0",
        auto_refresh: bool = True,
        startup_refresh: bool = True,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.token_store = token_store
        self.account_id = account_id
        self.refresh_interval_seconds = max(1, refresh_interval_seconds)
        self.request_timeout_seconds = request_timeout_seconds
        self.codex_client_version = codex_client_version
        self.auto_refresh = auto_refresh
        self.startup_refresh = startup_refresh
        self.transport = transport
        self._lock = asyncio.Lock()
        self._stop_event = asyncio.Event()
        self._refresh_task: asyncio.Task[None] | None = None
        self._states: dict[ProviderId, _ProviderState] = {
            provider: _ProviderState(provider=provider, account_id=account_id) for provider in ProviderId
        }

    async def start(self) -> None:
        if self.startup_refresh:
            await self.refresh()
        if self.auto_refresh and self._refresh_task is None:
            self._stop_event.clear()
            self._refresh_task = asyncio.create_task(self._refresh_loop(), name="dev-crew-model-catalog")

    async def stop(self) -> None:
        if self._refresh_task is None:
            return
        self._stop_event.set()
        task = self._refresh_task
        self._refresh_task = None
        await task

    async def refresh(self, provider: ProviderId | None = None) -> None:
        targets = [provider] if provider else list(ProviderId)
        async with self._lock:
            for target in targets:
                await self._refresh_provider(target)

    def snapshot(
        self,
        *,
        provider: ProviderId | None = None,
    ) -> tuple[list[LLMProviderCatalog], list[LLMModelInfo]]:
        targets = [provider] if provider else list(ProviderId)
        now = datetime.now(timezone.utc)
        provider_rows: list[LLMProviderCatalog] = []
        all_models: list[LLMModelInfo] = []

        for target in targets:
            state = self._states[target]
            stale = self._is_stale(state, now)
            provider_rows.append(
                LLMProviderCatalog(
                    provider=target,
                    account_id=state.account_id,
                    model_count=len(state.models),
                    last_refresh_at=state.last_refresh_at,
                    last_success_at=state.last_success_at,
                    next_refresh_at=self._next_refresh_at(state),
                    stale=stale,
                    last_error=state.last_error,
                    usage=state.usage.model_copy(deep=True) if state.usage else None,
                )
            )
            all_models.extend(model.model_copy(deep=True) for model in state.models)

        all_models.sort(key=lambda row: (row.priority, row.provider.value, row.model_id.lower()))
        return provider_rows, all_models

    async def _refresh_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self.refresh()
            except Exception:
                pass
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self.refresh_interval_seconds)
            except TimeoutError:
                continue

    async def _refresh_provider(self, provider: ProviderId) -> None:
        state = self._states[provider]
        now = datetime.now(timezone.utc)
        state.last_refresh_at = now

        profile = self.token_store.load_profile(provider, account_id=self.account_id)
        if not profile:
            state.last_error = (
                f"OAuth profile not found for provider={provider.value}, account_id={self.account_id}"
            )
            state.usage = None
            return

        api_key = self._build_provider_api_key(provider=provider, access_token=profile.token.access_token, project_id=profile.token.project_id)
        timeout = httpx.Timeout(self.request_timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout, transport=self.transport) as client:
            try:
                if provider == ProviderId.OPENAI_CODEX:
                    models, usage, warning = await self._fetch_codex_catalog(
                        client=client,
                        account_id=profile.account_id,
                        api_key=api_key,
                    )
                elif provider == ProviderId.GOOGLE_ANTIGRAVITY:
                    models, usage, warning = await self._fetch_antigravity_catalog(
                        client=client,
                        account_id=profile.account_id,
                        api_key=api_key,
                    )
                else:
                    raise RuntimeError(f"unsupported provider: {provider.value}")
            except Exception as exc:
                state.last_error = str(exc)
                return

        state.models = models
        state.usage = usage
        state.last_success_at = now
        state.last_error = warning

    async def _fetch_codex_catalog(
        self,
        *,
        client: httpx.AsyncClient,
        account_id: str,
        api_key: str,
    ) -> tuple[list[LLMModelInfo], LLMUsageSummary | None, str | None]:
        headers = build_provider_auth_headers(
            provider=ProviderId.OPENAI_CODEX,
            api_key=api_key,
            account_id=account_id,
        )
        headers["User-Agent"] = "CodexBar"

        response = await client.get(
            CODEX_MODELS_URL,
            params={"client_version": self.codex_client_version},
            headers=headers,
        )
        if response.status_code in {401, 403}:
            raise RuntimeError("codex models request failed: token expired or forbidden")
        if response.status_code >= 400:
            raise RuntimeError(f"codex models request failed: HTTP {response.status_code}")
        payload = response.json()
        models = self._parse_codex_models(payload)

        usage: LLMUsageSummary | None = None
        warning: str | None = None
        try:
            usage_res = await client.get(CODEX_USAGE_URL, headers=headers)
            if usage_res.status_code < 400:
                usage = self._parse_codex_usage(usage_res.json())
            else:
                warning = f"codex usage request failed: HTTP {usage_res.status_code}"
        except Exception as exc:
            warning = f"codex usage request failed: {exc}"
        return models, usage, warning

    async def _fetch_antigravity_catalog(
        self,
        *,
        client: httpx.AsyncClient,
        account_id: str,
        api_key: str,
    ) -> tuple[list[LLMModelInfo], LLMUsageSummary | None, str | None]:
        del account_id
        headers = build_provider_auth_headers(
            provider=ProviderId.GOOGLE_ANTIGRAVITY,
            api_key=api_key,
        )
        _, token_project_id = parse_google_antigravity_api_key(api_key)
        plan_name: str | None = None
        credits_window: LLMUsageWindow | None = None
        project_id = token_project_id

        load_res = await client.post(
            f"{ANTIGRAVITY_BASE_URL}{ANTIGRAVITY_LOAD_CODE_ASSIST_PATH}",
            headers=headers,
            json={"metadata": ANTIGRAVITY_METADATA},
        )
        if load_res.status_code in {401, 403}:
            raise RuntimeError("antigravity loadCodeAssist failed: token expired or forbidden")
        if load_res.status_code >= 400:
            raise RuntimeError(f"antigravity loadCodeAssist failed: HTTP {load_res.status_code}")
        load_payload = load_res.json()

        plan_name = self._first_text(load_payload, ("currentTier.name", "planType"))
        available_credits = _to_float(load_payload.get("availablePromptCredits"))
        monthly_credits = _to_float((load_payload.get("planInfo") or {}).get("monthlyPromptCredits"))
        if available_credits is not None and monthly_credits and monthly_credits > 0:
            used_percent = _clamp_percent((monthly_credits - available_credits) / monthly_credits * 100.0)
            credits_window = LLMUsageWindow(label="Credits", used_percent=used_percent)
        project_from_load = self._extract_project_id(load_payload)
        if project_from_load:
            project_id = project_from_load

        models_res = await client.post(
            f"{ANTIGRAVITY_BASE_URL}{ANTIGRAVITY_FETCH_MODELS_PATH}",
            headers=headers,
            json={"project": project_id} if project_id else {},
        )
        if models_res.status_code in {401, 403}:
            raise RuntimeError("antigravity fetchAvailableModels failed: token expired or forbidden")
        if models_res.status_code >= 400:
            raise RuntimeError(f"antigravity fetchAvailableModels failed: HTTP {models_res.status_code}")
        models_payload = models_res.json()
        models = self._parse_antigravity_models(models_payload)

        windows: list[LLMUsageWindow] = []
        if credits_window:
            windows.append(credits_window)
        windows.extend(self._build_antigravity_usage_windows(models))
        usage = LLMUsageSummary(plan=plan_name, windows=windows) if (plan_name or windows) else None
        return models, usage, None

    def _parse_codex_models(self, payload: Any) -> list[LLMModelInfo]:
        rows = self._extract_model_rows(payload)
        result: list[LLMModelInfo] = []
        for model_key, raw in rows:
            model_id = self._first_text(raw, ("id", "model", "slug", "name")) or model_key
            if not model_id:
                continue

            display_name = self._first_text(raw, ("display_name", "displayName", "name", "title"))
            context_window = self._first_int(
                raw,
                ("context_window", "contextWindow", "input_token_limit", "max_context_tokens", "maxTokens"),
            )
            max_output = self._first_int(
                raw,
                ("max_output_tokens", "maxOutputTokens", "output_token_limit", "max_completion_tokens"),
            )
            usage_hint, priority = _infer_usage_hint_and_priority(model_id, display_name, context_window)
            result.append(
                LLMModelInfo(
                    provider=ProviderId.OPENAI_CODEX,
                    model_id=model_id,
                    display_name=display_name,
                    usage_hint=usage_hint,
                    priority=priority,
                    context_window_tokens=context_window,
                    max_output_tokens=max_output,
                    metadata={"source": "codex.models"},
                )
            )
        return sorted(result, key=lambda row: (row.priority, row.model_id.lower()))

    def _parse_codex_usage(self, payload: Any) -> LLMUsageSummary | None:
        if not isinstance(payload, dict):
            return None
        windows: list[LLMUsageWindow] = []
        rate_limit = payload.get("rate_limit") if isinstance(payload.get("rate_limit"), dict) else {}

        primary = rate_limit.get("primary_window") if isinstance(rate_limit.get("primary_window"), dict) else None
        if primary:
            seconds = _to_int(primary.get("limit_window_seconds")) or 10800
            used = _clamp_percent(_to_float(primary.get("used_percent")) or 0.0)
            reset_at = _epoch_seconds_to_datetime(_to_float(primary.get("reset_at")))
            hours = max(1, round(seconds / 3600))
            windows.append(LLMUsageWindow(label=f"{hours}h", used_percent=used, reset_at=reset_at))

        secondary = (
            rate_limit.get("secondary_window") if isinstance(rate_limit.get("secondary_window"), dict) else None
        )
        if secondary:
            seconds = _to_int(secondary.get("limit_window_seconds")) or 86400
            used = _clamp_percent(_to_float(secondary.get("used_percent")) or 0.0)
            reset_at = _epoch_seconds_to_datetime(_to_float(secondary.get("reset_at")))
            label = "Day" if seconds >= 86400 else f"{max(1, round(seconds / 3600))}h"
            windows.append(LLMUsageWindow(label=label, used_percent=used, reset_at=reset_at))

        plan = _to_clean_text(payload.get("plan_type"))
        credits = payload.get("credits") if isinstance(payload.get("credits"), dict) else None
        balance = _to_float(credits.get("balance")) if credits else None
        if balance is not None:
            balance_label = f"${balance:.2f}"
            plan = f"{plan} ({balance_label})" if plan else balance_label

        if not windows and not plan:
            return None
        return LLMUsageSummary(plan=plan, windows=windows)

    def _parse_antigravity_models(self, payload: Any) -> list[LLMModelInfo]:
        models_map = payload.get("models") if isinstance(payload, dict) else None
        if not isinstance(models_map, dict):
            return []

        result: list[LLMModelInfo] = []
        for model_id, raw_info in models_map.items():
            if not isinstance(model_id, str) or not isinstance(raw_info, dict):
                continue

            display_name = _to_clean_text(raw_info.get("displayName"))
            context_window = self._first_int(
                raw_info,
                ("contextWindow", "context_window", "maxContextWindowTokens", "inputTokenLimit"),
            )
            max_output = self._first_int(
                raw_info,
                ("maxOutputTokens", "max_output_tokens", "outputTokenLimit"),
            )
            quota = raw_info.get("quotaInfo") if isinstance(raw_info.get("quotaInfo"), dict) else {}
            remaining = _to_float(quota.get("remainingFraction"))
            reset_at = _iso_datetime(quota.get("resetTime"))
            usage_hint, priority = _infer_usage_hint_and_priority(model_id, display_name, context_window)
            if remaining is not None and remaining <= 0.1:
                priority += 20

            result.append(
                LLMModelInfo(
                    provider=ProviderId.GOOGLE_ANTIGRAVITY,
                    model_id=model_id,
                    display_name=display_name,
                    usage_hint=usage_hint,
                    priority=priority,
                    context_window_tokens=context_window,
                    max_output_tokens=max_output,
                    quota_remaining_fraction=remaining,
                    quota_reset_at=reset_at,
                    metadata={
                        "is_exhausted": bool(quota.get("isExhausted")) if "isExhausted" in quota else None,
                        "source": "antigravity.fetchAvailableModels",
                    },
                )
            )
        return sorted(result, key=lambda row: (row.priority, row.model_id.lower()))

    def _build_antigravity_usage_windows(self, models: list[LLMModelInfo]) -> list[LLMUsageWindow]:
        windows: list[LLMUsageWindow] = []
        for model in models:
            if model.quota_remaining_fraction is None:
                continue
            lower_name = model.model_id.lower()
            if "chat_" in lower_name or "tab_" in lower_name:
                continue
            used_percent = _clamp_percent((1.0 - model.quota_remaining_fraction) * 100.0)
            windows.append(
                LLMUsageWindow(
                    label=model.model_id,
                    used_percent=used_percent,
                    reset_at=model.quota_reset_at,
                )
            )
        windows.sort(key=lambda row: row.used_percent, reverse=True)
        return windows[:10]

    @staticmethod
    def _build_provider_api_key(*, provider: ProviderId, access_token: str, project_id: str | None) -> str:
        if provider == ProviderId.GOOGLE_ANTIGRAVITY:
            payload: dict[str, str] = {"token": access_token}
            if project_id:
                payload["projectId"] = project_id
            return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
        return access_token

    @staticmethod
    def _extract_model_rows(payload: Any) -> list[tuple[str | None, dict[str, Any]]]:
        if isinstance(payload, list):
            return [(None, row) for row in payload if isinstance(row, dict)]

        if not isinstance(payload, dict):
            return []

        for key in ("models", "data", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return [(None, row) for row in value if isinstance(row, dict)]
            if isinstance(value, dict):
                return [
                    (row_key if isinstance(row_key, str) else None, row_value)
                    for row_key, row_value in value.items()
                    if isinstance(row_value, dict)
                ]

        if all(isinstance(row_value, dict) for row_value in payload.values()):
            return [
                (row_key if isinstance(row_key, str) else None, row_value)
                for row_key, row_value in payload.items()
                if isinstance(row_value, dict)
            ]
        return []

    @staticmethod
    def _first_text(payload: dict[str, Any], keys: tuple[str, ...]) -> str | None:
        for key in keys:
            if "." in key:
                value: Any = payload
                ok = True
                for part in key.split("."):
                    if isinstance(value, dict) and part in value:
                        value = value[part]
                    else:
                        ok = False
                        break
                if ok:
                    normalized = _to_clean_text(value)
                    if normalized:
                        return normalized
                continue
            normalized = _to_clean_text(payload.get(key))
            if normalized:
                return normalized
        return None

    @staticmethod
    def _first_int(payload: dict[str, Any], keys: tuple[str, ...]) -> int | None:
        for key in keys:
            value = payload.get(key)
            converted = _to_int(value)
            if converted is not None:
                return converted
        return None

    @staticmethod
    def _extract_project_id(payload: dict[str, Any]) -> str | None:
        raw = payload.get("cloudaicompanionProject")
        if isinstance(raw, str):
            return raw.strip() or None
        if isinstance(raw, dict):
            project_id = raw.get("id")
            if isinstance(project_id, str):
                return project_id.strip() or None
        return None

    def _is_stale(self, state: _ProviderState, now: datetime) -> bool:
        if state.last_success_at is None:
            return state.last_error is not None
        horizon = timedelta(seconds=self.refresh_interval_seconds * 2)
        return now - state.last_success_at > horizon

    def _next_refresh_at(self, state: _ProviderState) -> datetime | None:
        if not self.auto_refresh or state.last_refresh_at is None:
            return None
        return state.last_refresh_at + timedelta(seconds=self.refresh_interval_seconds)


def _to_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        parsed = int(value)
        return parsed if parsed > 0 else None
    if isinstance(value, str):
        try:
            parsed = int(float(value.strip()))
        except ValueError:
            return None
        return parsed if parsed > 0 else None
    return None


def _to_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
        return parsed if parsed == parsed else None
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            parsed = float(raw)
        except ValueError:
            return None
        return parsed if parsed == parsed else None
    return None


def _to_clean_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _epoch_seconds_to_datetime(value: float | None) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(value, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _iso_datetime(value: Any) -> datetime | None:
    text = _to_clean_text(value)
    if not text:
        return None
    candidate = text
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _clamp_percent(value: float) -> float:
    if value < 0:
        return 0.0
    if value > 100:
        return 100.0
    return float(value)


def _infer_usage_hint_and_priority(
    model_id: str,
    display_name: str | None,
    context_window_tokens: int | None,
) -> tuple[str, int]:
    haystack = f"{model_id} {display_name or ''}".lower()
    words = set(re.findall(r"[a-z0-9]+", haystack))
    if context_window_tokens and context_window_tokens >= 200_000:
        return "long-context", 35
    if words.intersection({"reason", "pro", "ultra", "o1", "o3", "thinking", "deep", "opus"}):
        return "reasoning", 70
    if words.intersection({"mini", "flash", "lite", "nano", "haiku", "fast"}):
        return "fast", 20
    return "balanced", 50
