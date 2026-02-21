# 팀 오케스트레이션 실행 워크플로우

## 1. 목적

Team 모드의 운영 전 과정을 단일 참조점으로 정리한다.

- 대상 범위: `services/api`, `services/worker`, 파일 기반 SSOT
- 기준 API: `/v1/jobs/*`
- 기준 사양: `docs/CODEX_TEAM_IMPLEMENTATION_SPEC.md`
- 운영 가이드: `docs/TYPESCRIPT_OPERATIONS.md`

## 2. Dispatch(작업 분배)

### 2.1 시작 절차

1. `POST /v1/jobs` with `mode: "team"`
2. 템플릿 또는 사용자 제공 `teamTasks` 정규화
3. team state 초기 seed 수행
4. runnable task 계산 규칙(`blocked`/의존성)으로 실행 루프 진입

### 2.2 역할 체계

- Planner
- Researcher
- Designer
- Developer
- Executor
- Verifier

### 2.3 병렬 실행

- 한 루프에서 `parallelTasks` 상한까지만 배치 실행
- owner/claim 임시 배정 후 실행

## 3. Completion Tracking(완료 관리)

### 3.1 완료 후보 조건

- `queued == 0`
- `blocked == 0`
- `running == 0`

### 3.2 운영 완료 조건

- 위 기본 조건 충족
- verify 단계 통과
- 정책상 허용 실패 범주 충족

### 3.3 상태 갱신 규칙

- `failed`는 `maxFixAttempts`, `maxAttempts`로 `retry` 또는 `failed` 분기
- dead/non-reporting worker 감지 시 task 재배정

## 4. Collaboration(협의/협상)

### 4.1 현재 구현 범위

- mailbox 조회/발송
  - `GET /v1/jobs/{jobId}/team/mailbox`
  - `POST /v1/jobs/{jobId}/team/mailbox`
- 메시지 타입
  - `notice`, `question`, `instruction`, `reassign`
- 자동 처리 범위
  - 현재는 `reassign` 중심 자동화

### 4.2 분배/완료 가이드

- 협의 포인트는 task 상태/heartbeat/실행 완료 신호와 묶어 추적
- 요청/완료 상태는 Team state와 이벤트가 일치해야 함

## 5. 동기화/상태 규격

### 5.1 SSOT

- Team state: `.omx/state/jobs/<job-id>/record.json`
- 이벤트 로그: `.omx/state/jobs/<job-id>/events.jsonl`
- 이벤트는 append-only

### 5.2 동기화 체크포인트

- 상태 전환 시 즉시 저장
- resume/restart는 마지막 state 기준으로 재동기화
- 이벤트 및 상태 스냅샷은 감사 증적으로 보존

### 5.3 완료/중단/재개 인터페이스

- 완료: `waiting` 조건 해제 + verify 통과
- 종료: run 취소 신호 처리 후 task 정리
- 재개: `POST /v1/jobs/{jobId}/actions/resume`

## 6. 안정성: Lease, Heartbeat, Reassign

- heartbeart 누락/비정상 연속 시 non-reporting 전환
- claim lease 만료 또는 작업자 비정상 시 재할당
- 동일 task 중복 claim 방지 우선으로 상태 반영
- 재시도는 `Team state` 기반으로 멱등 동작

## 7. 승인 게이트

- `requiresApproval` 감지 시 run 상태를 `waiting_approval`로 전환
- 승인 액션
  - `POST /v1/jobs/{jobId}/actions/approve`
  - `POST /v1/jobs/{jobId}/actions/reject`
  - `POST /v1/jobs/{jobId}/actions/resume`

## 8. 종료/재개

- `cancel`, `resume`은 action API로 제어
- resume은 진행 중이던 task를 상태 기반으로 재큐

## 9. tmux 시각화(옵션)

- `options.team.tmuxVisualization=true`이면 역할별 pane 시각화와 attach 정보 발행
- 판단 기준은 tmux가 아닌 `/v1/jobs/{jobId}/team` 상태를 우선 사용

## 10. 운영 체크리스트

1. `GET /v1/jobs/{jobId}/team`에서 runnable/task 상태 확인
2. `events`에서 `team.task.started`, `team.task.completed`, `team.retry`, `team.task.approval_required` 확인
3. 승인 대기(`waiting_approval`) 시 action 처리 확인
4. `non-reporting`/lease 만료 시 재배정 경로 점검
5. `resume` 후 parallelTasks, deadlock 카운트, verify 경로 점검

## 11. 구현 전달용 상태(축약본)

### 현재 적용 요약

- Team role 템플릿 및 기본 실행 루프
- 상태 SSOT 및 이벤트 저장
- 승인/재개 action 처리
- task retry/fix loop
- tmux 시각화 옵션

### 후속 과제

- `/runs` 계열 정규 API 전환
- worker 간 질의/지시 자동 협의 라우팅 확장
- worktree 격리와 패치 병합 자동화 고도화
- structured output 파이프라인 강화

## 12. 동기화 규격 체크리스트(요약)

- SSOT 경로: `.omx/state/jobs/<job-id>/record.json`
- 이벤트: `events.jsonl` append-only
- task 동기화: dependency + blocked release + 집계
- heartbeat/non-reporting/reassign 반영
- 완료/재개/중단 루틴 일관성

## 13. 연계 문서

- 구현 사양: `docs/CODEX_TEAM_IMPLEMENTATION_SPEC.md`
- 운영 가이드: `docs/TYPESCRIPT_OPERATIONS.md`
- 운영 결정: `docs/DECISIONS.md`
