from __future__ import annotations

import subprocess
from dataclasses import dataclass
from typing import Sequence


@dataclass
class CommandResult:
    command: list[str]
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def run_command(command: Sequence[str], cwd: str) -> CommandResult:
    cmd = list(command)
    result = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    return CommandResult(
        command=cmd,
        returncode=result.returncode,
        stdout=result.stdout.strip(),
        stderr=result.stderr.strip(),
    )


def run_pytest(cwd: str) -> CommandResult:
    return run_command(["pytest", "-q"], cwd=cwd)


def run_ruff(cwd: str) -> CommandResult:
    return run_command(["ruff", "check", "."], cwd=cwd)


def run_mypy(cwd: str) -> CommandResult:
    return run_command(["mypy", "."], cwd=cwd)


def run_quality_suite(cwd: str, include_mypy: bool = False) -> dict[str, CommandResult]:
    results = {
        "pytest": run_pytest(cwd),
        "ruff": run_ruff(cwd),
    }
    if include_mypy:
        results["mypy"] = run_mypy(cwd)
    return results
