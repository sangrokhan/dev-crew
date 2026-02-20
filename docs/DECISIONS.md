# 결정사항 (현재 기준)

## 2026-02-20 TypeScript 전환

- 운영 기준 구현은 TypeScript 워크스페이스입니다.
  - API: `services/api`
  - Worker: `services/worker`
  - 상태 저장: `.omx/state/jobs` 파일 기반
- 설치/실행/운영은 npm 기준으로 진행합니다.
  - 기준 문서: `docs/TYPESCRIPT_OPERATIONS.md`
- Python 기반 기존 구현은 아카이브 과정 후 레포에서 제거되었습니다.
