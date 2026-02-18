from __future__ import annotations

import base64
import hashlib
import json
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode

from .models import OAuthProfile, OAuthProviderConfig, OAuthStart, OAuthToken, ProviderId
from .token_store import FileTokenStore


class OAuthFlowError(RuntimeError):
    pass


@dataclass
class PendingAuthSession:
    provider: ProviderId
    account_id: str
    state: str
    code_verifier: str


def _random_state() -> str:
    return secrets.token_urlsafe(24)


def _generate_pkce_verifier() -> str:
    return secrets.token_urlsafe(64)


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")


class OAuthCloneClient:
    """
    Cloned OAuth client flow:
    - start_login(): create PKCE verifier/challenge and auth URL
    - complete_login(): exchange auth code through injected exchange function
    """

    def __init__(
        self,
        provider_configs: dict[ProviderId, OAuthProviderConfig],
        token_store: FileTokenStore,
        pending_store_path: str | None = None,
    ) -> None:
        self.provider_configs = provider_configs
        self.token_store = token_store
        self.pending_store_path = (
            Path(pending_store_path).expanduser().resolve()
            if pending_store_path
            else self.token_store.path.with_name(
                f"{self.token_store.path.stem}.pending{self.token_store.path.suffix}"
            )
        )
        self.pending_store_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.pending_store_path.parent.chmod(0o700)
        except Exception:
            pass
        self.pending: dict[str, PendingAuthSession] = self._load_pending()

    def start_login(self, provider: ProviderId, account_id: str = "default") -> OAuthStart:
        config = self.provider_configs.get(provider)
        if not config:
            raise OAuthFlowError(f"provider config not found: {provider.value}")

        state = _random_state()
        code_verifier = _generate_pkce_verifier()
        code_challenge = _pkce_challenge(code_verifier)

        query = urlencode(
            {
                "response_type": "code",
                "client_id": config.client_id,
                "redirect_uri": config.redirect_uri,
                "scope": " ".join(config.scopes),
                "state": state,
                "code_challenge_method": "S256",
                "code_challenge": code_challenge,
                **config.authorize_params,
            }
        )
        auth_url = f"{config.authorize_url}?{query}"
        self.pending[state] = PendingAuthSession(
            provider=provider,
            account_id=account_id,
            state=state,
            code_verifier=code_verifier,
        )
        self._save_pending()
        return OAuthStart(
            provider=provider,
            state=state,
            code_verifier=code_verifier,
            code_challenge=code_challenge,
            authorization_url=auth_url,
        )

    def complete_login(
        self,
        *,
        state: str,
        auth_code: str,
        token_exchange: Callable[..., dict[str, Any]],
    ) -> OAuthProfile:
        session = self.pending.get(state)
        if not session:
            raise OAuthFlowError(f"pending auth session not found for state: {state}")

        provider_config = self.provider_configs[session.provider]
        token_payload = token_exchange(
            provider_config=provider_config,
            code=auth_code,
            code_verifier=session.code_verifier,
        )
        token = OAuthToken.from_token_response(token_payload)
        profile = OAuthProfile(
            provider=session.provider,
            account_id=session.account_id,
            token=token,
        )
        self.token_store.save_profile(profile)
        del self.pending[state]
        self._save_pending()
        return profile

    def refresh_access_token(
        self,
        *,
        provider: ProviderId,
        account_id: str = "default",
        token_refresh: Callable[..., dict[str, Any]],
    ) -> OAuthProfile:
        profile = self.token_store.load_profile(provider, account_id=account_id)
        if not profile:
            raise OAuthFlowError(
                f"OAuth profile not found for provider={provider.value}, account_id={account_id}"
            )
        if not profile.token.refresh_token:
            raise OAuthFlowError(
                f"refresh token not found for provider={provider.value}, account_id={account_id}"
            )

        provider_config = self.provider_configs.get(provider)
        if not provider_config:
            raise OAuthFlowError(f"provider config not found: {provider.value}")

        token_payload = token_refresh(
            provider_config=provider_config,
            refresh_token=profile.token.refresh_token,
        )
        token = OAuthToken.from_token_response(
            token_payload,
            previous_refresh_token=profile.token.refresh_token,
            previous_project_id=profile.token.project_id,
        )
        refreshed = OAuthProfile(
            provider=provider,
            account_id=account_id,
            token=token,
        )
        self.token_store.save_profile(refreshed)
        return refreshed

    def _load_pending(self) -> dict[str, PendingAuthSession]:
        if not self.pending_store_path.exists():
            return {}
        raw = self.pending_store_path.read_text(encoding="utf-8").strip()
        if not raw:
            return {}
        data = json.loads(raw)
        sessions: dict[str, PendingAuthSession] = {}
        for state, payload in data.items():
            sessions[state] = PendingAuthSession(
                provider=ProviderId(payload["provider"]),
                account_id=payload["account_id"],
                state=payload["state"],
                code_verifier=payload["code_verifier"],
            )
        return sessions

    def _save_pending(self) -> None:
        serialized = {
            state: {
                "provider": session.provider.value,
                "account_id": session.account_id,
                "state": session.state,
                "code_verifier": session.code_verifier,
            }
            for state, session in self.pending.items()
        }
        self.pending_store_path.write_text(
            json.dumps(serialized, ensure_ascii=True, indent=2),
            encoding="utf-8",
        )
        try:
            self.pending_store_path.chmod(0o600)
        except Exception:
            pass
