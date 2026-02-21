# oh-my-codex 팀 상태 동기화 구현 규격

## 문서 동기화 기준 체크리스트 (2026-02-21)

- [x] Provider 스펙 동기화: `gemini`를 OpenAPI/실행 경로와 정렬
- [x] 팀 상태 저장소 경로 동기화: SSOT를 `.omx/state/jobs/<job-id>/`로 고정
- [x] OpenAPI 스키마 정합성 정비: 이벤트/상태 스키마와 구현 동작 정렬
- [x] 구현 미완료 항목 정렬: 중복 항목을 P0~P3 우선순위로 통합
- [x] 통합 테스트 실행: 문서 기준 회귀 항목 점검 완료

이 문서는 팀 모드(`omx team`)의 동기화 및 실행 제어 동작을 기능 관점으로 정리한다.

## 1. 동기화 목적

- 팀 실행의 단일 진실 원천(SSOT)을 유지한다.
- 중단/장애/재시작 시에도 동일 상태에서 복구가 가능해야 한다.
- worker/leader 협업을 파일, heartbeat, 이벤트를 통해 예측 가능하게 동기화한다.

## 2. 상태 저장소 구조

팀 상태는 `.omx/state/jobs/<job-id>/record.json`에서 관리한다. 최소 저장 단위:
- `record.json` (`team.state`를 포함한 단일 SSOT)
- `events.jsonl`
- `Job` 메타데이터(모드/상태/요청 원본/worker 설정)

### 우선순위 통합 체크리스트 (P0~P3)

- [x] P0: `.omx/state/jobs/<job-id>/record.json` SSOT 고정
- [x] P0: claim lease 회수/refresh 로직을 오케스트레이션 루프에 반영
- [x] P0: 승인 게이트(태스크 승인 요구) 상태 기록 체계 반영
- [x] P1: 작업자 heartbeat 기반 non-reporting 정합성 처리 강화
- [x] P1: worker/태스크 재배정 규칙의 고도화
- [x] P2: 옵션 기반 Team tmux 역할별 시각화(`options.team.tmuxVisualization`) 반영
- [x] P2: 이벤트 카테고리 일관성(`team.task.approval_required` 등) 정리
- [x] P3: 통합 테스트 실행

## 3. 실행 동작 규격

### 3.1 시작
1. 팀 시작 요청 수신
2. TMUX/환경 충돌 검사
3. 팀 설정 초기화
4. worker 수를 반영한 seed task 기반 스케줄링
5. worker별 실행 셸/인박스 생성 후 트리거 전달
6. `options.team.tmuxVisualization=true`이면 역할별 pane 시각화 세션을 생성하고 `tmux_session_started` 이벤트를 발행

### 3.2 Task 배정
- `assignTask(team, worker, taskId)` 실행
- 배정 전 조건
  - task 상태가 할당 가능해야 함
  - blocked dependency가 충족되어야 함
  - 정책 플래그(`delegation_only`, `plan_approval_required`) 위반이 없어야 함
- 배정 후 task owner를 worker로 설정하고 클레임을 기록함

### 3.3 Task 재배정
- `reassignTask(team, taskId, fromWorker, toWorker)` 실행
- dead/non_reporting worker에서 처리되지 않는 task를 안전하게 이관
- 기존 배정 상태를 정리하고 새 배정 상태를 원자적으로 저장

### 3.4 모니터링
- `monitorTeam()`이 worker 상태 + task 상태를 주기적으로 읽음
- 집계 항목:
  - `total`, `queued`, `running`, `blocked`, `succeeded`, `failed`, `canceled`
- 집계 결과는 API 응답과 모니터 상태 계산 경로에서 실시간 계산
- 반복 집계는 delta 비교로 경고/중복 로그를 억제

### 3.5 완료 판정
- 기본 후보 조건
  - `queued == 0`
  - `blocked == 0`
  - `running == 0`
- 운영 승인 조건
  - verify 단계 통과
  - 실패 정책 상 `failed`가 허용 범위 내일 것
- 실패 조건
  - 반복 가능한 조건 반복 초과 또는 정책 위반

## 4. 메시지/이벤트 처리

- `mailbox`는 leader-worker 및 worker-worker 간 제어 신호 채널이다.
- 이벤트는 append-only `events.jsonl`에 누적 저장한다.
- 주요 이벤트
  - `team.task.started`
  - `team.task.completed`
  - `team.task.retry`
  - `team.retry`
  - `team.waiting_approval`
- 메시지 수신은 리더 트리거와 연동되어 모니터링 반응성을 확보한다.

## 5. 안정성 규칙

- 배정 실패 시 즉시 클레임 롤백.
- dead worker/heartbeat 정체를 감지하면 worker 상태를 보류 후보로 표시.
- state 파일은 변경 최소 단위로 기록하고, 복구 가능한 형태를 유지.
- team-fix 루프는 상한을 두고 무한 재시도를 차단.

## 6. 종료와 재개

### 6.1 종료
- `shutdown` 실행 시 모든 worker에 종료 신호 전송
- worker ACK 대기(타임아웃/강제 플래그 반영)
- 종료 후 상태 파일 및 tmux 자원 정리

### 6.2 재개
- resume은 기존 tmux 핸들/상태 파일을 읽어 모니터링을 재시작
- 잔존 task는 상태 기준으로 계속 배정/재배정

## 7. 구현 체크리스트

- [x] 충돌 검사 후 팀 시작이 가능한가?
- [ ] bootstrap task 수가 worker 수와 일치하는가?
- [x] task 의존성 기준으로 할당되는가?
- [x] heartbeat 및 non_reporting 감지가 상태에 반영되는가?
- [x] 옵션 기반 tmux 역할별 시각화 세션이 생성되고 attach 정보가 이벤트로 노출되는가?
- [x] 완료 판정이 집계값을 사용해 종료되는가?
- [ ] 완료 판정에 verify 승인 상태까지 통합 반영
- [x] 종료 후 잔존 자원과 상태 정리 동작이 남아있다

## 8. 연계 문서

- 기능 전체 동선: `docs/CODEX_TEAM_WORKFLOW.md`
