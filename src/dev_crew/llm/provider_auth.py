from __future__ import annotations

import json

from .models import ProviderId


def parse_google_antigravity_api_key(api_key: str) -> tuple[str, str | None]:
    raw = api_key.strip()
    if not raw:
        raise ValueError("google-antigravity token is empty")

    if raw.startswith("{"):
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return raw, None
        if isinstance(payload, dict):
            token = payload.get("token")
            if isinstance(token, str) and token.strip():
                project_id = payload.get("projectId") or payload.get("project_id")
                if isinstance(project_id, str):
                    project_id = project_id.strip() or None
                else:
                    project_id = None
                return token.strip(), project_id
    return raw, None


def build_provider_auth_headers(
    *,
    provider: ProviderId,
    api_key: str,
    account_id: str | None = None,
) -> dict[str, str]:
    key = api_key.strip()
    if not key:
        raise ValueError(f"{provider.value} token is empty")

    if provider == ProviderId.OPENAI_CODEX:
        headers = {
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if account_id and account_id.strip():
            headers["ChatGPT-Account-Id"] = account_id.strip()
        return headers

    if provider == ProviderId.GOOGLE_ANTIGRAVITY:
        token, _project_id = parse_google_antigravity_api_key(key)
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "antigravity",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        }

    raise ValueError(f"unsupported provider: {provider.value}")
