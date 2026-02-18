from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class RepoContext:
    root: str
    files: list[str]
    directories: list[str]
    module_map: dict[str, list[str]]


def _list_files_with_rg(repo_root: Path) -> list[str]:
    result = subprocess.run(
        ["rg", "--files"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _list_files_fallback(repo_root: Path) -> list[str]:
    files: list[str] = []
    for current_root, _, filenames in os.walk(repo_root):
        for filename in filenames:
            abs_path = Path(current_root) / filename
            rel_path = abs_path.relative_to(repo_root).as_posix()
            files.append(rel_path)
    return files


def collect_repo_context(repo_root: str, max_files: int = 2000) -> RepoContext:
    root = Path(repo_root).resolve()
    files = _list_files_with_rg(root) or _list_files_fallback(root)
    files = sorted(files)[:max_files]

    directories = sorted({str((root / f).parent.relative_to(root).as_posix()) for f in files})
    module_map: dict[str, list[str]] = {}

    for file_path in files:
        top_level = file_path.split("/", 1)[0]
        module_map.setdefault(top_level, []).append(file_path)

    return RepoContext(
        root=str(root),
        files=files,
        directories=directories,
        module_map=module_map,
    )


def grep_repo(repo_root: str, pattern: str, max_matches: int = 200) -> list[str]:
    root = Path(repo_root).resolve()
    result = subprocess.run(
        ["rg", "-n", "--hidden", "--glob", "!.git", pattern],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.strip() or "rg failed")

    matches = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return matches[:max_matches]
