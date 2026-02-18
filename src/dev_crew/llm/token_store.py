from __future__ import annotations

import json
import os
from pathlib import Path

from .models import OAuthProfile, ProviderId


class FileTokenStore:
    """File-backed token store for cloned OAuth flow with local-only defaults."""

    def __init__(
        self,
        path: str | None = None,
        *,
        workspace_root: str | None = None,
        allow_workspace_path: bool = False,
    ) -> None:
        self.path = Path(path).expanduser().resolve() if path else default_oauth_token_path()
        workspace = Path(
            workspace_root or os.getenv("DEV_CREW_WORKSPACE_ROOT") or os.getcwd()
        ).expanduser().resolve()
        allow_workspace = allow_workspace_path or os.getenv(
            "DEV_CREW_OAUTH_ALLOW_WORKSPACE_PATH", "0"
        ) == "1"

        if not allow_workspace and self.path.is_relative_to(workspace):
            raise ValueError(
                f"OAuth token path must be outside workspace: {self.path} (workspace: {workspace})"
            )

        self.path.parent.mkdir(parents=True, exist_ok=True)
        _chmod_private(self.path.parent, 0o700)
        if self.path.exists():
            _chmod_private(self.path, 0o600)

    def _read_all(self) -> dict[str, dict]:
        if not self.path.exists():
            return {}
        raw = self.path.read_text(encoding="utf-8").strip()
        if not raw:
            return {}
        return json.loads(raw)

    def _write_all(self, payload: dict[str, dict]) -> None:
        self.path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
        _chmod_private(self.path, 0o600)

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


def default_oauth_token_path() -> Path:
    explicit = os.getenv("DEV_CREW_OAUTH_TOKEN_PATH")
    if explicit:
        return Path(explicit).expanduser().resolve()
    return (_real_user_home() / ".config" / "dev_crew" / "oauth_tokens.json").resolve()


def _real_user_home() -> Path:
    if os.name == "nt":
        return Path.home()
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except Exception:
        return Path.home()


def _chmod_private(path: Path, mode: int) -> None:
    try:
        path.chmod(mode)
    except Exception:
        pass
