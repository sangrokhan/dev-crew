---
name: omx-setup
description: Setup and configure oh-my-codex using current CLI behavior
---

# OMX Setup

Use this skill when users want to install or refresh oh-my-codex for the **current project plus user-level OMX directories**.

## Command

```bash
omx setup [--force] [--dry-run] [--verbose]
```

Supported setup flags (current implementation):
- `--force`: overwrite/reinstall managed artifacts where applicable
- `--dry-run`: print actions without mutating files
- `--verbose`: print per-file/per-step details

## What this setup actually does

`omx setup` performs these steps:

1. Create directories:
   - `~/.codex/`
   - `~/.codex/prompts/`
   - `~/.agents/skills/`
   - `./.omx/state/`, `./.omx/plans/`, `./.omx/logs/`
2. Install agent prompt files from repo `prompts/*.md` to `~/.codex/prompts/`
3. Remove legacy skill-prompt shim files from `~/.codex/prompts/` when detected
4. Install skills from repo `skills/*` to `~/.agents/skills/*`
5. Merge OMX config into `~/.codex/config.toml`
6. Verify required team MCP comm tool exports exist in built `dist/mcp/state-server.js`
7. Generate project-root `./AGENTS.md` from `templates/AGENTS.md` (or skip when existing and no force)
8. Configure notify hook references and write `./.omx/hud-config.json`

## Important behavior notes

- `omx setup` is **not** an interactive wizard in current code.
- Local project orchestration file is `./AGENTS.md` (project root).
- Prompts/skills are installed to user directories (`~/.codex/prompts`, `~/.agents/skills`).
- With `--force`, AGENTS overwrite may still be skipped if an active OMX session is detected (safety guard).

## Recommended workflow

1. Run setup:

```bash
omx setup --force --verbose
```

2. Verify installation:

```bash
omx doctor
```

3. Start Codex with OMX in the target project directory.

## Expected verification indicators

From `omx doctor`, expect:
- Prompts installed (30)
- Skills installed (40)
- AGENTS.md found in project root
- `.omx/state` exists
- OMX MCP servers configured in `~/.codex/config.toml`

## Troubleshooting

- If using local source changes, run build first:

```bash
npm run build
```

- If your global `omx` points to another install, run local entrypoint:

```bash
node bin/omx.js setup --force --verbose
node bin/omx.js doctor
```

- If AGENTS.md was not overwritten during `--force`, stop active OMX session and rerun setup.
