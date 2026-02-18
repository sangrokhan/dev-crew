from __future__ import annotations

import json
from pathlib import Path

from .models import OAuthProfile, ProviderId


class FileTokenStore:
    """Simple file-backed token store for cloned OAuth flow."""

    def __init__(self, path: str) -> None:
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read_all(self) -> dict[str, dict]:
        if not self.path.exists():
            return {}
        raw = self.path.read_text(encoding="utf-8").strip()
        if not raw:
            return {}
        return json.loads(raw)

    def _write_all(self, payload: dict[str, dict]) -> None:
        self.path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")

    @staticmethod
    def _key(provider: ProviderId, account_id: str) -> str:
        return f"{provider.value}:{account_id}"

    def save_profile(self, profile: OAuthProfile) -> None:
        all_data = self._read_all()
        all_data[self._key(profile.provider, profile.account_id)] = profile.model_dump(mode="json")
        self._write_all(all_data)

    def load_profile(self, provider: ProviderId, account_id: str = "default") -> OAuthProfile | None:
        all_data = self._read_all()
        data = all_data.get(self._key(provider, account_id))
        if not data:
            return None
        return OAuthProfile.model_validate(data)
