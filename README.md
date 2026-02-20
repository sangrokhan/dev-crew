# dev-crew (TypeScript)

TypeScript/NestJS + BullMQ + 파일 기반 실행 이력 저장소 기반 작업 오케스트레이션 서버입니다.
현재 루트 기준 운영 경로는 npm 워크스페이스(`services/api`, `services/worker`)입니다.

## Stack
- Node.js 20+
- TypeScript 5
- NestJS (API)
- BullMQ + Redis (기본 큐) 또는 `REDIS_URL` 미설정 시 파일 큐 폴백
- `.omx/state/jobs` 파일 기반 저장소 (`record.json`, `events.jsonl`)
- tmux (멀티 패널 실행)

## Quick Start
1. 의존성 설치
```bash
npm install
```
`npm install` 시 `postinstall`에서 CLI 경로 바인딩을 자동 실행합니다.
(`~/.codex`, `~/.claude`, `~/.gemini`의 `agents/skills` -> `config/cli/*`)

2. 환경 변수
```bash
cp .env.example .env
```

3. API + Worker 동시 실행(호스트, 단일 명령어)
```bash
PORT=8080 npm run dev:local
```

`api`와 `worker`가 하나의 터미널에서 동시에 실행됩니다. `REDIS_URL`은 큐 동기화 전용이며,
작업 상태는 `.omx/state/jobs` 아래 파일로 저장됩니다.
기본 `PORT=8080` 기준으로 `localhost:8080`에서 API가 기동됩니다.
`REDIS_URL`이 없으면 API/Worker가 파일 큐(`.omx/state/jobs/.queue`)로 동작합니다.

## 실행 가이드(운영 실무형)

### 1) 최소 실행 준비
- Node 20+, npm 10+ 권장
- 필수 바이너리: `codex`(필요 시 `gemini`, `claude`)
- tmux 설치 필요(Worker orchestration용)
- 환경변수 파일 준비

```bash
cp .env.example .env
npm install
```

### 2) 핵심 모드 실행(권장: 호스트 단일 포트)

```bash
PORT=8080 npm run dev:local
```

실행 효과
- API: `http://localhost:8080`
- Worker: `.omx/state/jobs` 기반 큐 사용(Redis 미설정 시)
- `/v1/jobs`로 작업 등록 후 내부 orchestration 수행

### 3) 팀(Task 분할) 모드 실행

1. 작업 등록
```bash
curl -s -X POST http://localhost:8080/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "codex",
    "mode": "team",
    "repo": "owner/repo",
    "ref": "main",
    "task": "요청사항을 팀 모드로 분해해 실행해줘",
    "options": {
      "keepTmuxSession": true,
      "maxMinutes": 60
    }
  }'
```

2. jobId 확인 후 상태 점검
```bash
curl -s http://localhost:8080/v1/jobs/{jobId}
curl -s http://localhost:8080/v1/jobs/{jobId}/team
curl -s http://localhost:8080/v1/jobs/{jobId}/events
```

3. tmux 상태 확인(필요 시 attach)
```bash
curl -s http://localhost:8080/v1/jobs/{jobId}/events | rg -n "tmux_session_started|attachCommand"
```

4. 필요한 경우 재개
```bash
curl -s -X POST http://localhost:8080/v1/jobs/{jobId}/actions/resume
```

### 4) 실행 중 모니터링

- 팀 상태 파일:
  - `.omx/state/team/<team-name>/tasks/`
  - `.omx/state/team/<team-name>/workers/`
  - `.omx/state/team/<team-name>/events.jsonl`
  - `.omx/state/team/<team-name>/monitor-snapshot.json`
- API 이벤트: `/v1/jobs/{jobId}/events`
- 검증 체크 기준:
  - `pending=0`, `blocked=0`, `in_progress=0`
  - verify 통과
  - 허용 실패 정책 충족

### 5) 종료 및 정리
- 서버 종료: 터미널에서 `Ctrl+C`
- tmux 남은 세션 정리(필요 시):
```bash
tmux ls
tmux kill-session -t <session-name>
```
- 작업 잔존 상태 정리(옵션):
```bash
rm -rf .omx/state/team/<team-name>
rm -rf .omx/state/jobs
```

> 파일 기반 모드는 복구/재시작에 유리합니다.  
> Redis를 사용하지 않아도 동작하도록 설계되어 있어 데이터 의존성은 최소화됩니다.

## Docker 단일 실행(호스트 포트 하나만 사용)

아래는 API/Worker를 한 번에 띄우는 Docker 실행입니다.

```bash
API_PORT=18080 npm run docker:up
```

Swagger: `http://localhost:18080/docs`

## Job 실행 예시
```bash
curl -s -X POST http://localhost:8080/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "codex",
    "mode": "team",
    "repo": "owner/repo",
    "ref": "main",
    "task": "plan 결과 기준으로 tmux 병렬 실행 후 결과를 동기화해줘",
    "options": {
      "maxMinutes": 30,
      "keepTmuxSession": true
    }
  }'
```

이후 `GET /v1/jobs/{jobId}/events`에서 `tmux_session_started` 이벤트의
`attachCommand`를 확인해 `tmux` 세션에 접속할 수 있습니다.

team 모드 실행 중 상태를 보기 위해서는 다음도 함께 확인합니다.

```bash
curl -s http://localhost:8080/v1/jobs/{jobId}/team
```

Team 모드 동작 범위와 현재 미완성 항목은 `docs/CODEX_TEAM_IMPLEMENTATION_DELIVERY.md`를 참고하세요.

`paused/requires approval` 상태에서 재개하려면 아래를 호출합니다.

```bash
curl -s -X POST http://localhost:8080/v1/jobs/{jobId}/actions/resume
```

## CLI Bin 구조
- `bin/dev-crew.mjs`: 공용 CLI 엔트리
- `bin/dev-crew-setup-cli-paths.mjs`: 실행 파일명 기반 단축 엔트리
- `scripts/bin/dispatch.mjs`: 실행 파일명/서브커맨드 디스패처
- `scripts/setup-cli-paths.mjs`: codex/claude/gemini 경로 바인딩 로직

경로 바인딩 수동 실행:
```bash
npm run setup:cli-paths
npm run setup:cli-paths:dry-run
node ./bin/dev-crew.mjs setup-cli-paths --strict
```

경로 바인딩 제어 환경변수:
- `DEV_CREW_SKIP_CLI_PATH_SETUP=1` (postinstall 자동 바인딩 비활성화)
- `DEV_CREW_CODEX_HOME`
- `DEV_CREW_CLAUDE_HOME`
- `DEV_CREW_GEMINI_HOME`
- `DEV_CREW_SHARED_AGENTS_DIR` (기본: `config/cli/agents`)
- `DEV_CREW_SHARED_SKILLS_DIR` (기본: `config/cli/skills`)

## Scripts
- `npm run setup:cli-paths`
- `npm run setup:cli-paths:dry-run`
- `npm run dev:local`
- `npm run dev:api`
- `npm run dev:worker`
- `npm run build`
- `npm run start:api`
- `npm run start:worker`
- `npm run docker:up`
- `npm run docker:down`

포트 충돌 시 Docker 실행 예시:
```bash
API_PORT=18080 npm run docker:up
```

## Directory
```text
bin/          # CLI 실행 파일 엔트리
config/       # 공용 CLI agents/skills 경로
scripts/      # CLI 디스패처/설정 스크립트
services/
  api/        # NestJS API
  worker/     # BullMQ worker + tmux orchestrator
docs/openapi/ # OpenAPI spec
infra/        # docker-compose
```

## Legacy Python Code
기존 Python 구현은 TypeScript 전환 과정에서 분리되었으며, 현재 레포에서 제거되어 있습니다.
신규 개발/운영 기준은 TypeScript 워크스페이스입니다.

자세한 운영 가이드는 `docs/TYPESCRIPT_OPERATIONS.md`를 참고하세요.
