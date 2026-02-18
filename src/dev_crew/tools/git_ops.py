from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


class GitCommandError(RuntimeError):
    pass


@dataclass
class GitResult:
    command: list[str]
    returncode: int
    stdout: str
    stderr: str


def _run_git(args: list[str], cwd: str | None = None) -> GitResult:
    command = ["git", *args]
    result = subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    git_result = GitResult(
        command=command,
        returncode=result.returncode,
        stdout=result.stdout.strip(),
        stderr=result.stderr.strip(),
    )
    if result.returncode != 0:
        raise GitCommandError(
            f"git command failed: {' '.join(command)}\n{git_result.stderr or git_result.stdout}"
        )
    return git_result


def clone_repo(repo_url: str, destination: str) -> GitResult:
    destination_path = Path(destination).expanduser().resolve()
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    return _run_git(["clone", repo_url, str(destination_path)])


def fetch(repo_path: str, remote: str = "origin") -> GitResult:
    return _run_git(["fetch", "--prune", remote], cwd=repo_path)


def checkout(repo_path: str, branch: str, create: bool = False) -> GitResult:
    if create:
        return _run_git(["checkout", "-b", branch], cwd=repo_path)
    return _run_git(["checkout", branch], cwd=repo_path)


def create_worktree(repo_path: str, worktree_path: str, branch: str) -> GitResult:
    return _run_git(["worktree", "add", worktree_path, "-b", branch], cwd=repo_path)


def commit_all(repo_path: str, message: str) -> GitResult:
    _run_git(["add", "-A"], cwd=repo_path)
    return _run_git(["commit", "-m", message], cwd=repo_path)


def push(repo_path: str, branch: str, remote: str = "origin", set_upstream: bool = True) -> GitResult:
    args = ["push"]
    if set_upstream:
        args.append("-u")
    args.extend([remote, branch])
    return _run_git(args, cwd=repo_path)
