# Codex CLI Team 오케스트레이션 구현 명세서

작성일: 2026-02-21  
대상: `oh-my-codex` 없이 순수 `codex` CLI + 외부 오케스트레이터로 Team 동작 구현

## 문서 동기화 기준 체크리스트 (2026-02-21)

- [x] Provider 스펙 동기화: `gemini`를 OpenAPI/실행 경로와 정렬
- [x] 팀 상태 저장소 경로 동기화: `.omx/state/jobs/<job-id>` 기준으로 정리
- [x] OpenAPI 스키마 정합성 정비: 문서 계약과 런타임 구현 정렬
- [x] 구현 미완료 항목 재정렬: 중복 항목을 P0~P3 우선순위로 통합
- [x] 통합 테스트 실행: 문서 동기화 반영 검증 (최종 단계)

### 우선순위 통합 체크리스트 (P0~P3)

- [x] P0: 팀 상태 저장소 경로 및 상태 스키마 정렬 (`.omx/state/jobs/<job-id>`)
- [x] P0: parallelTasks 병렬 실행 + backoff/jitter
- [x] P0: 태스크 claim lease/retry 복구 적용
- [x] P0: 태스크 단위 승인 게이트(`requiresApproval`) 감지
- [x] P1: 승인/리뷰 산출물을 다음 단계 입력으로 쓰는 구조화 파이프라인 (`DEPENDENCY_OUTPUTS` 기반)
- [ ] P1: 분산 worker 협업/메시지 큐 기반 재배정 경로 (미구현)
- [x] P2: 운영 지표/관측 이벤트 표준화 (`team.state.metrics` 및 `team.task.*` 이벤트)
- [x] P3: 통합 테스트 실행 (최종)

## 1. 문서 목적

이 문서는 아래 요구를 충족하기 위해 필요한 구현 항목을 누락 없이 정의한다.

> 본 문서는 현재 구현을 기준으로 정리한다. 기본 구현은 `Job.options.team.state`를 포함한 파일 기반 SSOT(`.omx/state/jobs`)를 사용한다.  
> 별도 영속 저장소 설계는 장기 확장 과제로 분리해 두었으며, 현재 미구현 범위에는 포함하지 않는다.

- `npm install` 이후 실행 가능한 구조.
- 외부 오케스트레이터가 `codex` CLI를 다중 워커로 제어.
- Planner 이후 필요 시 Research/Developer/Designer/Executor/Verifier로 분업.
- 상태 저장, 승인 게이트, 재시도, 검증 루프, 장애 복구, 운영 관측까지 포함.

이 문서는 구현 체크리스트 겸 아키텍처 사양서로 사용한다.

현재 구현 API 매핑(2026-02-21 기준):
- 실제 운영 엔드포인트는 `POST /v1/jobs` 중심(`GET /v1/jobs/{jobId}`, `GET /v1/jobs/{jobId}/team`, `POST /v1/jobs/{jobId}/actions/{action}`)이다.
- 본 문서의 `/runs/*` 표기는 확장형 목표 계약(정규화된 Team Run API)이다.

## 2. 범위와 전제

### 2.1 범위

- 포함:
  - Team 실행 모드 전체 라이프사이클.
  - API/Worker/이벤트/로그/운영 런북.
  - Codex CLI 호출 래퍼와 역할별 프롬프트 계약.
- 제외:
  - `oh-my-codex` 내부 코드 의존.
  - 특정 UI 프론트엔드 구현 상세.

### 2.2 핵심 전제

- 실행 엔진은 `codex` CLI (`codex exec`, `codex exec resume`, `codex review`, `codex mcp`).
- 팀 오케스트레이션 로직은 전부 외부 구현.
- `tmux`는 선택적 실행 토폴로지(가시화/수동 개입 용도), 핵심은 비대화식 `codex exec`.
- 기본 상태 저장소는 파일 기반(`.omx/state/jobs`), 큐/동기화는 `REDIS_URL` 설정 시 Redis/BullMQ, 미설정 시 파일 큐로 동작.

### 2.3 비기능 목표(SLO)

- 단일 Run의 오케스트레이터 장애 복구 가능(재시작 후 resume).
- 워커 실패/중단 시 유실 없이 재할당 가능.
- 동일 태스크 중복 실행 방지(Claim Lease + Version Lock).
- 이벤트 추적 가능(누가, 언제, 어떤 결정을 내렸는지).

## 3. 용어 정의

- `Run`: 하나의 Team 실행 단위.
- `Phase`: `plan -> research -> execute -> verify -> fix` 단계.
- `Task`: 워커에게 배정 가능한 최소 작업 단위.
- `Worker`: 역할(role)을 가진 Codex 실행 주체.
- `Claim`: Task 선점 잠금.
- `Mailbox`: 리더-워커/워커-워커 메시지 채널.
- `Checkpoint`: 재개(resume) 가능한 상태 스냅샷.

## 4. 목표 기능 목록(필수)

### 4.1 사용자 시나리오

1. 사용자가 Team Run 생성.
2. Planner가 작업 분해/의존성/수용 기준을 생성.
3. 필요 시 Research 워커 병렬 수행.
4. Developer/Designer/Executor가 구현.
5. Verifier가 검증 후 실패 시 Fix 루프 재진입.
6. 승인 정책이 필요한 단계에서 대기.
7. 완료 시 결과물/로그/아티팩트 반환.

### 4.2 필수 기능

- Run 생성/조회/취소/재개 API.
- 단계별 전이 규칙과 최대 재시도 제한.
- Task 생성/배정/클레임/완료/실패 처리.
- Worker heartbeat 및 liveness 감시.
- Mailbox 기반 협업 메시지.
- 승인 게이트(코드 변경 전/배포 전 등).
- Git 작업 격리(worktree 권장).
- 상세 이벤트 스트림(SSE 또는 WebSocket).
- 감사 로그(audit)와 운영 메트릭.

## 5. 아키텍처 개요

### 5.1 Control Plane

- `API Service`:
  - Run 수명주기 API 제공.
  - 승인/취소/수동 재시작 처리.
- `Orchestrator Engine`:
  - Phase 전이.
  - Task 스케줄링.
  - 워커 할당과 리밸런싱.
- `Policy Engine`:
  - 승인/샌드박스/명령 정책 강제.

### 5.2 Execution Plane

- `Worker Runtime Manager`:
  - `codex exec` 프로세스 기동/종료/재시작.
  - stdout/stderr/exit code 수집.
- `Session Manager`:
  - Codex 세션 ID/실행 인자/재개 메타데이터 보관.
- `Tmux Adapter`(선택):
  - 시각화용 pane 배치.
  - 수동 디버깅 보조.

### 5.3 Data Plane

- 파일 기반 상태 저장:
  - Run/Task/Approval/Checkpoint 상태를 `Job.options.team.state` JSON으로 저장.
- Artifact Storage:
  - 로그, 프롬프트, 응답, diff, 테스트 결과, 스크린샷 저장.
- Event Log:
  - 구조화 JSON 이벤트 append-only 기록.

## 6. 컴포넌트별 구현 요구사항

## 6.1 API Service

- 구현 항목:
  - `POST /runs/team`
  - `GET /runs/{runId}`
  - `POST /runs/{runId}/cancel`
  - `POST /runs/{runId}/resume`
  - `POST /runs/{runId}/approve`
  - `GET /runs/{runId}/events`
  - `GET /runs/{runId}/tasks`
  - `GET /runs/{runId}/workers`
- 필수 검증:
  - Idempotency-Key 지원.
  - 상태 전이 불변성 검사.
  - 승인 가능 상태 여부 검사.

## 6.2 Orchestrator Engine

- 구현 항목:
  - Phase 전이 상태머신.
  - Task 라우팅 알고리즘.
  - Task dependency unblock 처리.
  - fix loop 제한(`max_fix_attempts`).
- 필수 정책:
  - terminal phase에서 재전이 금지.
  - 승인 미완료 시 execute 진입 금지.
  - 실패 태스크에 대한 자동/수동 재할당 정책 분리.

## 6.3 Planner Module

- 구현 항목:
  - 사용자 목표를 구조화 계획으로 변환.
  - Task 목록, 의존성, 수용기준, 역할 매핑 출력.
- 출력 계약:
  - 엄격한 JSON Schema 검증.
  - 비어 있는 tasks 금지.
  - 순환 의존성 금지.

## 6.4 Research Module

- 구현 항목:
  - Research 필요 판단 규칙(정책/환경변수 기반).
  - 다중 researcher 병렬 수행.
  - 근거(source) 정규화 저장.
- 정책:
  - 결과를 Plan 보강 정보로 merge.
  - 신뢰도 점수(confidence) 저장.

## 6.5 Worker Runtime Manager

- 구현 항목:
  - Codex 워커 실행 wrapper.
  - 실행 타임아웃/재시도/취소 신호 처리.
  - 출력 파싱(`--json` 우선, 실패 시 `-o` 파일 fallback).
- 필수 보호:
  - 프로세스 orphan 정리.
  - 종료 코드 기반 분기.
  - stderr 과다 출력 시 로그 회전.

## 6.6 Session Registry

- 구현 항목:
  - 워커별 세션 식별자 저장.
  - resume 가능성 추적.
  - 세션-태스크-워커 매핑.
- 주의:
  - `ephemeral` 실행 시 resume 불가 플래그 기록.

## 6.7 Task Scheduler

- 구현 항목:
  - priority queue.
  - role affinity(역할 적합성 점수).
  - worker load balancing.
  - starvation 방지.
- 필수 제약:
  - blocked task는 claim 불가.
  - 동일 task 동시 claim 불가.

## 6.8 Mailbox Service

- 구현 항목:
  - direct message.
  - broadcast message.
  - delivered/notified 타임스탬프.
- 필수 동작:
  - 재전송 idempotency.
  - 미전달 메시지 재시도.

## 6.9 Approval Service

- 구현 항목:
  - 승인 요청 생성.
  - 승인/거절 기록.
  - 거절 시 rollback 또는 phase fail 처리.
- 정책 포인트:
  - `plan_approval_required`.
  - `code_change_approval_required`.
  - `deploy_approval_required`.

## 6.10 Git Workspace Manager

- 구현 항목:
  - run/worker별 worktree 생성/정리.
  - base branch 동기화.
  - 충돌 탐지/병합 전략.
- 권장:
  - `workspace/<run-id>/<worker-name>` 구조.
  - 공용 workspace 직접 수정 금지.

## 6.11 Policy Engine

- 구현 항목:
  - 명령 허용/금지 정책.
  - sandbox/approval 매핑.
  - provider별 제한 정책.
- 필수 금지:
  - destructive git 명령 기본 금지.
  - 승인 없는 외부 네트워크 액션 제한(설정 가능).

## 6.12 Observability Stack

- 구현 항목:
  - 구조화 로그(JSON).
  - 메트릭(Prometheus 호환).
  - trace span(run/phase/task/worker).
- 필수 지표:
  - run_success_rate
  - run_duration_seconds
  - task_failure_rate
  - worker_restart_count
  - approval_wait_seconds
  - fix_loop_count

## 7. 데이터 모델(현재 운영 기준)

현재 Team 오케스트레이션은 파일 기반 SSOT를 사용한다.

- 런타임 상태는 `Job.options.team.state` JSON에 저장되며, 팀 상태(`TeamRun`) 및 태스크 상태(`TeamTask`)가 여기에 반영된다.
- 실행/승인/실패 이벤트는 `Job`의 이벤트 로그(`events.jsonl`)로 추적한다.
- 추후 영속 저장소 분리는 별도 과제로 남긴다.

## 8. 상태머신 명세

## 8.1 Run/Phase 전이

- 허용 전이:
  - `plan -> research`
  - `plan -> execute`(research 생략 가능)
  - `research -> execute`
  - `execute -> verify`
  - `verify -> complete`
  - `verify -> fix`
  - `fix -> execute`
  - `fix -> failed`(최대 시도 초과)
  - `* -> canceled`(사용자 취소)

## 8.2 Task 전이

- 허용 전이:
  - `pending -> in_progress`
  - `blocked -> pending`(dependency 충족)
  - `in_progress -> completed`
  - `in_progress -> failed`
  - `pending|blocked|in_progress -> canceled`

## 8.3 Worker 상태 전이

- 허용 전이:
  - `idle -> booting -> working -> idle`
  - `working -> blocked`
  - `working|blocked -> failed`
  - `* -> stopped`

## 8.4 전이 불변성

- terminal run(`complete/failed/canceled`)에서 새 task 생성 금지.
- task owner 변경 시 version 증가 필수.
- claim lease 만료 시 owner 자동 해제.

## 9. Codex CLI 실행 계약

## 9.1 기본 호출 규칙

- 비대화식 표준:
  - `codex exec --json --skip-git-repo-check --cd "<workdir>" "<prompt>"`
- 출력 파일 fallback:
  - `codex exec -o "<last_message.txt>" ...`
- 승인/샌드박스:
  - 런 정책에 따라 `-a <policy>`, `--sandbox <mode>` 주입.

## 9.2 resume 규칙

- 세션 지속 모드일 때:
  - `codex exec resume <session-id> "<follow-up-prompt>"`
- resume 실패 시:
  - 새 세션으로 재기동 + 실패 이벤트 기록.

## 9.3 출력 파싱 규칙

- 1순위: `--json` 이벤트에서 종료 상태와 마지막 메시지 추출.
- 2순위: `-o` 파일 파싱.
- 파싱 실패 시:
  - raw stdout/stderr를 artifact로 저장하고 task 실패 처리.

## 9.4 워커 표준 환경변수

- `TEAM_RUN_ID`
- `TEAM_WORKER_NAME`
- `TEAM_WORKER_ROLE`
- `TEAM_TASK_ID`
- `TEAM_WORKTREE`
- `TEAM_PHASE`
- `TEAM_ATTEMPT`

## 10. 역할(Role) 계약과 출력 스키마

## 10.1 Planner 출력(JSON)

```json
{
  "plan_summary": "string",
  "tasks": [
    {
      "id": "T1",
      "subject": "string",
      "description": "string",
      "role": "planner|researcher|developer|designer|executor|verifier",
      "depends_on": ["T0"],
      "acceptance_criteria": ["..."],
      "requires_code_change": true
    }
  ],
  "risks": ["..."],
  "done_definition": ["..."]
}
```

## 10.2 Research 출력(JSON)

```json
{
  "findings": [
    {
      "topic": "string",
      "summary": "string",
      "sources": ["url-or-doc-ref"],
      "confidence": 0.0
    }
  ],
  "recommendations": ["..."]
}
```

## 10.3 Developer/Designer/Executor 출력(JSON)

```json
{
  "changes": ["file/path"],
  "commands": ["npm test"],
  "result_summary": "string",
  "follow_up": ["..."]
}
```

## 10.4 Verifier 출력(JSON)

```json
{
  "status": "pass|fail",
  "checks": [
    {
      "name": "lint|unit|integration|security",
      "status": "pass|fail",
      "details": "string"
    }
  ],
  "blocking_issues": ["..."],
  "evidence": ["artifact/path"]
}
```

## 11. 오케스트레이션 알고리즘(상세)

## 11.1 Run 시작

1. Run 레코드 생성.
2. 초기 체크포인트 저장.
3. Planner 워커 실행.
4. Planner 출력 스키마 검증.
5. Task 테이블 업서트.
6. research 필요 조건 평가 후 phase 전이.

## 11.2 Research 단계

1. research 역할 task들을 병렬 claim.
2. 완료된 리서치 결과를 plan context에 병합.
3. 미완료/실패 task 처리 정책 적용.
4. execute phase로 전이.

## 11.3 Execute 단계

1. `pending` + `dependency satisfied` task 선별.
2. 역할 적합 워커에 할당.
3. 워커 실행.
4. 성공 시 `completed`.
5. 실패 시 `failed`, retry 정책 적용.
6. 실행 단계 task가 모두 terminal이면 verify phase 진입.

## 11.4 Verify 단계

1. verifier task 생성 또는 기존 verifier task 재사용.
2. 검증 결과가 `pass`면 `complete`.
3. 검증 결과가 `fail`이면 `fix` phase로 전이.

## 11.5 Fix 루프

1. `currentFixAttempt + 1`.
2. 임계값 초과 시 `failed`.
3. 실패 원인으로 fix task 생성.
4. execute -> verify 재순환.

## 12. 동시성/락 설계

- Task claim:
  - optimistic lock(`version`) + unique active claim.
- Lease:
  - 기본 15분, heartbeat로 연장.
- Worker heartbeat:
  - 10~30초 간격.
  - 2회 연속 누락 시 non-reporting.
  - lease 만료 시 task 회수.

## 13. Mailbox 프로토콜

## 13.1 메시지 타입

- `ack`
- `status_update`
- `question`
- `instruction`
- `shutdown`

## 13.2 처리 규칙

- 수신자는 `deliveredAt` 업데이트 필수.
- 같은 메시지 재처리 방지를 위해 `messageId` 기준 idempotent 처리.
- 미배달 메시지에 대해 backoff 재알림.

## 14. 승인(Approval) 게이트

## 14.1 승인 트리거

- Plan 승인 필요.
- 코드 변경 승인 필요.
- 배포/외부 시스템 변경 승인 필요.

## 14.2 승인 결과 처리

- `approved`: phase 진행.
- `rejected`: fix 또는 failed.
- `expired`: waiting_approval 유지 후 타임아웃 정책 적용.

## 15. Git 전략

## 15.1 기본 정책

- Run 단위 베이스 브랜치 고정.
- Worker는 전용 worktree 사용.
- 직접 `main` 커밋 금지.

## 15.2 권장 흐름

1. 리더가 run branch 생성.
2. worker별 worktree 생성.
3. 작업 완료 후 리더 worktree로 patch/cherry-pick 병합.
4. 통합 검증 후 최종 commit.

## 15.3 충돌 처리

- 자동 병합 실패 시:
  - conflict task 자동 생성.
  - developer + verifier 재실행.

## 16. 에러/장애 복구 설계

## 16.1 복구 대상

- 오케스트레이터 프로세스 다운.
- 워커 프로세스 다운.
- DB 일시 장애.
- Redis/큐 장애.
- tmux 세션 유실(선택 모드).

## 16.2 복구 절차

1. 마지막 checkpoint 조회.
2. active claim 유효성 점검.
3. 만료 claim 회수.
4. 실행 중 task 재큐잉.
5. 워커 재기동 또는 세션 resume.
6. phase 재동기화.

## 16.3 종료 절차

- 정상 종료:
  - 실행 중 워커 종료 신호.
  - 미배달 메시지 처리.
  - artifact flush.
  - final checkpoint 저장.
- 강제 종료:
  - 프로세스 kill.
  - run 상태 `failed` 또는 `canceled`로 명시.

## 17. 보안/정책

## 17.1 샌드박스

- run 단위 `sandbox_mode`와 `approval_policy` 강제.
- 워커별 권한 분리:
  - planner/research/verifier는 기본 read-heavy.
  - executor만 write 권한.

## 17.2 비밀정보 보호

- 로그에서 토큰/키 마스킹.
- prompt/context 수집 시 민감 경로 제외.
- 승인 없는 외부 호출 제한.

## 17.3 금지 명령

- `git reset --hard`
- `git clean -fd`
- 무단 `rm -rf`
- 보호 브랜치 강제 push

## 18. 관측/감사

## 18.1 이벤트 타입 표준

- `run_created`
- `phase_changed`
- `worker_started`
- `worker_heartbeat`
- `task_created`
- `task_claimed`
- `task_completed`
- `task_failed`
- `approval_requested`
- `approval_resolved`
- `run_resumed`
- `run_canceled`
- `run_completed`
- `run_failed`

## 18.2 필수 아티팩트

- role별 prompt 파일.
- role별 raw output.
- 실행 명령 기록.
- 종료 코드 기록.
- 검증 리포트.
- 최종 요약 보고서.

## 19. 테스트 전략(누락 없이)

## 19.1 Unit Test

- phase transition validator.
- task claim/version lock.
- scheduler priority/affinity.
- prompt schema validator.
- approval gate logic.

## 19.2 Integration Test

- API -> Queue -> Worker -> DB end-to-end.
- planner 출력을 task로 반영.
- verify fail 후 fix loop 동작.
- resume 시 checkpoint 복원.

## 19.3 E2E Test

- 실제 `codex exec` 포함한 소규모 run.
- planner/research/developer/verifier 전 역할 실행.
- 취소/재개/승인 시나리오.

## 19.4 Failure Injection

- 워커 강제 종료.
- DB 일시 중단.
- claim lease 만료.
- stdout 파싱 실패.
- 명령 timeout.

## 19.5 성능/부하

- N run 동시 실행.
- run당 M task, K worker에서 대기열 지연 측정.
- 이벤트 스트림 백프레셔 검증.

## 19.6 보안 테스트

- 금지 명령 차단 검증.
- 비밀정보 마스킹 검증.
- 승인 우회 불가 검증.

## 20. API 계약(권장안)

## 20.1 Run 생성

- `POST /runs/team`
- request:
  - `provider`, `repo`, `ref`, `task`, `options`.
- response:
  - `runId`, `status`, `phase`.

## 20.2 Run 조회

- `GET /runs/{runId}`
- response:
  - run 상태, phase, fix attempt, 요약 메타.

## 20.3 Task 조회/조작

- `GET /runs/{runId}/tasks`
- `POST /runs/{runId}/tasks/{taskId}/retry`
- `POST /runs/{runId}/tasks/{taskId}/reassign`

## 20.4 승인

- `POST /runs/{runId}/approve`
- payload:
  - `decision: approved|rejected`
  - `phase`
  - `taskId(optional)`
  - `reason`

## 20.5 이벤트 스트림

- `GET /runs/{runId}/events` (SSE)
- 필드:
  - `eventId`, `type`, `timestamp`, `payload`.

## 21. 저장소 적용 매핑(현재 `dev-crew` 기준)

## 21.1 API 계층

- 추가 권장:
  - `services/api/src/team/team.module.ts`
  - `services/api/src/team/team.controller.ts`
  - `services/api/src/team/team.service.ts`
  - `services/api/src/team/dto/*`

## 21.2 Worker 계층

- 확장 대상:
  - `services/worker/src/index.ts`
- 분리 권장:
  - `services/worker/src/team/runtime.ts`
  - `services/worker/src/team/scheduler.ts`
  - `services/worker/src/team/codex-runner.ts`
  - `services/worker/src/team/state-machine.ts`
  - `services/worker/src/team/mailbox.ts`

## 21.3 저장소 확장(운영 적용 전)

- 현재 적용: `Job.options.team.state` 파일 스토리지 + 이벤트 로그
- 미적용 확장 항목:
  - 별도 관계형 스토리지 도입
  - 별도 migration/seed 운영

## 21.4 계약 문서

- 추가 권장:
  - `openapi/team.yaml`
  - `docs/TEAM_RUNBOOK.md`
  - `docs/TEAM_PROMPT_CONTRACT.md`

## 22. 단계별 구현 계획(MVP -> Production)

## 22.1 MVP(필수)

- planner/executor/verifier 3역할 고정.
- 단일 run 동시성.
- 기본 task 상태머신.
- run 생성/조회/취소 API.
- `codex exec` 실행 래퍼.
- 단순 이벤트 로그.

## 22.2 V1

- research/developer/designer 역할 확장.
- approval 게이트.
- claim lease + heartbeat.
- fix loop 자동화.
- SSE 실시간 이벤트.

## 22.3 V2

- worktree 격리 기본화.
- resume/checkpoint 완성.
- mailbox/direct/broadcast.
- 관측 대시보드/알람.
- 장애 자동 복구 강화.

## 23. Definition of Done 체크리스트

### 23.1 기능

- [ ] Team Run 생성/조회/취소/재개가 동작한다.
- [ ] planner 출력이 JSON schema 검증을 통과한다.
- [ ] task dependency가 정확히 해제된다.
- [ ] verifier 실패 시 fix loop로 재진입한다.
- [ ] max fix attempt 초과 시 run 실패로 종료한다.

### 23.2 안정성

- [ ] 오케스트레이터 재시작 후 run 복구가 된다.
- [ ] 워커 비정상 종료 시 task 재할당이 된다.
- [ ] claim lease 만료 시 중복 실행이 발생하지 않는다.

### 23.3 보안/정책

- [ ] 승인 없는 민감 단계 진입이 차단된다.
- [ ] 금지 명령이 차단된다.
- [ ] 로그 마스킹이 동작한다.

### 23.4 관측

- [ ] run/task/worker 단위 이벤트가 모두 기록된다.
- [ ] 실패 원인을 이벤트와 로그로 추적할 수 있다.
- [ ] 핵심 메트릭이 수집된다.

### 23.5 테스트

- [ ] unit/integration/e2e/failure 테스트가 CI에서 통과한다.
- [ ] 최소 1개 실제 Codex provider E2E가 통과한다.

## 24. 운영 런북(필수 절차)

## 24.1 Run 멈춤(진행 안 됨)

1. run phase와 pending task 확인.
2. worker heartbeat 최근 시각 확인.
3. active claim lease 만료 여부 확인.
4. stuck worker 강제 중지 후 task 재할당.
5. 필요 시 run resume.

## 24.2 반복 실패

1. verifier blocking issue 추출.
2. fix attempt 횟수 확인.
3. 동일 원인 재발이면 정책 실패로 분류.
4. planner 재생성 또는 수동 개입.

## 24.3 취소

1. cancel 요청 기록.
2. 모든 워커 종료 신호.
3. 실행 중 task를 canceled로 전이.
4. artifact flush 후 run 종료.

## 25. 리스크와 대응

- Codex CLI JSON 이벤트 포맷 변경 가능성.
  - 대응: parser versioning + fallback parser.
- provider별 응답 편차.
  - 대응: 역할별 schema 강제 및 retry prompt.
- 워크트리 충돌/누수.
  - 대응: run 종료 시 GC와 orphan scanner.
- 장기 실행 비용 증가.
  - 대응: budget guard, timeout, stop-on-failure 정책.

## 26. 즉시 구현 우선순위(실행 순서)

1. TeamRun 상태머신 모듈 구현.
3. Codex runner 래퍼(`exec`, `resume`, output parse) 구현.
4. Planner 출력 스키마 검증기 구현.
5. Task scheduler + claim lease 구현.
6. API 엔드포인트 추가.
7. Verifier/fix loop 구현.
8. Checkpoint/resume 구현.
9. Mailbox/approval/관측 확장.
10. E2E/장애 복구 테스트 완료.

## 27. 세부 WBS(원자 작업 단위)

### 27.1 팀 상태 저장소 계층

- [x] `Job.options.team.state` 기반 상태 저장 규격 정리
- [x] 팀 이벤트 추적(`events.jsonl`) 기반 감사/추적 체계 적용
- [ ] 상태 저장소 분리(별도 영속 계층 전환) 필요 시 정책 문서화

### 27.2 API(NestJS)

- [ ] `services/api/src/team/team.module.ts` 생성.
- [ ] `services/api/src/team/team.controller.ts` 생성.
- [ ] `services/api/src/team/team.service.ts` 생성.
- [ ] DTO: `create-team-run.dto.ts` 생성.
- [ ] DTO: `approve-team-run.dto.ts` 생성.
- [ ] DTO: `reassign-task.dto.ts` 생성.
- [ ] `POST /runs/team` 구현.
- [ ] `GET /runs/{runId}` 구현.
- [ ] `GET /runs/{runId}/tasks` 구현.
- [ ] `GET /runs/{runId}/workers` 구현.
- [ ] `POST /runs/{runId}/cancel` 구현.
- [ ] `POST /runs/{runId}/resume` 구현.
- [ ] `POST /runs/{runId}/approve` 구현.
- [ ] `POST /runs/{runId}/tasks/{taskId}/retry` 구현.
- [ ] `POST /runs/{runId}/tasks/{taskId}/reassign` 구현.
- [ ] `GET /runs/{runId}/events` SSE 구현.
- [ ] Idempotency-Key 처리 미들웨어 추가.
- [ ] API 입력 JSON schema 검증기 추가.
- [ ] API 에러 코드 표준화(`TEAM_*`).

### 27.3 Worker 런타임

- [ ] `services/worker/src/team/runtime.ts` 생성.
- [ ] `services/worker/src/team/codex-runner.ts` 생성.
- [ ] `services/worker/src/team/scheduler.ts` 생성.
- [ ] `services/worker/src/team/state-machine.ts` 생성.
- [ ] `services/worker/src/team/mailbox.ts` 생성.
- [ ] `services/worker/src/team/claim-lease.ts` 생성.
- [ ] `services/worker/src/team/checkpoint.ts` 생성.
- [ ] `services/worker/src/team/prompt-builder.ts` 생성.
- [ ] `services/worker/src/index.ts`에서 팀 오케스트레이터 엔트리 연결.
- [ ] `codex exec` 커맨드 빌더 구현.
- [ ] `codex exec resume` 커맨드 빌더 구현.
- [ ] `--json` 파서 구현.
- [ ] `-o` 파일 fallback 파서 구현.
- [ ] timeout/kill 시그널 핸들러 구현.
- [ ] orphan 프로세스 수거기 구현.
- [ ] worker heartbeat writer 구현.
- [ ] dead worker 탐지기 구현.
- [ ] task requeue 로직 구현.
- [ ] role affinity 기반 task 할당 구현.
- [ ] dependency 해제 로직 구현.
- [ ] fix loop 카운터 및 종료 조건 구현.

### 27.4 Plan/Research/Role Prompt 계약

- [ ] planner 프롬프트 템플릿 작성.
- [ ] researcher 프롬프트 템플릿 작성.
- [ ] developer 프롬프트 템플릿 작성.
- [ ] designer 프롬프트 템플릿 작성.
- [ ] executor 프롬프트 템플릿 작성.
- [ ] verifier 프롬프트 템플릿 작성.
- [ ] role별 출력 JSON schema 파일 작성.
- [ ] schema validator 구현.
- [ ] invalid schema 재프롬프트 정책 구현.
- [ ] 프롬프트 버전(`prompt_version`) 저장.

### 27.5 승인/정책/보안

- [ ] approval state machine 구현.
- [ ] plan 승인 게이트 구현.
- [ ] code change 승인 게이트 구현.
- [ ] deploy 승인 게이트 구현(확장 슬롯).
- [ ] 명령 allow/deny evaluator 구현.
- [ ] destructive 명령 차단 레이어 구현.
- [ ] 로그 민감정보 마스킹 구현.
- [ ] 환경변수 secret redaction 구현.
- [ ] audit 이벤트 사양 구현.

### 27.6 Git/Worktree

- [ ] run 시작 시 리더 worktree 생성.
- [ ] worker별 worktree 생성기 구현.
- [ ] base branch 동기화 정책 구현.
- [ ] worker 결과 수집(cherry-pick/patch) 전략 구현.
- [ ] merge conflict 감지 및 conflict task 생성 구현.
- [ ] run 종료 후 worktree GC 구현.
- [ ] 실패 잔존 worktree 청소 스케줄러 구현.

### 27.7 관측/운영

- [ ] run/task/worker 구조화 로그 포맷 확정.
- [ ] 이벤트 스트림 저장소 구현.
- [ ] Prometheus 메트릭 exporter 추가.
- [ ] trace id 전파(run_id/task_id/worker_id) 구현.
- [ ] 알람 규칙(장기 pending/dead worker/loop 초과) 구성.
- [ ] 운영 대시보드(성공률/지연/실패원인) 구성.
- [ ] 운영 런북 문서화.

### 27.8 테스트/품질

- [ ] 상태머신 unit test.
- [ ] claim lease unit test.
- [ ] scheduler unit test.
- [ ] prompt schema validator unit test.
- [ ] API contract integration test.
- [ ] 상태 저장소 마이그레이션/복구 테스트.
- [ ] worker process integration test.
- [ ] fix loop e2e test.
- [ ] approval 대기/거절 e2e test.
- [ ] resume 복구 e2e test.
- [ ] cancel 도중 종료 e2e test.
- [ ] failure injection test(프로세스 kill, 상태 저장소 단절, timeout).
- [ ] load test(동시 run) 작성.
- [ ] security test(금지 명령, 마스킹, 권한) 작성.

### 27.9 CI/CD

- [ ] `npm run build` CI 단계 강화.
- [ ] CI에서 상태 저장소 마이그레이션 없이도 회귀 테스트 유지.
- [ ] unit/integration/e2e 분리 실행 파이프라인 구성.
- [ ] flaky test 재시도 정책 추가.
- [ ] PR 템플릿에 Team 변경 점검 항목 추가.
- [ ] 릴리즈 노트 자동 생성 규칙 추가.

## 28. 환경변수 명세(권장 기본값)

- `TEAM_RUNNER_PROVIDER`: `codex`
- `TEAM_MAX_WORKERS`: `6`
- `TEAM_MAX_FIX_ATTEMPTS`: `3`
- `TEAM_TASK_CLAIM_LEASE_MS`: `900000`
- `TEAM_HEARTBEAT_INTERVAL_MS`: `15000`
- `TEAM_HEARTBEAT_GRACE_MS`: `45000`
- `TEAM_RUN_TIMEOUT_MINUTES`: `60`
- `TEAM_ENABLE_RESEARCH_PHASE`: `1`
- `TEAM_REQUIRE_PLAN_APPROVAL`: `0`
- `TEAM_REQUIRE_CODE_APPROVAL`: `0`
- `TEAM_ENABLE_WORKTREE_ISOLATION`: `1`
- `TEAM_WORKTREE_ROOT`: `.worktrees/team`
- `TEAM_EVENT_RETENTION_DAYS`: `30`
- `TEAM_ARTIFACT_ROOT`: `.dev_crew/artifacts`
- `TEAM_DEFAULT_MODEL_PLANNER`: `gpt-5-codex`
- `TEAM_DEFAULT_MODEL_EXECUTOR`: `gpt-5-codex`
- `TEAM_DEFAULT_MODEL_VERIFIER`: `gpt-5-codex`
- `TEAM_CODEX_JSON_MODE_REQUIRED`: `0`
- `TEAM_CODEX_OUTPUT_FALLBACK`: `1`

## 29. 에러 코드 규격(권장)

- `TEAM_INVALID_STATE_TRANSITION`
- `TEAM_APPROVAL_REQUIRED`
- `TEAM_APPROVAL_REJECTED`
- `TEAM_TASK_NOT_FOUND`
- `TEAM_TASK_ALREADY_CLAIMED`
- `TEAM_TASK_BLOCKED_BY_DEPENDENCY`
- `TEAM_WORKER_NOT_FOUND`
- `TEAM_WORKER_DEAD`
- `TEAM_WORKER_TIMEOUT`
- `TEAM_CODEX_EXEC_FAILED`
- `TEAM_CODEX_OUTPUT_PARSE_FAILED`
- `TEAM_CHECKPOINT_RESTORE_FAILED`
- `TEAM_RUN_TIMEOUT`
- `TEAM_RUN_CANCELLED`

## 30. 최소 OpenAPI 정의 항목

- [ ] `POST /runs/team` 요청/응답 스키마 명시.
- [ ] `GET /runs/{runId}` 응답에 `phase`, `fixAttempt`, `summary` 포함.
- [ ] `GET /runs/{runId}/tasks`에 pagination/query(status, role) 포함.
- [ ] `GET /runs/{runId}/workers`에 heartbeat/liveness 포함.
- [ ] `POST /runs/{runId}/approve`에 decision enum 포함.
- [ ] `GET /runs/{runId}/events`의 SSE payload schema 포함.
- [ ] 표준 에러 응답(`code`, `message`, `details`) 포함.

## 31. 구현 완료 판정 게이트(릴리즈 블로커)

- [ ] blocker 버그 0개.
- [ ] run 성공률 목표치 달성(예: 95% 이상, 내부 기준).
- [ ] dead worker 자동 복구 시나리오 통과.
- [ ] approval 우회 시나리오 차단 확인.
- [ ] 데이터 정합성 점검(task 중복 claim 없음) 통과.
- [ ] 로그/메트릭/트레이스 3종 관측 확인.
- [ ] 운영 런북 리허설 완료.

---

이 문서는 `oh-my-codex`가 없는 순수 Codex CLI 환경에서 Team 수준 오케스트레이션을 구현하기 위한 기준 사양이다. 구현 시 변경이 발생하면 본 문서를 단일 소스로 갱신한다.
