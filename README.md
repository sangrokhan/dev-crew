# dev-crew

로컬에서 실행 가능한 멀티 에이전트 개발 오케스트레이션 API입니다.
`job`을 생성하면 상태 전이를 거치며 계획/실행/리포트 흐름을 처리합니다.

## 소개

`dev-crew`는 다음을 제공합니다.

- FastAPI 기반 Job API (`/jobs`, `/jobs/{id}`, SSE 이벤트 스트림)
- In-memory queue + worker로 비동기 처리
- SQLite 기반 Job/Event/Idempotency 저장
- CrewAI 오케스트레이션 연동 (dry-run 지원)
- Docker sandbox 실행기, budget 가드, 감사/에스컬레이션 로그

## 요구사항

- Python 3.11+
- `pip`
- (선택) Docker: sandbox 실제 실행 시 필요
- (선택) `gh` CLI: PR 자동화 확장 시 필요

## 환경설정

### 1) 가상환경 생성

```bash
python -m venv .venv
source .venv/bin/activate
```

### 2) 의존성 설치

```bash
pip install -r requirements.txt
```

### 3) 기본 환경변수(선택)

기본값으로도 실행 가능하지만, 필요 시 아래를 설정하세요.

```bash
export DEV_CREW_WORKSPACE_ROOT="$(pwd)"
export DEV_CREW_DB_PATH=".dev_crew/jobs.db"
export DEV_CREW_DOCKER_DRY_RUN=1
export DEV_CREW_USE_CREWAI=1
export DEV_CREW_CREWAI_DRY_RUN=1
export DEV_CREW_OAUTH_TOKEN_PATH="$HOME/.config/dev_crew/oauth_tokens.json"
```

OAuth 토큰 파일은 기본적으로 워크스페이스 밖(`~/.config/dev_crew/oauth_tokens.json`)에 저장되며,
소유자 전용 권한(디렉터리 `0700`, 파일 `0600`)으로 관리됩니다.
워크스페이스 내부 경로는 기본 차단되어 에이전트 컨텍스트 수집 대상에서 제외됩니다.
OAuth 진행 중 상태(state/code_verifier)도 같은 위치의 `oauth_tokens.pending.json`에 저장되어
프로세스 재시작 후에도 로그인 완료를 이어갈 수 있습니다.
토큰 만료 시에는 `CustomLLMAdapter.invoke(..., token_refresher=...)` 또는
`OAuthCloneClient.refresh_access_token(...)`으로 재발급 후 같은 파일에 갱신 저장합니다.
`CustomLLMAdapter`는 기본적으로 만료 5분 전(`oauth_refresh_leeway_seconds=300`)부터
선제적으로 refresh를 시도합니다.

## 실행 방법

프로젝트 루트에서 실행:

```bash
PYTHONPATH=src uvicorn dev_crew.api.app:app --reload --host 0.0.0.0 --port 8000
```

서버 확인:

```bash
curl -s http://localhost:8000/docs | head
```

## 사용법

### 1) Job 생성

```bash
curl -s -X POST "http://localhost:8000/jobs" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-job-001" \
  -d '{
    "goal": "Implement API endpoint",
    "repo": "org/repo",
    "base_branch": "main"
  }'
```

### 2) Job 상태 조회

```bash
curl -s "http://localhost:8000/jobs/<job_id>"
```

### 3) 이벤트 스트림(SSE)

```bash
curl -N "http://localhost:8000/jobs/<job_id>/events"
```

### 4) 에스컬레이션 조회

```bash
curl -s "http://localhost:8000/jobs/<job_id>/escalations"
```

## 테스트

전체 테스트 실행:

```bash
pytest -q
```

특정 테스트만 실행:

```bash
pytest -q tests/test_phase5_api.py
```

## 주요 설정값

자주 쓰는 환경변수만 정리했습니다.

- `DEV_CREW_WORKSPACE_ROOT` (기본: `.`)
- `DEV_CREW_DB_PATH` (기본: `.dev_crew/jobs.db`)
- `DEV_CREW_USE_CREWAI` (기본: `1`)
- `DEV_CREW_CREWAI_DRY_RUN` (기본: `1`)
- `DEV_CREW_CREWAI_LLM` (기본: unset)
- `DEV_CREW_CREWAI_MANAGER_LLM` (기본: unset)
- `DEV_CREW_DOCKER_DRY_RUN` (기본: `1`)
- `DEV_CREW_DOCKER_TIMEOUT_SECONDS` (기본: `120`)
- `DEV_CREW_JOB_MAX_STATE_TRANSITIONS` (기본: `20`)
- `DEV_CREW_JOB_MAX_TOOL_CALLS` (기본: `10`)
- `DEV_CREW_AUDIT_LOG_PATH` (기본: `.dev_crew/audit.log`)
- `DEV_CREW_ESCALATION_LOG_PATH` (기본: `.dev_crew/escalations.log`)
- `DEV_CREW_OAUTH_TOKEN_PATH` (기본: `$HOME/.config/dev_crew/oauth_tokens.json`)
- `DEV_CREW_OAUTH_ALLOW_WORKSPACE_PATH` (기본: `0`, 테스트/예외 상황에서만 `1`)

## 의사결정/구현 이력

기존 결정사항과 단계별 구현 기록은 아래 문서로 분리했습니다.

- `docs/DECISIONS.md`

## 프로젝트 구조

```text
src/dev_crew/
  api/             # FastAPI 엔드포인트
  services/        # Job 서비스 레이어
  orchestration/   # CrewAI 오케스트레이션
  runtime/         # sandbox / budget / audit / escalation
  storage/         # SQLite 저장소
  queue/           # in-memory queue
  tools/           # context/git/quality/pr 래퍼
tests/             # 단위/통합 테스트
```
