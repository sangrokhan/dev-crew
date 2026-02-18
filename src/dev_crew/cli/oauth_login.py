from __future__ import annotations

import argparse
import json
import os
import webbrowser
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from dev_crew.llm.models import OAuthProviderConfig, ProviderId
from dev_crew.llm.oauth_clone import OAuthCloneClient
from dev_crew.llm.token_store import FileTokenStore

OPENCLAW_PROVIDER_DEFAULTS: dict[ProviderId, dict[str, str]] = {
    ProviderId.OPENAI_CODEX: {
        "AUTHORIZE_URL": "https://auth.openai.com/oauth/authorize",
        "TOKEN_URL": "https://auth.openai.com/oauth/token",
        "REDIRECT_URI": "http://localhost:1455/auth/callback",
        "CLIENT_ID": "app_EMoamEEZ73f0CkXaXp7hrann",
        "SCOPES": "openid profile email offline_access",
        "AUTHORIZE_EXTRA_ID_TOKEN_ADD_ORGANIZATIONS": "true",
        "AUTHORIZE_EXTRA_CODEX_CLI_SIMPLIFIED_FLOW": "true",
        "AUTHORIZE_EXTRA_ORIGINATOR": "Codex Desktop",
    },
    ProviderId.GOOGLE_ANTIGRAVITY: {
        "AUTHORIZE_URL": "https://accounts.google.com/o/oauth2/v2/auth",
        "TOKEN_URL": "https://oauth2.googleapis.com/token",
        "CLIENT_ID": "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
        "CLIENT_SECRET": "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",
        "REDIRECT_URI": "http://localhost:51121/oauth-callback",
        "SCOPES": (
            "https://www.googleapis.com/auth/cloud-platform "
            "https://www.googleapis.com/auth/userinfo.email "
            "https://www.googleapis.com/auth/userinfo.profile "
            "https://www.googleapis.com/auth/cclog "
            "https://www.googleapis.com/auth/experimentsandconfigs"
        ),
    },
}


@dataclass
class CallbackCapture:
    event: Event = field(default_factory=Event)
    code: str | None = None
    state: str | None = None
    error: str | None = None
    error_description: str | None = None


def _provider_env_prefix(provider: ProviderId) -> str:
    return f"DEV_CREW_OAUTH_{provider.value.upper().replace('-', '_')}_"


def _parse_scopes(raw: str | None) -> list[str]:
    if not raw:
        return []
    normalized = raw.replace(",", " ")
    return [item for item in normalized.split() if item]


def _extract_client_id_from_input(input_value: str) -> str:
    trimmed = str(input_value or "").strip()
    if not trimmed:
        raise RuntimeError("missing OpenAI client_id input")
    if "://" in trimmed:
        parsed = urlparse(trimmed)
        query = parse_qs(parsed.query)
        client_id = _first(query, "client_id")
        if not client_id:
            raise RuntimeError("client_id not found in pasted authorize URL")
        return client_id
    return trimmed


def _provider_config_from_env(
    provider: ProviderId,
    *,
    redirect_uri: str | None = None,
    environ: dict[str, str] | None = None,
) -> tuple[OAuthProviderConfig, str | None]:
    env = environ if environ is not None else os.environ
    prefix = _provider_env_prefix(provider)
    defaults = OPENCLAW_PROVIDER_DEFAULTS.get(provider, {})

    def _resolve(name: str) -> str | None:
        return env.get(f"{prefix}{name}") or defaults.get(name)

    required_keys = ("AUTHORIZE_URL", "TOKEN_URL", "CLIENT_ID")
    missing = [f"{prefix}{key}" for key in required_keys if not _resolve(key)]
    if missing:
        raise ValueError(f"missing required env var(s): {', '.join(missing)}")

    effective_redirect_uri = redirect_uri or _resolve("REDIRECT_URI") or "http://127.0.0.1:1455/callback"
    scopes_raw = env.get(f"{prefix}SCOPES") or defaults.get("SCOPES")
    authorize_params: dict[str, str] = {}
    extra_prefix = f"{prefix}AUTHORIZE_EXTRA_"
    for key, value in env.items():
        if key.startswith(extra_prefix) and value:
            param_name = key.removeprefix(extra_prefix).lower()
            authorize_params[param_name] = value
    for key, value in defaults.items():
        default_extra_prefix = "AUTHORIZE_EXTRA_"
        if key.startswith(default_extra_prefix) and value:
            param_name = key.removeprefix(default_extra_prefix).lower()
            authorize_params.setdefault(param_name, value)
    config = OAuthProviderConfig(
        provider=provider,
        authorize_url=_resolve("AUTHORIZE_URL") or "",
        token_url=_resolve("TOKEN_URL") or "",
        client_id=_resolve("CLIENT_ID") or "",
        scopes=_parse_scopes(scopes_raw),
        redirect_uri=effective_redirect_uri,
        authorize_params=authorize_params,
    )
    client_secret = env.get(f"{prefix}CLIENT_SECRET") or defaults.get("CLIENT_SECRET")
    return config, client_secret


def _first(query: dict[str, list[str]], key: str) -> str | None:
    values = query.get(key)
    if not values:
        return None
    return values[0]


def _resolve_callback_capture(capture: CallbackCapture, expected_state: str) -> tuple[str, str]:
    if capture.error:
        detail = capture.error_description or "no description"
        raise RuntimeError(f"provider returned error={capture.error}, detail={detail}")
    if capture.state != expected_state:
        raise RuntimeError("state mismatch in callback")
    if not capture.code:
        raise RuntimeError("authorization code not found in callback")
    return capture.code, capture.state


def _parse_manual_callback_input(input_value: str, expected_state: str) -> tuple[str, str]:
    trimmed = str(input_value or "").strip()
    if not trimmed:
        raise RuntimeError("missing OAuth redirect URL or authorization code")

    looks_like_redirect = (
        trimmed.startswith("http://")
        or trimmed.startswith("https://")
        or "://" in trimmed
        or "?" in trimmed
        or "&" in trimmed
    )
    if not looks_like_redirect:
        return trimmed, expected_state

    parsed_query: dict[str, list[str]]
    if trimmed.startswith("?"):
        parsed_query = parse_qs(trimmed[1:])
    elif "://" in trimmed:
        parsed_query = parse_qs(urlparse(trimmed).query)
    else:
        parsed_query = parse_qs(trimmed)

    error = _first(parsed_query, "error")
    if error:
        detail = _first(parsed_query, "error_description") or "no description"
        raise RuntimeError(f"provider returned error={error}, detail={detail}")

    code = _first(parsed_query, "code")
    state = _first(parsed_query, "state")
    if not code:
        raise RuntimeError("missing authorization code in pasted redirect URL")
    if not state:
        raise RuntimeError("missing state in pasted redirect URL")
    if state != expected_state:
        raise RuntimeError("invalid OAuth state in pasted redirect URL")
    return code, state


def _prompt_manual_input(*, redirect_uri: str, provided_input: str | None = None) -> str:
    if provided_input is not None:
        return provided_input
    print("Paste the redirect URL (or authorization code).")
    print(f"Example: {redirect_uri}?code=...&state=...")
    try:
        return input("> ").strip()
    except EOFError as exc:
        raise RuntimeError("manual input required but stdin is not interactive") from exc


def _prompt_openai_client_id(provided_input: str | None = None) -> str:
    if provided_input is not None:
        return _extract_client_id_from_input(provided_input)
    print("OpenAI Codex OAuth requires client_id.")
    print("Paste OpenClaw authorize URL or raw client_id.")
    try:
        return _extract_client_id_from_input(input("> ").strip())
    except EOFError as exc:
        raise RuntimeError("OpenAI client_id input required but stdin is not interactive") from exc


def _build_callback_handler(capture: CallbackCapture, callback_path: str) -> type[BaseHTTPRequestHandler]:
    class OAuthCallbackHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != callback_path:
                self.send_response(404)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"Not Found")
                return

            query = parse_qs(parsed.query)
            capture.code = _first(query, "code")
            capture.state = _first(query, "state")
            capture.error = _first(query, "error")
            capture.error_description = _first(query, "error_description")
            capture.event.set()

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            if capture.error:
                body = "<h1>Login failed</h1><p>Return to terminal to check details.</p>"
            else:
                body = "<h1>Login succeeded</h1><p>You can close this page now.</p>"
            self.wfile.write(body.encode("utf-8"))

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
            del format, args

    return OAuthCallbackHandler


def _start_callback_server(redirect_uri: str, capture: CallbackCapture) -> tuple[ThreadingHTTPServer, Thread]:
    parsed = urlparse(redirect_uri)
    if parsed.scheme != "http":
        raise ValueError("redirect_uri must use http scheme for local callback server")
    if not parsed.hostname:
        raise ValueError(f"redirect_uri has no hostname: {redirect_uri}")
    callback_path = parsed.path or "/"
    port = parsed.port or 80
    handler = _build_callback_handler(capture, callback_path=callback_path)
    server = ThreadingHTTPServer((parsed.hostname, port), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _exchange_authorization_code(
    *,
    provider_config: OAuthProviderConfig,
    code: str,
    code_verifier: str,
    client_secret: str | None,
    timeout_seconds: float,
) -> dict[str, Any]:
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": provider_config.client_id,
        "redirect_uri": provider_config.redirect_uri,
        "code_verifier": code_verifier,
    }
    if client_secret:
        payload["client_secret"] = client_secret

    response = httpx.post(
        provider_config.token_url,
        data=payload,
        headers={"Accept": "application/json"},
        timeout=timeout_seconds,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"token exchange failed ({response.status_code}): {response.text[:300]}"
        )
    try:
        return response.json()
    except ValueError as exc:
        raise RuntimeError("token exchange returned non-JSON response") from exc


def _write_status_file(
    *,
    path: str,
    provider: ProviderId,
    account_id: str,
    token_path: Path,
    pending_path: Path,
) -> None:
    status_payload = {
        "provider": provider.value,
        "account_id": account_id,
        "token_path": str(token_path),
        "pending_path": str(pending_path),
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }
    output = Path(path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(status_payload, ensure_ascii=True, indent=2), encoding="utf-8")
    try:
        output.chmod(0o600)
    except Exception:
        pass


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run OAuth login flow for dev-crew providers and persist tokens to file."
    )
    parser.add_argument(
        "--provider",
        required=True,
        choices=[provider.value for provider in ProviderId],
        help="OAuth provider id (openai-codex or google-antigravity).",
    )
    parser.add_argument("--account-id", default="default", help="Account profile key.")
    parser.add_argument(
        "--redirect-uri",
        default=None,
        help="Override callback URI (default: provider-specific OpenClaw-compatible URI).",
    )
    parser.add_argument(
        "--token-path",
        default=None,
        help="Override token store path (default: ~/.config/dev_crew/oauth_tokens.json).",
    )
    parser.add_argument(
        "--pending-path",
        default=None,
        help="Override pending session path (default next to token file).",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=300,
        help="Max seconds to wait for browser callback.",
    )
    parser.add_argument(
        "--http-timeout-seconds",
        type=float,
        default=15.0,
        help="HTTP timeout seconds for token exchange.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not auto-open browser. Print URL and wait for callback.",
    )
    parser.add_argument(
        "--remote",
        action="store_true",
        help="Remote/VPS mode. Open URL in local browser and paste redirect URL back to CLI.",
    )
    parser.add_argument(
        "--no-manual-fallback",
        action="store_true",
        help="Disable manual paste fallback when local callback does not auto-complete.",
    )
    parser.add_argument(
        "--manual-input",
        default=None,
        help="Pre-supplied redirect URL or authorization code for manual flow.",
    )
    parser.add_argument(
        "--openai-client-id",
        default=None,
        help="OpenAI client_id or full OpenAI authorize URL (for openai-codex provider).",
    )
    parser.add_argument(
        "--status-file",
        default=None,
        help="Optional status output JSON file (metadata only, no token values).",
    )
    return parser


def run(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    provider = ProviderId(args.provider)
    env_override = dict(os.environ)
    if provider == ProviderId.OPENAI_CODEX:
        prefix = _provider_env_prefix(provider)
        defaults = OPENCLAW_PROVIDER_DEFAULTS.get(provider, {})
        if args.openai_client_id:
            env_override[f"{prefix}CLIENT_ID"] = _extract_client_id_from_input(args.openai_client_id)
        elif not env_override.get(f"{prefix}CLIENT_ID") and not defaults.get("CLIENT_ID"):
            env_override[f"{prefix}CLIENT_ID"] = _prompt_openai_client_id()

    provider_config, client_secret = _provider_config_from_env(
        provider,
        redirect_uri=args.redirect_uri,
        environ=env_override,
    )
    token_store = FileTokenStore(args.token_path)
    oauth = OAuthCloneClient(
        {provider: provider_config},
        token_store=token_store,
        pending_store_path=args.pending_path,
    )

    if args.remote:
        print("You are running in remote/VPS mode.")
        print("A URL will be shown for LOCAL browser sign-in.")
        print("After sign-in, paste redirect URL (or authorization code) here.")
    else:
        print("Browser will open for OAuth authentication.")
        print("If callback does not auto-complete, paste redirect URL.")
        print(f"Callback URI: {provider_config.redirect_uri}")

    print("[1/5] Building authorization URL (PKCE)")
    start = oauth.start_login(provider, account_id=args.account_id)
    print("Authorization URL:")
    print(start.authorization_url)

    auth_code: str
    auth_state: str
    if args.remote:
        print("[2/5] Remote mode: open URL in LOCAL browser")
        manual_input = _prompt_manual_input(
            redirect_uri=provider_config.redirect_uri,
            provided_input=args.manual_input,
        )
        auth_code, auth_state = _parse_manual_callback_input(manual_input, start.state)
    else:
        print(f"[2/5] Starting callback server at {provider_config.redirect_uri}")
        capture = CallbackCapture()
        server: ThreadingHTTPServer | None = None
        server_thread: Thread | None = None
        callback_server_error: Exception | None = None
        try:
            server, server_thread = _start_callback_server(provider_config.redirect_uri, capture)
        except Exception as exc:
            callback_server_error = exc

        if callback_server_error is not None:
            if args.no_manual_fallback:
                raise RuntimeError(
                    f"failed to start callback server: {callback_server_error}"
                ) from callback_server_error
            print(
                "Callback server could not start; switching to manual paste flow. "
                f"reason={callback_server_error}"
            )
            if args.no_browser:
                print("[3/5] Browser auto-open disabled. Open URL manually.")
            else:
                print("[3/5] Opening browser")
                opened = webbrowser.open(start.authorization_url)
                if not opened:
                    print("Browser could not be opened automatically. Open URL manually.")
            manual_input = _prompt_manual_input(
                redirect_uri=provider_config.redirect_uri,
                provided_input=args.manual_input,
            )
            auth_code, auth_state = _parse_manual_callback_input(manual_input, start.state)
        else:
            try:
                if args.no_browser:
                    print("[3/5] Browser auto-open disabled. Open URL manually.")
                else:
                    print("[3/5] Opening browser")
                    opened = webbrowser.open(start.authorization_url)
                    if not opened:
                        print("Browser could not be opened automatically. Open URL manually.")

                print(f"[4/5] Waiting for callback (timeout={args.timeout_seconds}s)")
                if capture.event.wait(timeout=args.timeout_seconds):
                    try:
                        auth_code, auth_state = _resolve_callback_capture(capture, start.state)
                    except Exception:
                        if args.no_manual_fallback:
                            raise
                        print("OAuth callback was invalid; switching to manual paste flow.")
                        manual_input = _prompt_manual_input(
                            redirect_uri=provider_config.redirect_uri,
                            provided_input=args.manual_input,
                        )
                        auth_code, auth_state = _parse_manual_callback_input(manual_input, start.state)
                else:
                    if args.no_manual_fallback:
                        raise TimeoutError("callback timeout exceeded")
                    print("OAuth callback not detected; switching to manual paste flow.")
                    manual_input = _prompt_manual_input(
                        redirect_uri=provider_config.redirect_uri,
                        provided_input=args.manual_input,
                    )
                    auth_code, auth_state = _parse_manual_callback_input(manual_input, start.state)
            finally:
                if server is not None:
                    server.shutdown()
                    server.server_close()
                if server_thread is not None:
                    server_thread.join(timeout=1)

    print("[5/5] Exchanging code and saving token profile")
    try:
        profile = oauth.complete_login(
            state=auth_state,
            auth_code=auth_code,
            token_exchange=lambda **kwargs: _exchange_authorization_code(
                provider_config=kwargs["provider_config"],
                code=kwargs["code"],
                code_verifier=kwargs["code_verifier"],
                client_secret=client_secret,
                timeout_seconds=args.http_timeout_seconds,
            ),
        )
    except Exception:
        print("OAuth flow failed. Help: https://docs.openclaw.ai/start/faq")
        raise

    print(
        "Login complete: "
        f"provider={profile.provider.value}, account_id={profile.account_id}, token_path={token_store.path}"
    )
    pending_path = oauth.pending_store_path
    print(f"Pending-state file: {pending_path}")

    if args.status_file:
        _write_status_file(
            path=args.status_file,
            provider=profile.provider,
            account_id=profile.account_id,
            token_path=token_store.path,
            pending_path=pending_path,
        )
        print(f"Status file written: {Path(args.status_file).expanduser().resolve()}")

    return 0


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
