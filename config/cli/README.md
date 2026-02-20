# Shared CLI Paths

이 디렉터리는 `codex`, `claude`, `gemini` CLI가 공통으로 참조할
`agents`, `skills` 경로의 소스입니다.

`npm install`의 `postinstall`에서 아래 링크를 자동으로 맞춥니다.

- `~/.codex/agents` -> `config/cli/agents`
- `~/.codex/skills` -> `config/cli/skills`
- `~/.claude/agents` -> `config/cli/agents`
- `~/.claude/skills` -> `config/cli/skills`
- `~/.gemini/agents` -> `config/cli/agents`
- `~/.gemini/skills` -> `config/cli/skills`

수동 실행:

```bash
npm run setup:cli-paths
```
