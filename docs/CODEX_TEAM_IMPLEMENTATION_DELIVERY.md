# Codex Team 오케스트레이션 구현 문서 (Codex CLI 단독 운영 기준)

작성일: 2026-02-20  
버전: v0.1 (실행형 문서)

## 1) 목적

이 문서는 `oh-my-codex` 없이 순수 `codex` CLI만으로 Team 스타일 분업 오케스트레이션을 운영하기 위한
실행 설계와 현재 구현 상태를 정리한다.

목표:

- 사용자 입력(`POST /v1/jobs`)을 받아 작업을 큐에 적재
- 워커가 `codex` 실행 명령을 하위 에이전트 단위로 발행
- 팀 구성(Planner/Researcher/Designer/Developer/Executor/Verifier) 흐름을 상태머신으로 관리
- 장애/재시도/재개/승인 게이트를 운영 가능한 범위에서 구현
- 팀 모드에서 필요한 지표와 이벤트를 남기고 복구 가능하게 유지

## 2) 구조 요약 (현재 기준)

현재 저장소의 TypeScript 스택 기준:

- API: `services/api`
  - Job 생성/조회/액션(승인/취소/재개)/팀 상태 조회/SSE 이벤트 제공
  - 팀 상태를 `job.options.team.state` JSON에 보관
- Worker: `services/worker`
  - `REDIS_URL`이 있으면 Redis/BullMQ 큐, 없으면 파일 큐(`.omx/state/jobs/.queue`)로 Job 수신
  - 저장소(`job.options.team.state`)의 팀 상태를 읽고 팀 상태머신을 진행
- Codex CLI 실행은 `runCodexCommand()`로 래핑
- 상태 저장: 파일 기반 SSOT (`.omx/state/jobs/<jobId>/record.json`, `events.jsonl`)
- OpenAPI: `docs/openapi/openapi.v1.yaml`
    - `POST /v1/jobs`, `GET /v1/jobs/{jobId}/team`, `POST /v1/jobs/{jobId}/actions/{action}`, SSE 이벤트

## 3) 팀 실행 설계 (요구 기능별)

### 3.1 팀 역할 정의

역할은 다음 6종:
- `planner`
- `researcher`
- `designer`
- `developer`
- `executor`
- `verifier`

`teamTasks`는 `teamOptions`에서 템플릿으로 받거나 기본 템플릿을 사용한다.  
기본 템플릿은 Planner → Researcher/Designer 병렬 가능 → Developer → Executor → Verifier 흐름이다.

### 3.2 상태 모델

팀 상태를 `TeamRunState`로 관리한다.

- run
  - `status`: `queued | running | waiting_approval | succeeded | failed | canceled`
  - `phase`: 현재 실행 단계(예: planner, developer...)
  - `parallelTasks`: 한 루프에서 동시에 시도할 최대 작업 수
  - `fixAttempts`, `maxFixAttempts`
  - `currentTaskId`
- task
  - `id`, `name`, `role`, `dependencies`, `maxAttempts`, `timeoutSeconds`
  - `status`: `queued | running | succeeded | failed | blocked | canceled`
  - `attempt`, `startedAt`, `finishedAt`, `error`, `output`

### 3.3 상태 전이 규칙 (현재 구현 반영)

1. 새 Job 생성 시 팀 상태를 `defaultTeamState`로 초기화
2. 실행 루프에서:
   - 의존성 충족된 `queued`/`blocked` 작업을 `selectRunnableTasks`로 계산
   - 순차 실행
   - 실행 실패 시:
     - `maxAttempts` 미만이면 `queued`로 재시도
     - 초과면 `failed`
3. 실패 태스크 전파 및 복구
   - 모든 작업이 terminal일 때 실패가 있으면 `buildFailureRecoveryState` 적용
   - 실패 태스크와 그 하위 의존 태스크를 reset
   - `fixAttempts`를 증가시키고 `running`으로 되돌려 재시도 루프 진입
   - 최대치 초과 시 run 실패 처리
4. 더 이상 진행 불가 상태(실행중/대기없고 runnable 없음)에서:
   - 실패 존재 시 복구 경로 재시도
   - 실패 없으면 deadlock 카운팅 후 backoff
5. 승인 상태(`waiting_approval`)는 API 레벨에서 `approve/reject/resume` 처리

## 4) 핵심 구현 파일 (현재 기준)

### API

- `services/api/src/jobs/jobs.controller.ts`
  - `POST /v1/jobs`
  - `GET /v1/jobs/{jobId}`
  - `GET /v1/jobs/{jobId}/team`
  - `POST /v1/jobs/{jobId}/actions/{action}`
  - `GET /v1/jobs/{jobId}/events` (SSE)
- `services/api/src/jobs/jobs.service.ts`
  - 팀 템플릿 정규화
  - 팀 상태 기본값/병합/저장
  - 승인/재개/거절 처리
- `services/api/src/jobs/dto/create-job.dto.ts`
  - `options.team.parallelTasks/maxFixAttempts/teamTasks/agentCommands`
- `services/api/src/jobs/job.types.ts`
  - `teamRoles`, `modes` 타입 정의

### Worker

- `services/worker/src/index.ts`
  - 팀 작업 정규화/시드 생성 (`seedTeamStateFromOptions`)
  - 팀 상태 복원/저장 (`readTeamState`, `persistTeamState`)
  - 실행 루프 (`runTeamOrchestration`)
  - 역할별 codex 프롬프트 기본 템플릿 (`resolveRoleCommand`)
  - 이벤트 기록 (`addEvent`)

### 문서/스펙

- `docs/openapi/openapi.v1.yaml`
- `README.md`
- `docs/TYPESCRIPT_OPERATIONS.md`
- `docs/CODEX_TEAM_IMPLEMENTATION_SPEC.md`(기존 전체 범위 문서)

## 5) 무엇이 구현되어 있는지(현재 기준)

- [x] Team 역할 6종 확장(`planner/researcher/designer/developer/executor/verifier`)
- [x] 팀 태스크 템플릿 커스터마이징(`teamTasks`) 지원
- [x] Team 상태 JSON 저장/조회
- [x] Team 태스크 의존성 기반 실행 순서 제어
- [x] 태스크별 최대 시도 수 및 실패/재시도
- [x] 실패 체인(retry cascade) 기반 복귀(`buildFailureRecoveryState`)
- [x] 승인/재개 API 처리
- [x] SSE 이벤트 스트림
- [x] tmux 기반 실행은 비Team 모드에서 유지, Team 모드는 codex 단일 실행 경로

## 6) 현재 미완성 항목 (오픈)

- [x] `parallelTasks`가 실제 병렬 실행으로 동작
  - `TeamTask`를 배치 단위(`startTaskBatch`)로 `running` 상태 전환 후 `Promise.all` 병렬 실행
  - 종료 후 태스크별 patch 적용으로 상태 일괄 반영
- [ ] `parallelTasks` 동시성 상한에 대한 `backoff/jitter` 정밀 튜닝
- [ ] Team 역할이 완료/검증한 산출물을 structured JSON으로 파싱해 다음 단계가 읽는 파이프라인 연계 없음
- [ ] 승인 게이트를 태스크 단위로 세밀하게 분기하지 않음
- [ ] 작업자 하트비트/Lease 기반 claim 분산은 미구현
- [ ] team 작업 상태를 별도 정규형 테이블로 분리하지 않음(`Job.options.team.state` JSON 사용)
- [ ] tmux 시각화 모드에서 팀 역할별 멀티 pane 운영 미구현
- [ ] 재시작/크래시 복구에서 락 충돌 대응이 제한적
- [ ] 고급 관측 지표(Queue length, 실행 시간분포, 승인 대기시간) 미구현

## 7) 왜 팀 구조가 가능한가 (oh-my-codex 없이)

가능성 판단은 높음. 핵심은 “팀 오케스트레이터는 상태 저장 + 스케줄링 + 실행 위임”만 담당하고,
실제 추론/작업은 모두 `codex exec`에 위임하면 된다.

조건:

- `codex` CLI 실행 환경이 서버에서 사용 가능
- 템플릿 기반 프롬프트/환경변수로 역할별 컨텍스트 주입
- 상태 저장소가 단일 소스로 일관성 있게 유지
- 실패시 상태를 읽고 동일 태스크를 재실행할 수 있는 지점 보장

## 8) 구현 로드맵 (우선순위)

### 1단계(운영 안정화)
1. `services/worker/src/index.ts`의 Team loop를 true parallel 실행으로 전환
2. 팀 상태 직렬화 스키마 정규화(JSON schema + 실행 결과 검증)
3. 실패 결과를 기반으로 자동 검증 패스/리트라이 플래그 강화
4. 이벤트에 `taskId`, `attempt`를 일관성 있게 포함

### 2단계(기능 확장)
1. 역할별 승인 게이트/리전 규칙 구현
2. 팀별 작업자 워크트리 분리
3. 작업자 간 메일박스/브로드캐스트(미래용)
4. 작업 claim + heartbeat + deadline 복구

### 3단계(운영성)
1. TeamRun 전용 테이블 분리 (`TeamRun`, `TeamTask`, `TeamApproval` ...)
2. 대시보드 API (`/runs/{id}/tasks`, `/runs/{id}/workers`)
3. 지표/알람(실패율, 평균 회복시간, 승인 대기시간)

## 9) 작업 실행 절차

### 로컬 실행

```bash
npm install
cp .env.example .env
npm run dev:local
```

참고:
- `npm install` 시 `postinstall`에서 `setup-cli-paths`가 실행되어
  `~/.codex|~/.claude|~/.gemini`의 `agents/skills`를 `config/cli/*`로 연결한다.
- 자동 경로 설정을 끄려면 `DEV_CREW_SKIP_CLI_PATH_SETUP=1 npm install`을 사용한다.

### 팀 Job 실행 예시

```bash
curl -s -X POST http://localhost:8080/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "codex",
    "mode": "team",
    "repo": "org/repo",
    "ref": "main",
    "task": "상품 카드 정렬 기준 변경 후 테스트 추가",
    "options": {
      "team": {
        "parallelTasks": 2,
        "maxFixAttempts": 2
      },
      "agentCommands": {
        "planner": "codex exec --json --full-auto --skip-git-repo-check --cd \"$JOB_WORKDIR\" \"{TASK} / role={ROLE}\"",
        "researcher": "codex exec --json --full-auto --skip-git-repo-check --cd \"$JOB_WORKDIR\" \"research role={ROLE} for: {TASK}\"",
        "designer": "codex exec --json --full-auto --skip-git-repo-check --cd \"$JOB_WORKDIR\" \"design role={ROLE} for: {TASK}\"",
        "developer": "codex exec --json --full-auto --skip-git-repo-check --cd \"$JOB_WORKDIR\" \"implement role={ROLE} for: {TASK}\"",
        "executor": "codex exec --json --full-auto --skip-git-repo-check --cd \"$JOB_WORKDIR\" \"execute role={ROLE} for: {TASK}\"",
        "verifier": "codex exec --json --full-auto --skip-git-repo-check --cd \"$JOB_WORKDIR\" \"verify role={ROLE} for: {TASK}\""
      }
    }
  }'
```

## 10) 운영 체크리스트

- `team state` 조회(`/v1/jobs/{jobId}/team`)에서 `tasks[*].status`가 진행 중/실패/blocked를 정확히 반영하는지 확인
- 실패가 발생하면 `fixAttempts`가 증가하고, `team.retry` 이벤트가 남는지 확인
- `maxFixAttempts` 초과 시 Job status가 `failed`로 전환되는지 확인
- `resumable` 요구가 있으면 API `/v1/jobs/{jobId}/actions/resume` 호출 후 2회 이상 상태 일관성 확인
