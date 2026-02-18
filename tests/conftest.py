from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dev_crew.runtime.sandbox import DockerSandboxExecutor, SandboxResult


@pytest.fixture(autouse=True)
def _mock_docker_subprocess(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fake_run(
        self: DockerSandboxExecutor,
        *,
        command: list[str],
        host_workspace: str,
    ) -> SandboxResult:
        docker_command = self.build_command(command=command, host_workspace=host_workspace)
        return SandboxResult(
            command=docker_command,
            returncode=0,
            stdout="ok",
            stderr="",
            duration_ms=1,
            sandbox="docker",
        )

    monkeypatch.setattr(DockerSandboxExecutor, "run", _fake_run)
