from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass


class GHUnavailableError(RuntimeError):
    pass


@dataclass
class PRResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def is_gh_available() -> bool:
    return shutil.which("gh") is not None


def create_pull_request(
    repo_path: str,
    title: str,
    body: str,
    base: str = "main",
    head: str | None = None,
    dry_run: bool = False,
) -> PRResult:
    if not is_gh_available():
        raise GHUnavailableError("gh CLI is not installed or not found in PATH")

    command = ["gh", "pr", "create", "--base", base, "--title", title, "--body", body]
    if head:
        command.extend(["--head", head])
    if dry_run:
        command.append("--dry-run")

    result = subprocess.run(
        command,
        cwd=repo_path,
        capture_output=True,
        text=True,
        check=False,
    )
    return PRResult(
        returncode=result.returncode,
        stdout=result.stdout.strip(),
        stderr=result.stderr.strip(),
    )
