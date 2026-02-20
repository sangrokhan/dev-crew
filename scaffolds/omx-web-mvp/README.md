# omx-web-mvp scaffold

`oh-my-codex` / `oh-my-claudecode` 스타일 오케스트레이션을 웹 요청으로 실행하기 위한 MVP 스캐폴드입니다.

## 포함 항목

- OpenAPI v1 스펙: `openapi/openapi.v1.yaml`
- Prisma 스키마: `prisma/schema.prisma`
- NestJS + Fastify API: `services/api`
- BullMQ Worker + tmux multi-pane 실행기: `services/worker`
- Docker Compose: `infra/docker-compose.yml`

## 핵심 동작

1. `POST /v1/jobs`로 작업 요청
2. API가 DB 저장 + BullMQ enqueue
3. Worker가 repo clone 후 `tmux session` 생성
4. `planner / executor / verifier`를 서로 다른 pane에서 실행
5. pane 로그를 DB 이벤트로 저장 (`GET /v1/jobs/:jobId/events`)
6. 필요하면 `tmux attach -t <session>`으로 직접 관찰

## 빠른 시작

```bash
cd scaffolds/omx-web-mvp
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate:dev
```

API 실행:

```bash
npm run dev:api
```

워커 실행:

```bash
npm run dev:worker
```

Swagger:

- http://localhost:8080/docs

## Docker 실행

```bash
cd scaffolds/omx-web-mvp/infra
docker compose up -d --build
```

## Job 생성 예시 (tmux pane 명령 포함)

```bash
curl -s -X POST http://localhost:8080/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "codex",
    "mode": "team",
    "repo": "Yeachan-Heo/oh-my-codex",
    "ref": "main",
    "task": "웹 요청 기반 실행 파이프라인 설계안과 구현 TODO를 정리해줘",
    "options": {
      "maxMinutes": 30,
      "keepTmuxSession": true,
      "agentCommands": {
        "planner": "codex exec --json --full-auto --skip-git-repo-check --cd \"$JOB_WORKDIR\" \"You are planner. Task: $JOB_TASK\"",
        "executor": "codex exec --json --full-auto --skip-git-repo-check --cd \"$JOB_WORKDIR\" \"You are executor. Task: $JOB_TASK\"",
        "verifier": "codex exec --json --full-auto --skip-git-repo-check --cd \"$JOB_WORKDIR\" \"You are verifier. Task: $JOB_TASK\""
      }
    }
  }'
```

이후 이벤트 스트림에서 `tmux_session_started` payload의 `attachCommand`를 확인해 접속합니다.

## 주요 환경 변수

- `WORK_ROOT` (기본: `/tmp/omx-web-runs`)
- `TMUX_KEEP_SESSION_ON_FINISH` (기본: `1`)
- `JOB_SKIP_GIT_CLONE` (기본: `0`)
- `JOB_PLANNER_CMD` / `JOB_EXECUTOR_CMD` / `JOB_VERIFIER_CMD`
- `JOB_CODEX_PLANNER_CMD` 등 provider+role 오버라이드

## 주의

- 이 스캐폴드는 구조 검증용 MVP입니다.
- 인증/권한, sandbox 격리, 비용 제한, 비밀값 관리, 멀티 테넌시는 추가 구현이 필요합니다.
