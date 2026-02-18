# AGENTS.md

## Worktree-First Rule (Mandatory)

이 저장소에서 Codex 에이전트는 `git worktree` 환경에서만 쓰기 작업을 수행한다.

- 금지: 메인 워킹트리(원본 체크아웃)에서의 파일 수정, 커밋, 브랜치 정리
- 허용: 메인 워킹트리에서는 읽기 전용 탐색/분석만 수행

## Start-of-Task Gate

작업 시작 시 아래 검증을 먼저 실행한다.

```bash
GIT_DIR="$(git rev-parse --git-dir)"; \
GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"; \
if [ "$GIT_DIR" = "$GIT_COMMON_DIR" ]; then
  echo "NOT_WORKTREE";
else
  echo "WORKTREE_OK";
fi
```

판정 기준:
- `WORKTREE_OK`: 작업 진행 가능
- `NOT_WORKTREE`: worktree 생성/이동 후 작업 실행

## Branch Policy

- 모든 작업 브랜치는 `codex/*` 접두사를 사용한다.
- PR 대상 기본 브랜치는 `main`이다.

## Safety Notes

- 사용자가 명시적으로 요청하지 않은 파괴적 명령(`git reset --hard`, `git clean -fd`, 대규모 `rm -rf`)은 금지한다.
- 예기치 않은 로컬 변경을 발견하면 즉시 중단하고 사용자 확인을 받는다.
