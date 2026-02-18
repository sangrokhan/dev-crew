import json
from pathlib import Path

import httpx

from dev_crew.llm.models import ProviderId
from dev_crew.llm.provider_runner import HttpProviderRunner
from dev_crew.llm.token_store import FileTokenStore
from dev_crew.orchestration import CrewAIOrchestrator


def test_orchestrator_model_prefix_uses_custom_adapter(tmp_path: Path) -> None:
    token_store = FileTokenStore(
        str(tmp_path / "oauth.json"),
        workspace_root=str(tmp_path),
        allow_workspace_path=True,
    )
    orchestrator = CrewAIOrchestrator(
        workspace_root=str(tmp_path),
        dry_run=True,
        llm="codex-mini",
        manager_llm="antigravity-fast",
        token_store=token_store,
    )

    assert orchestrator._model_uses_custom_adapter("codex-mini") is True
    assert orchestrator._model_uses_custom_adapter("gpt-5-codex-mini") is True
    assert orchestrator._model_uses_custom_adapter("antigravity-fast") is True
    assert orchestrator._model_uses_custom_adapter("gemini-2.5-pro") is True
    assert orchestrator._model_uses_custom_adapter("ollama/llama3.1:8b") is False


def test_http_provider_runner_codex_parses_output_text() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/backend-api/codex/responses"
        assert request.url.params.get("client_version") == "0.1.0"
        assert request.headers["Authorization"] == "Bearer codex-token"
        assert request.headers["ChatGPT-Account-Id"] == "default"
        payload = json.loads(request.content.decode("utf-8"))
        assert payload["model"] == "codex-mini"
        assert payload["store"] is False
        assert payload["stream"] is True
        assert payload["instructions"]
        return httpx.Response(
            200,
            text='data: {"response":{"output":[{"content":[{"type":"output_text","text":"codex-ok"}]}]}}\n\n',
        )

    runner = HttpProviderRunner(
        account_id="default",
        transport=httpx.MockTransport(handler),
    )
    output = runner(
        provider=ProviderId.OPENAI_CODEX,
        api_key="codex-token",
        model="codex-mini",
        prompt="hello",
    )
    assert output == "codex-ok"


def test_http_provider_runner_antigravity_parses_sse() -> None:
    call_order = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_order["count"] += 1
        assert request.method == "POST"
        if request.url.path == "/v1internal:loadCodeAssist":
            return httpx.Response(200, json={"cloudaicompanionProject": "sample-project"})

        assert request.url.path == "/v1internal:streamGenerateContent"
        assert request.url.params.get("alt") == "sse"
        assert request.headers["Authorization"] == "Bearer anti-token"
        payload = json.loads(request.content.decode("utf-8"))
        assert payload["model"] == "antigravity-fast"
        assert payload["project"] == "sample-project"
        assert payload["request"]["contents"][0]["parts"][0]["text"] == "hello"
        sse_body = (
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"anti-"}]}}]}}\n\n'
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n'
            "data: [DONE]\n\n"
        )
        return httpx.Response(
            200,
            text=sse_body,
            headers={"content-type": "text/event-stream"},
        )

    runner = HttpProviderRunner(
        transport=httpx.MockTransport(handler),
    )
    output = runner(
        provider=ProviderId.GOOGLE_ANTIGRAVITY,
        api_key='{"token":"anti-token"}',
        model="antigravity-fast",
        prompt="hello",
    )
    assert call_order["count"] == 2
    assert output == "anti-\nok"
