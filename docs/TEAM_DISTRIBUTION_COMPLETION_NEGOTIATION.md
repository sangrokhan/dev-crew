# 작업 분배/완료 관리/협의(협상) 운영 가이드

요청하신 내용은 `oh-my-claudecode`의 팀 오케스트레이션 철학을 기준으로,
현재 `dev-crew` 저장소에서 실제로 반영된 동작으로 정리한 운영 가이드입니다.

## 문서 동기화 기준 체크리스트 (2026-02-21)

- [x] Provider 스펙 동기화: `gemini`를 OpenAPI/실행 경로와 정렬
- [x] 팀 상태 저장소 경로 동기화: `.omx/state/jobs/<job-id>` 기준으로 정리
- [x] OpenAPI 스키마 정합성 정비: 문서 기반 계약을 실제 동작과 정렬
- [x] 구현 미완료 항목 재정렬: 중복 항목을 P0~P3 우선순위로 통합
- [x] 통합 테스트 실행: 문서 동기화 반영 검증 (최종 단계)

### 우선순위 통합 체크리스트 (P0~P3)

- [x] P0: 팀 저장소 경로 및 상태 저장 스키마를 단일 기준으로 통합
- [x] P0: 병렬 실행 스케줄링과 backoff/jitter 적용
- [x] P0: claim lease 만료 시 task 재클레임 처리
- [x] P0: 승인 게이트(`requiresApproval`)를 작업 단위로 반영
- [ ] P1: mailbox 기반 협의 경로 연동(재배정/질의/지시) (미구현)
- [x] P1: 역할별 출력 파이프라인 연결 (`DEPENDENCY_OUTPUTS` 전달)
- [x] P2: 운영 이벤트의 가시성(지표/근거 아티팩트) 강화 (`team.task.*`, `team.task.non_reporting` 등)
- [x] P3: 통합 테스트 실행 (최종)

## 1. 작업 분배(Dispatch)

### 1) 외부 리포지토리 기준(개념)

- 팀 모드는 Planner/Researcher/Designer/Developer/Executor/Verifier 같은 역할로 나뉜다.
- Team 템플릿 기반 태스크를 생성하고 `blocked_by` 의존성으로 순서를 고정한다.
- 태스크 단위로 Worker가 `claim`(소유권)해 병렬로 처리한다.
- `parallelTasks`/`max_workers` 같은 제약으로 동시 실행 수를 제어한다.

### 2) `dev-crew` 현재 저장소 기준(실행)

현재 구현은 **단일 Job에 팀 상태를 JSON으로 저장**하는 방식으로 동작한다.

- 진입점: `POST /v1/jobs` with `mode: "team"`
- 팀 템플릿:
  - 기본 6개 역할(Planner, Researcher, Designer, Developer, Executor, Verifier)
  - `options.team.teamTasks`로 커스터마이즈
  - `dependencies`로 선행조건 지정
- 실행 엔진:
  - `services/worker/src/index.ts`의 Team loop가 runnable(실행 가능) task를 선별해 실행
  - 현재는 JSON 상태 기반이므로 “실제 다중 worker claim”은 추상적으로 운영

## 2. 완료 관리(Completion Tracking)

### 핵심 상태 모델

- **Run 상태**: `queued / running / waiting_approval / succeeded / failed / canceled`
- **Task 상태**: `queued / running / succeeded / failed / blocked / canceled`
- **Fix 루프**: `maxFixAttempts` 초과 시 최종 실패, 미만이면 재실행

### 완료 판정 규칙

- 각 단계에서 실행 가능한 task가 모두 terminal 상태(`succeeded/failed/canceled`)가 될 때까지 반복
- 실패가 누적되어 dead-end가 발생하면:
  - `failed` 태스크와 하위 의존 태스크를 reset 후 fix 재시작
  - fix attempts가 한계치 넘으면 run 실패 처리
- 완료 판단은 API 조회로 검증:
  - `GET /v1/jobs/{jobId}/team`
  - `GET /v1/jobs/{jobId}/events`(SSE)

## 3. 협의/협상(조정) 방식

`oh-my-claudecode` 개념에서 협업 조율은 다음으로 이루어진다.

- 의존성 충돌 방지: blocker 관계 정리로 “누가 다음에 해야 하는지”를 제어
- 메시징(메일박스): `send/delivery` 기반 협의 채널로 변경 요구, 질문, 승인 요청 처리
- 리더-워커 조율: 승인/실패/재시도에 대한 판단은 팀 리더/오케스트레이터가 중앙에서 결정
- 실행 정책 반영: `team` 정책 파라미터(`maxFixAttempts`, `parallelTasks`)로 동시성·리스크를 조정

`dev-crew` 기준으로는 이 중 일부만 구현되어 있고, 협의 체계는 아직 부분적이다.

- [x] 구현된 것: 상태 전환, 이벤트 기록, 승인 API, 재개/취소 액션
- [x] 미구현/부분 구현: 분산 worker heartbeat/claim lease *(기본 복구 흐름은 반영, 다중 worker 고도화는 미완)*
- [ ] 미구현/부분 구현: 작업자 메일박스 기반 상호협상
- [x] 미구현/부분 구현: 역할별 세분화된 승인 게이트 *(태스크 승인 요청 감지 반영)*

## 4. 실무 운영 절차(권장)

1. 팀 Job 제출
2. `team state`에서 task 초기화 상태 확인(`queued`)
3. 실행 흐름 점검:
   - 의존성 충족 → 실행 가능한 태스크 상태가 생성되는지 확인
4. 실패 발생 시 이벤트 확인:
   - `team.task.completed`, `team.task.approval_required`, `team.retry`, `team.task.non_reporting` 여부 확인
5. 필요한 경우 승인/재개/취소 처리
6. run 종료 후 실패/재시도 로그를 통해 템플릿 및 태스크 조건 보정

## 5. 관련 위치

- `README.md`
- `docs/CODEX_TEAM_IMPLEMENTATION_DELIVERY.md`
- `docs/CODEX_TEAM_IMPLEMENTATION_SPEC.md`
- `services/api/src/jobs/jobs.controller.ts`
- `services/worker/src/index.ts`
