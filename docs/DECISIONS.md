# 결정사항 및 구현 이력

이 문서는 2026-02-18 기준 기존 README에 있던 결정사항/Phase 구현 기록을 분리한 아카이브입니다.


## Phase 0 결정사항 (2026-02-18)

- PR 생성 방식: `gh` CLI 사용
- 실행 환경: 잡(Job) 단위 Docker 컨테이너 1개
- 승인 정책: `manual(HITL)` + Plan 1회 승인 게이트
- 저장소 정책:
  - repo allowlist는 고정 단일 저장소가 아니라, 작업(Job) 생성 시 명시된 대상 repo 기준으로 적용
  - 로컬 병렬 작업은 `git worktree` 기반으로 분리 실행
- 브랜치 정책:
  - base branch는 `main` 대상
  - 작업 브랜치는 `crew/*` 패턴으로 생성
- 금지 명령 정책:
  - `git reset --hard`
  - `git clean -fd`
  - 무단 `rm -rf`
  - 보호 브랜치 강제 push

## Phase 1 에이전트 구조 결정 (2026-02-18)

- 기본 운영 모델: `leader` 1명 아래에 역할별 에이전트를 두는 확장형 구조
- 원칙:
  - 초기 역할에 제한되지 않으며, 작업 성격에 따라 에이전트 추가 가능
  - 각 에이전트는 명확한 책임 경계를 가지되 협업은 leader가 오케스트레이션
- 초기 에이전트 구성:
  - `leader`
  - `architect`
  - `frontend`
  - `backend`
  - `designer`
  - `ci/cd engineer`
  - `qa engineer`
  - `security engineer`

## Phase 1 산출물 스키마 결정 (v1, 2026-02-18)

- 원칙:
  - 현재 개발 속도를 위해 최소 필수 필드 중심으로 고정
  - 운영 중 필요 시 하위 호환 방식으로 확장

- Plan 스키마(v1):
  - `tasks[]`
    - `id`: string
    - `title`: string
    - `owner_agent`: string
    - `depends_on`: string[]
    - `acceptance_criteria`: string[]
  - `files_to_change`: string[]
  - `commands`: string[]
  - `test_matrix`: string[]
  - `pr`
    - `title`: string
    - `body`: string
  - `risks`: string[]
  - `approvals`
    - `requires_plan_approval`: boolean (`true`)

- Report 스키마(v1):
  - `run_summary`: string
  - `links`: string[]
  - `failures`: string[]
  - `next_actions`: string[]

## Phase 2 재시도 정책 결정 (2026-02-18)

- 테스트 실패 시 자동 수정 루프 기본값: `최대 5회`
- LLM 호출 재시도:
  - 대상: `429`, `5xx`
  - 횟수: `최대 5회`
  - 백오프: `1s -> 2s -> 4s -> 8s -> 16s`, `max 32s`, jitter 적용
  - 타임아웃: 호출당 `60s`, 누적(대기+실행) `120s`
- 레이트 리밋:
  - job 단위: `30 req/min`
  - 시스템 전체: `120 req/min`
  - burst: `10`
- 비재시도 조건:
  - 정책 위반(금지 명령 등)
  - 승인 거절
  - 명백한 요구사항 충돌

## Phase 2 구현 상태 (v1, 2026-02-18)

- 구현 파일:
  - `src/dev_crew/models.py`
    - Job 상태 전이 모델(`JobState`, `ALLOWED_STATE_TRANSITIONS`)
    - 정책 모델(`RetryPolicy`, `RateLimitPolicy`)
    - 산출물 모델(`PlanV1`, `ReportV1`)
  - `src/dev_crew/flow.py`
    - 오케스트레이션 러너(`JobRunner`): `start -> planning -> gate -> build -> report`
    - 자동 수정 루프(`auto_fix_max_rounds=5`) 반영
  - `tests/test_phase2_flow.py`
    - 상태 전이 검증
    - 자동 수정 5회 루프 검증
    - 승인 거절 시 실패 상태 검증

## CrewAI 오케스트레이션 업데이트 (2026-02-18)

- 핵심 변경:
  - `JobService`가 자체 fan-out 문구만 사용하는 방식에서, `CrewAIOrchestrator` 기반 선언/실행으로 전환
  - 역할별 specialist task는 `async_execution=True`로 병렬 실행 관리
  - `leader` task는 specialist 결과를 컨텍스트로 받아 최종 취합

- 구현 파일:
  - `src/dev_crew/orchestration/crewai_runner.py`
  - `src/dev_crew/orchestration/__init__.py`
  - `src/dev_crew/services/jobs.py`
  - `src/dev_crew/api/app.py`
  - `tests/test_crewai_orchestration.py`

- 운영 환경변수:
  - `DEV_CREW_USE_CREWAI` (기본: `1`)
  - `DEV_CREW_CREWAI_DRY_RUN` (기본: `1`)
  - `DEV_CREW_LOCAL_LLM_MODEL` (기본: `ollama/llama3.1:8b`)
  - `DEV_CREW_CREWAI_LLM` (기본: `DEV_CREW_LOCAL_LLM_MODEL`)
  - `DEV_CREW_CREWAI_MANAGER_LLM` (기본: `DEV_CREW_CREWAI_LLM`)
  - `DEV_CREW_OLLAMA_BASE_URL` (기본: `http://127.0.0.1:11434`)
  - `DEV_CREW_CREWAI_VERBOSE` (기본: `0`)

## Phase 3 구현 상태 (v1, 2026-02-18)

- 구현 파일:
  - `src/dev_crew/tools/context.py`
    - repo 파일/디렉토리 스캔
    - `rg` 기반 검색(`grep_repo`)
    - 상위 모듈 맵 생성
  - `src/dev_crew/tools/git_ops.py`
    - `clone/fetch/checkout/worktree/commit/push` 래퍼
  - `src/dev_crew/tools/quality.py`
    - `pytest`, `ruff`, `mypy` 실행 래퍼
  - `src/dev_crew/tools/pr_gh.py`
    - `gh pr create` 래퍼
  - `src/dev_crew/security/permissions.py`
    - 실행 담당 agent만 `write`, 나머지 `read-only` 정책
  - `tests/test_phase3_tooling.py`
    - 컨텍스트 수집/grep 동작 검증
    - 권한 분리 정책 검증

## Phase 4 구현 상태 (v1, 2026-02-18)

- 구현 방식:
  - OpenClaw 흐름을 참조한 복제형(Custom) OAuth 계층 구성
  - 초기 대상 provider: `openai-codex`, `google-antigravity`

- 구현 파일:
  - `src/dev_crew/llm/models.py`
    - provider/요청/응답/OAuth 모델
  - `src/dev_crew/llm/token_store.py`
    - 파일 기반 auth profile 저장소
  - `src/dev_crew/llm/oauth_clone.py`
    - PKCE 기반 OAuth 시작/완료 플로우
  - `src/dev_crew/llm/router.py`
    - model prefix 기반 provider 라우팅
  - `src/dev_crew/llm/client.py`
    - Custom LLM 어댑터(프로필 조회, 정책 훅, 재시도, 관측 로그 연동)
  - `src/dev_crew/hooks/security.py`
    - 프롬프트/출력 마스킹(시크릿/PII)
    - 정책 위반 명령 차단(금지 명령)
  - `src/dev_crew/hooks/observability.py`
    - LLM/tool 호출 이벤트 로깅
  - `tests/test_phase4_custom_llm.py`
    - OAuth clone flow / 라우팅 / 정책 훅 / 재시도 검증

## Phase 5 구현 상태 (v1, 2026-02-18)

- 구현 파일:
  - `src/dev_crew/api/app.py`
    - `POST /jobs`
    - `GET /jobs/{id}`
    - `GET /jobs/{id}/events` (SSE)
  - `src/dev_crew/api/schemas.py`
    - API 요청/응답 스키마
  - `src/dev_crew/services/jobs.py`
    - Job 생성/조회/처리 서비스
    - idempotency key 충돌/재사용 처리
  - `src/dev_crew/storage/sqlite.py`
    - SQLite 기반 Job/Event/Idempotency 저장소
  - `src/dev_crew/queue/in_memory.py`
    - 비동기 Queue + Worker 실행기
  - `tests/test_phase5_api.py`
    - API 흐름/Idempotency/SSE 테스트

- Storage 전략:
  - 현재: SQLite (`.dev_crew/jobs.db`)
  - 전환 계획: 저장소 인터페이스 유지 후 Postgres backend 추가로 대체 가능

## Phase 6 구현 상태 (v1, 2026-02-18)

- 구현 파일:
  - `src/dev_crew/runtime/sandbox.py`
    - Docker sandbox 실행기
    - 기본 `dry-run` 모드로 안전하게 실행 경로 검증
  - `src/dev_crew/runtime/budget.py`
    - 잡당 상한(`max_state_transitions`, `max_tool_calls`) 강제
  - `src/dev_crew/runtime/audit.py`
    - JSONL 감사 로그 기록(`job`, `state_transition`, `tool_call`, `escalation`)
  - `src/dev_crew/runtime/escalation.py`
    - 실패 시 에스컬레이션 레코드 생성
  - `src/dev_crew/services/jobs.py`
    - budget 체크 + sandbox 실행 + 감사 로그 + 실패 에스컬레이션 통합
  - `src/dev_crew/api/app.py`
    - 환경변수 기반 안정화 설정 주입
    - `GET /jobs/{id}/escalations` 추가
  - `tests/test_phase6_stability.py`
    - budget 초과 시 실패/에스컬레이션 검증
    - sandbox 호출 감사 로그 검증

- 운영 설정(환경변수):
  - `DEV_CREW_JOB_MAX_STATE_TRANSITIONS` (기본: `20`)
  - `DEV_CREW_JOB_MAX_TOOL_CALLS` (기본: `10`)
  - `DEV_CREW_DOCKER_IMAGE` (기본: `python:3.13-slim`)
  - `DEV_CREW_DOCKER_WORKDIR` (기본: `/workspace`)
  - `DEV_CREW_DOCKER_TIMEOUT_SECONDS` (기본: `120`)
  - `DEV_CREW_DOCKER_DRY_RUN` (기본: `1`)
  - `DEV_CREW_AUDIT_LOG_PATH` (기본: `.dev_crew/audit.log`)
  - `DEV_CREW_ESCALATION_LOG_PATH` (기본: `.dev_crew/escalations.log`)

## Phase 7 구현 상태 (v1, 2026-02-18)

- 목표:
  - provider별 모델 리스트를 조회하고, 용도/우선순위/토큰 사용 상태를 함께 제공
  - 주기적 refresh 캐시를 API 서버 수명주기와 연동

- 구현 파일:
  - `src/dev_crew/llm/model_catalog.py`
    - Codex 모델 목록 + 사용량(`wham/usage`) 조회
    - Antigravity 모델 목록(`fetchAvailableModels`) + 사용량(`loadCodeAssist`) 조회
    - provider별 캐시/오류 상태/주기 refresh 루프
  - `src/dev_crew/llm/models.py`
    - 모델/사용량/카탈로그 응답 모델 추가
  - `src/dev_crew/api/schemas.py`
    - `/llm/models` 응답 스키마 추가
  - `src/dev_crew/api/app.py`
    - `GET /llm/models`
    - `POST /llm/models/refresh`
    - 앱 startup/shutdown 시 model catalog start/stop 연동
  - `tests/test_phase7_model_catalog.py`
    - mock transport 기반 provider 응답 파싱 테스트
    - 주기 refresh 동작 테스트
    - API 엔드포인트 테스트

- 운영 설정(환경변수):
  - `DEV_CREW_MODEL_CATALOG_ACCOUNT_ID` (기본: `default`)
  - `DEV_CREW_MODEL_CATALOG_REFRESH_SECONDS` (기본: `600`)
  - `DEV_CREW_MODEL_CATALOG_AUTO_REFRESH` (기본: `1`)
  - `DEV_CREW_MODEL_CATALOG_STARTUP_REFRESH` (기본: `1`)
  - `DEV_CREW_MODEL_CATALOG_HTTP_TIMEOUT_SECONDS` (기본: `10`)
  - `DEV_CREW_CODEX_CLIENT_VERSION` (기본: `0.1.0`)

## Phase 8 구현 상태 (v1, 2026-02-18)

- 목표:
  - LLM 호출량/토큰 사용량을 모델 단위로 추적해 모델 선택 정책에 활용
  - 누적(total) + 최근 구간(rolling window) 사용량 동시 제공

- 구현 파일:
  - `src/dev_crew/llm/usage_tracker.py`
    - provider/model별 호출/성공/실패 카운트 집계
    - prompt/completion token 집계(제공값 우선, 미제공 시 경량 추정)
    - rolling window 이벤트 관리 및 snapshot API 데이터 생성
  - `src/dev_crew/llm/client.py`
    - `CustomLLMAdapter` 호출 성공/실패 시 usage tracker 기록 연동
  - `src/dev_crew/api/app.py`
    - `GET /llm/usage`
    - `POST /llm/usage/reset`
  - `src/dev_crew/api/schemas.py`
    - usage 추적 응답 스키마 추가
  - `tests/test_phase8_usage_tracking.py`
    - rolling window prune + API endpoint 테스트
  - `tests/test_phase4_custom_llm.py`
    - adapter usage tracker 기록 테스트 추가

- 운영 설정(환경변수):
  - `DEV_CREW_LLM_USAGE_WINDOW_MINUTES` (기본: `60`)
