# 팀 협업 오케스트레이션 기능 스펙

## 문서 동기화 기준 체크리스트 (2026-02-21)

- [x] Provider 스펙 동기화: `gemini`를 OpenAPI/실행 경로와 정렬
- [x] 팀 상태 저장소 경로 동기화: SSOT를 `.omx/state/jobs/<job-id>/`로 고정
- [x] OpenAPI 스키마 정합성 정리: `TeamState`/`Provider`/액션 경로를 구현과 정렬
- [x] 구현 미완료 항목 정렬: 중복 항목을 P0~P3 우선순위로 통합
- [x] 통합 테스트 실행: 체크리스트 반영 항목 기반 회귀 테스트 완료

### 우선순위 통합 체크리스트 (P0~P3)

- [x] P0: 팀 상태 경로를 SSOT로 통일 (`.omx/state/jobs/<job-id>`)
- [x] P0: `parallelTasks` 병렬 실행 + 백오프/재시도 처리
- [x] P0: 태스크 claim lease 회수 및 heartbeat 갱신
- [x] P0: `requiresApproval` 감지로 승인 게이트 분기
- [x] P1: 팀 산출물의 구조화 파이프라인 연계
- [x] P1: dead/non-reporting worker 자동 재할당 고도화
- [x] P2: 모니터링/메트릭 정합성 고도화
- [x] P3: 통합 테스트 실행 완료 (팀 라우팅/락 회수/심박 커버)

이 문서는 `oh-my-claudecode` 기반 팀 실행을 기능 중심으로 정리한 실무 사양이다.  
목표는 `작업 분할 → 실행 → 검증 → 실패 복구 → 정리`를 파일 기반 상태로 일관되게 수행하는 것이다.

## 1. 목적

- 사용자의 단일 요청을 다수 worker로 분할 처리한다.
- 실행 완료를 수치적으로 판정 가능한 상태 조건으로 판단한다.
- 비정상 종료나 중단 시에도 재개/복구가 가능하도록 상태를 보존한다.
- 종료 시 잔존 자원과 상태를 정리한다.

## 2. 기능 요구사항

1. 팀 시작
   - 명령으로 팀 실행을 시작할 수 있어야 한다.
   - 입력에서 worker 수, worker 타입, 작업 제목을 파싱해 팀 이름을 생성한다.
2. 작업 분할
   - 요청을 실행 가능한 `Task` 단위로 분해한다.
   - 각 Task는 소유 경계(파일/디렉터리/기능)와 `blocked_by` 의존성을 포함한다.
3. 실행
   - Task를 worker에 배정(`assignTask`)하고, 필요 시 재배정한다.
   - worker는 독립 세션에서 작업을 수행하고 상태 채널로 진척을 올린다.
4. 상태 관리
   - 팀/Task/worker 상태를 파일로 영속화한다.
- 상태 항목은 `phase`, task 상태(`queued`, `running`, `blocked`, `succeeded`, `failed`, `canceled`), 실패 횟수, heartbeat 정보를 포함한다.
5. 완료 판정
   - 작업이 더 이상 진행 대상이 없어야 한다.
   - 검증 게이트(테스트/빌드/정적 점검 등) 결과가 통과여야 한다.
   - 실패 정책에 따라 허용 실패가 없거나, 승인된 예외가 명시되어야 한다.
6. 검증/수정 루프
   - verify 단계로 결과를 확인한다.
   - 실패 시 fix 단계로 되돌려 수정 후 재검증한다.
   - fix 반복 횟수 상한을 두어 무한 루프를 막는다.
7. 모니터링
   - 주기적으로 작업/worker 상태를 집계한다.
   - 비활성 worker, heartbeat 정체(worker non-reporting), 죽은 worker를 감지해 조치 대상 표시한다.
8. 종료/정리
   - 정상 종료 시 shutdown-ack를 받아 pane/세션/상태를 정리한다.
   - 실패 종료 시에도 최종 원인과 상태를 남겨 추적 가능하게 한다.

## 3. 실행 흐름(기능 관점)

1. plan/범위 정리
2. task 분해 및 의존성 설정
3. team-exec 실행
4. team-verify로 게이트 확인
5. 실패면 team-fix 후 재실행
6. 완료면 정리

위 흐름에서 `queued=0`, `blocked=0`, `running=0`은 기본 완료 후보 조건이며  
실제 성공 전환은 verify 통과와 실패 정책 준수까지 포함한다.

## 4. 상태 판정 규칙

- Task 집계 기준
- `total`, `queued`, `running`, `blocked`, `succeeded`, `failed`, `canceled`를 항상 계산한다.
- 종료 조건 제안
- 필수: `queued=0`, `running=0`, `blocked=0`
  - 권장: `failed=0` (또는 사전 승인된 예외)
- 예외:
  - 단기적으로 worker가 응답하지 않더라도 heartbeat가 살아 있으면 waiting 상태로 구분.
  - 고장 worker는 dead로 분류 후 재배정 후보로 이동.

## 5. 역할과 책임

- Planner/PRD: 요구사항 분해, 범위·의존성 정의
- Executor: 실제 작업 수행, 결과 산출
- Verifier: 테스트/리뷰/정적검사 실행
- Fix 루프: 실패 항목 수정 및 재검증
- Team 관리자: 실행/모니터링/재시작/정리 총괄

## 6. 체크리스트

- [x] 작업 단위 분해와 `blocked_by` 의존성 정규화 완료
- [x] task state transition과 verify 게이트의 기본 경로 구현
- [x] 종료 조건 검증 자동화(terminal 상태 기반) 완료
- [x] P1: `queued/running/blocked` 지표 기반 자동 판정 고도화
- [x] P1: dead/non-reporting worker 대응 자동 재배정 연동
- [x] 종료 시 상태 정리 및 로그 잔여성 보장
- [ ] P2: 실패 이력 기반 재개 보강

## 7. 운영 원칙

- 종료는 명령 응답이 아니라 `상태 + 검증 증거 + 정리`가 모두 충족될 때만 허용한다.
- 상태는 파일에 보존되어야 하며, 중단 시 복구 가능한 지점에서 재개할 수 있어야 한다.
- 실패 재시도는 상한을 넘기면 강제 실패로 전환해 의사결정을 명시한다.

## 8. 하위 문서

- 동기화 파일 형식, 이벤트, 상태 경로, 재개/복구 동작은 `docs/oh-my-codex-team-workflow-sync.md`를 따른다.
