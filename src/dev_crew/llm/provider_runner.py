from __future__ import annotations

import json
import os
from typing import Any

import httpx

from .models import ProviderId
from .provider_auth import build_provider_auth_headers, parse_google_antigravity_api_key

DEFAULT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
DEFAULT_ANTIGRAVITY_GENERATE_URL = "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent"
DEFAULT_ANTIGRAVITY_LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
ANTIGRAVITY_METADATA = {
    "ideType": "ANTIGRAVITY",
    "platform": "PLATFORM_UNSPECIFIED",
    "pluginType": "GEMINI",
}


class HttpProviderRunner:
    """HTTP provider runner used by CustomLLMAdapter."""

    def __init__(
        self,
        *,
        account_id: str = "default",
        codex_responses_url: str | None = None,
        antigravity_generate_url: str | None = None,
        antigravity_load_code_assist_url: str | None = None,
        request_timeout_seconds: float = 60.0,
        codex_client_version: str = "0.1.0",
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.account_id = account_id
        self.codex_responses_url = (
            codex_responses_url
            or os.getenv("DEV_CREW_CODEX_RESPONSES_URL")
            or DEFAULT_CODEX_RESPONSES_URL
        )
        self.antigravity_generate_url = (
            antigravity_generate_url
            or os.getenv("DEV_CREW_ANTIGRAVITY_GENERATE_URL")
            or DEFAULT_ANTIGRAVITY_GENERATE_URL
        )
        self.antigravity_load_code_assist_url = (
            antigravity_load_code_assist_url
            or os.getenv("DEV_CREW_ANTIGRAVITY_LOAD_CODE_ASSIST_URL")
            or DEFAULT_ANTIGRAVITY_LOAD_CODE_ASSIST_URL
        )
        self.request_timeout_seconds = request_timeout_seconds
        self.codex_client_version = codex_client_version
        self.transport = transport

    def __call__(self, provider: ProviderId, api_key: str, model: str, prompt: str) -> str:
        timeout = httpx.Timeout(self.request_timeout_seconds)
        with httpx.Client(timeout=timeout, transport=self.transport) as client:
            if provider == ProviderId.OPENAI_CODEX:
                return self._run_codex(client=client, api_key=api_key, model=model, prompt=prompt)
            if provider == ProviderId.GOOGLE_ANTIGRAVITY:
                return self._run_antigravity(client=client, api_key=api_key, model=model, prompt=prompt)
        raise RuntimeError(f"unsupported provider: {provider.value}")

    def _run_codex(
        self,
        *,
        client: httpx.Client,
        api_key: str,
        model: str,
        prompt: str,
    ) -> str:
        headers = build_provider_auth_headers(
            provider=ProviderId.OPENAI_CODEX,
            api_key=api_key,
            account_id=self.account_id,
        )
        headers["User-Agent"] = "CodexBar"
        response = client.post(
            self.codex_responses_url,
            params={"client_version": self.codex_client_version},
            headers=headers,
            json={
                "model": model,
                "instructions": "You are a concise coding assistant.",
                "store": False,
                "stream": True,
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": prompt}],
                    }
                ],
            },
        )
        if response.status_code in {401, 403}:
            raise RuntimeError("codex query failed: token expired or forbidden")
        if response.status_code >= 400:
            detail = response.text[:300]
            raise RuntimeError(f"codex query failed: HTTP {response.status_code} ({detail})")
        text = _extract_text_from_sse(response.text)
        if text.strip():
            return text
        try:
            fallback = _extract_text_from_payload(response.json())
        except Exception:
            fallback = ""
        if fallback.strip():
            return fallback
        raise RuntimeError("codex query failed: empty response")

    def _run_antigravity(
        self,
        *,
        client: httpx.Client,
        api_key: str,
        model: str,
        prompt: str,
    ) -> str:
        headers = build_provider_auth_headers(
            provider=ProviderId.GOOGLE_ANTIGRAVITY,
            api_key=api_key,
        )
        _token, project_id = parse_google_antigravity_api_key(api_key)
        if not project_id:
            project_id = self._resolve_antigravity_project_id(client=client, headers=headers)

        generate_url = self.antigravity_generate_url
        if "alt=" not in generate_url:
            separator = "&" if "?" in generate_url else "?"
            generate_url = f"{generate_url}{separator}alt=sse"

        body: dict[str, Any] = {
            "model": model,
            "request": {
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": prompt}],
                    }
                ]
            },
        }
        if project_id:
            body["project"] = project_id

        response = client.post(
            generate_url,
            headers=headers,
            json=body,
        )
        if response.status_code in {401, 403}:
            raise RuntimeError("antigravity query failed: token expired or forbidden")
        if response.status_code >= 400:
            detail = response.text[:300]
            raise RuntimeError(f"antigravity query failed: HTTP {response.status_code} ({detail})")

        content_type = response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            text = _extract_text_from_sse(response.text)
        else:
            text = _extract_text_from_payload(response.json())
        if text.strip():
            return text
        raise RuntimeError("antigravity query failed: empty response")

    def _resolve_antigravity_project_id(
        self,
        *,
        client: httpx.Client,
        headers: dict[str, str],
    ) -> str | None:
        response = client.post(
            self.antigravity_load_code_assist_url,
            headers=headers,
            json={"metadata": ANTIGRAVITY_METADATA},
        )
        if response.status_code >= 400:
            return None
        payload = response.json()
        project = payload.get("cloudaicompanionProject")
        if isinstance(project, str):
            return project.strip() or None
        if isinstance(project, dict):
            project_id = project.get("id")
            if isinstance(project_id, str):
                return project_id.strip() or None
        return None


def _extract_text_from_sse(raw: str) -> str:
    chunks: list[str] = []
    completed_text: str | None = None
    current_event: str | None = None
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            current_event = None
            continue
        if stripped.startswith("event:"):
            current_event = stripped[6:].strip() or None
            continue
        if not stripped.startswith("data:"):
            continue
        data = stripped[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            payload = json.loads(data)
        except json.JSONDecodeError:
            continue
        text = _extract_text_from_payload(payload)
        if text:
            event_type = (
                current_event
                or (
                    payload.get("type")
                    if isinstance(payload, dict) and isinstance(payload.get("type"), str)
                    else ""
                )
            ).lower()
            if event_type.endswith(".completed") or event_type.endswith(".done"):
                completed_text = text
                continue
            if event_type.endswith(".delta") or not event_type:
                if not chunks or chunks[-1] != text:
                    chunks.append(text)
    if completed_text:
        return completed_text
    return "\n".join(chunk for chunk in chunks if chunk)


def _extract_text_from_payload(payload: Any) -> str:
    if isinstance(payload, str):
        return payload.strip()
    if not isinstance(payload, dict):
        return ""

    nested_response = payload.get("response")
    if isinstance(nested_response, dict):
        nested_text = _extract_text_from_payload(nested_response)
        if nested_text:
            return nested_text

    prioritized = [
        payload.get("output_text"),
        payload.get("text"),
    ]
    for value in prioritized:
        text = _coerce_to_text(value)
        if text:
            return text

    content_text = _extract_from_content_items(payload.get("content"))
    if content_text:
        return content_text

    output = payload.get("output")
    output_text = _extract_from_output_items(output)
    if output_text:
        return output_text

    choices = payload.get("choices")
    if isinstance(choices, list):
        choice_text: list[str] = []
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            delta = _coerce_to_text(choice.get("delta"))
            message = _coerce_to_text(choice.get("message"))
            text = _coerce_to_text(choice.get("text"))
            for candidate in (delta, message, text):
                if candidate:
                    choice_text.append(candidate)
        if choice_text:
            return "\n".join(choice_text)

    candidates = payload.get("candidates")
    if isinstance(candidates, list):
        candidate_text: list[str] = []
        for candidate in candidates:
            text = _coerce_to_text(candidate)
            if text:
                candidate_text.append(text)
        if candidate_text:
            return "\n".join(candidate_text)

    return ""


def _extract_from_output_items(output: Any) -> str:
    if not isinstance(output, list):
        return ""
    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        text = _coerce_to_text(content)
        if text:
            parts.append(text)
    return "\n".join(parts)


def _extract_from_content_items(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict):
            text = _coerce_to_text(item.get("text"))
            if text:
                parts.append(text)
                continue
        text = _coerce_to_text(item)
        if text:
            parts.append(text)
    return "\n".join(parts)


def _coerce_to_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        pieces = [_coerce_to_text(item) for item in value]
        return "\n".join(piece for piece in pieces if piece)
    if isinstance(value, dict):
        text_like_keys = (
            "text",
            "content",
            "message",
            "output_text",
            "response",
            "delta",
            "parts",
            "candidates",
        )
        pieces: list[str] = []
        for key in text_like_keys:
            if key in value:
                piece = _coerce_to_text(value.get(key))
                if piece:
                    pieces.append(piece)
        return "\n".join(pieces)
    return ""
