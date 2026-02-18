from pathlib import Path

from dev_crew.security.permissions import AccessMode, default_permission_policy
from dev_crew.tools.context import collect_repo_context, grep_repo


def test_collect_repo_context_builds_module_map(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "src" / "app.py").write_text("print('ok')\n", encoding="utf-8")
    (tmp_path / "tests" / "test_app.py").write_text("def test_ok():\n    assert True\n", encoding="utf-8")

    context = collect_repo_context(str(tmp_path))

    assert "src/app.py" in context.files
    assert "tests/test_app.py" in context.files
    assert "src" in context.module_map
    assert "tests" in context.module_map


def test_grep_repo_returns_matches(tmp_path: Path) -> None:
    file_path = tmp_path / "sample.txt"
    file_path.write_text("TODO: implement\nDONE: no\n", encoding="utf-8")

    matches = grep_repo(str(tmp_path), "TODO")

    assert matches
    assert "sample.txt:1:TODO: implement" in matches[0]


def test_permission_policy_allows_only_execution_agent_write() -> None:
    policy = default_permission_policy("backend")

    assert policy.mode_for("backend") == AccessMode.WRITE
    assert policy.mode_for("frontend") == AccessMode.READ_ONLY
    assert policy.can_write("backend") is True
    assert policy.can_write("leader") is False
