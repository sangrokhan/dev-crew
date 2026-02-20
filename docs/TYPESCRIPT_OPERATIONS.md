# TypeScript 운영 가이드

## 기준
- Node.js: 20+
- API: `services/api`
- Worker: `services/worker`
- 상태 저장: 파일 기반 (`.omx/state/jobs`)
- Queue: `REDIS_URL` 설정 시 Redis + BullMQ, 미설정 시 파일 큐(`.omx/state/jobs/.queue`)

## 설치/실행
```bash
npm install
cp .env.example .env
PORT=8080 OMX_STATE_ROOT=$PWD/.omx/state/jobs npm run dev:local
```
또는 `.env`를 로드해서 실행:
```bash
export OMX_STATE_ROOT=$PWD/.omx/state/jobs
npm run dev:local
```
`npm install` 시 `postinstall`로 `setup-cli-paths`가 실행되어
`~/.codex|~/.claude|~/.gemini`의 `agents/skills`를
리포지토리 `config/cli/agents`, `config/cli/skills`로 연결합니다.

## CLI 설치 훅/실행 구조
- 공용 엔트리: `bin/dev-crew.mjs`
- 실행파일 기반 단축 엔트리: `bin/dev-crew-setup-cli-paths.mjs`
- 디스패처: `scripts/bin/dispatch.mjs`
- 경로 설정 로직: `scripts/setup-cli-paths.mjs`

수동 실행:
```bash
npm run setup:cli-paths
npm run setup:cli-paths:dry-run
node ./bin/dev-crew.mjs setup-cli-paths --strict
```

## 주요 환경변수
- `OMX_STATE_ROOT`
- `REDIS_URL` (Redis 큐 사용 시)
- `PORT`
- `API_PORT` (docker compose host publish port, default `8080`)
- `WORKER_CONCURRENCY`
- `WORK_ROOT`
- `TMUX_KEEP_SESSION_ON_FINISH`
- `JOB_SKIP_GIT_CLONE`
- `JOB_PLANNER_CMD`
- `JOB_RESEARCHER_CMD`
- `JOB_DESIGNER_CMD`
- `JOB_DEVELOPER_CMD`
- `JOB_EXECUTOR_CMD`
- `JOB_VERIFIER_CMD`
- `DEV_CREW_SKIP_CLI_PATH_SETUP` (`1|true`면 postinstall 경로 설정 스킵)
- `DEV_CREW_CODEX_HOME` (기본 `~/.codex`)
- `DEV_CREW_CLAUDE_HOME` (기본 `~/.claude`)
- `DEV_CREW_GEMINI_HOME` (기본 `~/.gemini`)
- `DEV_CREW_SHARED_AGENTS_DIR` (기본 `config/cli/agents`)
- `DEV_CREW_SHARED_SKILLS_DIR` (기본 `config/cli/skills`)

Team mode( `mode: "team"` )에서 추가로 사용하는 값:
- `options.team.parallelTasks`
- `options.team.maxFixAttempts`
- `options.team.teamTasks`

## tmux 동작
- Worker는 job 실행 시 세션을 만들고 `planner/executor/verifier` pane을 실행합니다.
- 이벤트 `tmux_session_started` payload의 `attachCommand`로 실시간 attach 가능합니다.
- `keepTmuxSession=false`면 종료 시 세션을 정리합니다.

Team 모드(`mode: "team"`)는 현재 `planner/researcher/designer/developer/executor/verifier` 역할 템플릿 기반으로 의존성 라운드 실행합니다.
- `options.team.parallelTasks`는 동시 실행 가능한 태스크 수의 상한입니다.
- 동일 라운드에서 `parallelTasks`개 만큼 `running`으로 전환한 뒤 병렬 실행합니다.
- 실행 상태는 `GET /v1/jobs/{jobId}/team` API로 확인합니다.

## 호스트 실행
```bash
PORT=8080 OMX_STATE_ROOT=$PWD/.omx/state/jobs npm run dev:local
```

중지: `Ctrl+C`

`PORT`로 단일 포트를 직접 제어합니다.
