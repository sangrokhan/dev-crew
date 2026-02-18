from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
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
    ) -> None:
        self.provider_configs = provider_configs
        self.token_store = token_store
        self.pending: dict[str, PendingAuthSession] = {}

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
            }
        )
        auth_url = f"{config.authorize_url}?{query}"
        self.pending[state] = PendingAuthSession(
            provider=provider,
            account_id=account_id,
            state=state,
            code_verifier=code_verifier,
        )
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
        token_exchange,
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
        return profile
