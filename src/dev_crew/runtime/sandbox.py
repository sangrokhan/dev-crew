from __future__ import annotations

import shlex
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


class SandboxExecutionError(RuntimeError):
    pass


@dataclass
class SandboxResult:
    command: list[str]
    returncode: int
    stdout: str
    stderr: str
    duration_ms: int
    sandbox: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


@dataclass
class DockerSandboxConfig:
    image: str = "python:3.13-slim"
    workdir: str = "/workspace"
    timeout_seconds: int = 120


class DockerSandboxExecutor:
    def __init__(self, config: DockerSandboxConfig) -> None:
        self.config = config

    def build_command(self, *, command: list[str], host_workspace: str) -> list[str]:
        workspace = str(Path(host_workspace).expanduser().resolve())
        quoted = " ".join(shlex.quote(part) for part in command)
        return [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{workspace}:{self.config.workdir}",
            "-w",
            self.config.workdir,
            self.config.image,
            "sh",
            "-lc",
            quoted,
        ]

    def run(self, *, command: list[str], host_workspace: str) -> SandboxResult:
        docker_command = self.build_command(command=command, host_workspace=host_workspace)
        started = time.monotonic()

        process = subprocess.run(
            docker_command,
            capture_output=True,
            text=True,
            check=False,
            timeout=self.config.timeout_seconds,
        )
        result = SandboxResult(
            command=docker_command,
            returncode=process.returncode,
            stdout=process.stdout.strip(),
            stderr=process.stderr.strip(),
            duration_ms=int((time.monotonic() - started) * 1000),
            sandbox="docker",
        )
        if not result.ok:
            raise SandboxExecutionError(
                f"docker sandbox command failed (rc={result.returncode}): "
                f"{' '.join(docker_command)}\n{result.stderr or result.stdout}"
            )
        return result
