#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function ts() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}` +
    `${pad(now.getMonth() + 1)}` +
    `${pad(now.getDate())}` +
    `${pad(now.getHours())}` +
    `${pad(now.getMinutes())}` +
    `${pad(now.getSeconds())}`
  );
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readSymlinkTarget(linkPath) {
  const raw = await fs.readlink(linkPath);
  return path.resolve(path.dirname(linkPath), raw);
}

async function ensureDir(dirPath, dryRun) {
  if (dryRun) {
    return;
  }
  await fs.mkdir(dirPath, { recursive: true });
}

async function createDirSymlink(targetDir, sourceDir, dryRun) {
  if (dryRun) {
    return;
  }
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(sourceDir, targetDir, type);
}

async function moveToBackup(targetPath, dryRun, backups) {
  const backupPath = `${targetPath}.backup-${ts()}`;
  if (!dryRun) {
    await fs.rename(targetPath, backupPath);
  }
  backups.push({ from: targetPath, to: backupPath });
}

async function bindPath(targetPath, sourceDir, state) {
  const { dryRun, created, skipped, backups } = state;
  const sourceResolved = path.resolve(sourceDir);

  if (!(await exists(targetPath))) {
    await createDirSymlink(targetPath, sourceResolved, dryRun);
    created.push({ target: targetPath, source: sourceResolved, action: 'created' });
    return;
  }

  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    const current = await readSymlinkTarget(targetPath);
    if (current === sourceResolved) {
      skipped.push({ target: targetPath, reason: 'already_bound' });
      return;
    }
    await moveToBackup(targetPath, dryRun, backups);
    await createDirSymlink(targetPath, sourceResolved, dryRun);
    created.push({ target: targetPath, source: sourceResolved, action: 'relinked' });
    return;
  }

  await moveToBackup(targetPath, dryRun, backups);
  await createDirSymlink(targetPath, sourceResolved, dryRun);
  created.push({ target: targetPath, source: sourceResolved, action: 'replaced' });
}

function normalizePath(maybePath, fallbackAbsolute) {
  if (!maybePath) {
    return fallbackAbsolute;
  }
  if (path.isAbsolute(maybePath)) {
    return maybePath;
  }
  return path.resolve(repoRoot, maybePath);
}

export async function runSetupCliPaths(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const args = new Set(argv);
  const dryRun = args.has('--dry-run');
  const strict = args.has('--strict');

  const skippedByEnv =
    env.DEV_CREW_SKIP_CLI_PATH_SETUP === '1' ||
    env.DEV_CREW_SKIP_CLI_PATH_SETUP === 'true';

  const sharedAgentsDir = normalizePath(
    env.DEV_CREW_SHARED_AGENTS_DIR,
    path.join(repoRoot, 'config', 'cli', 'agents'),
  );
  const sharedSkillsDir = normalizePath(
    env.DEV_CREW_SHARED_SKILLS_DIR,
    path.join(repoRoot, 'config', 'cli', 'skills'),
  );

  const cliHomes = [
    {
      name: 'codex',
      baseDir: normalizePath(env.DEV_CREW_CODEX_HOME, path.join(os.homedir(), '.codex')),
    },
    {
      name: 'claude',
      baseDir: normalizePath(env.DEV_CREW_CLAUDE_HOME, path.join(os.homedir(), '.claude')),
    },
    {
      name: 'gemini',
      baseDir: normalizePath(env.DEV_CREW_GEMINI_HOME, path.join(os.homedir(), '.gemini')),
    },
  ];

  const state = {
    dryRun,
    backups: [],
    created: [],
    skipped: [],
    errors: [],
  };

  if (skippedByEnv) {
    const report = {
      dryRun,
      skippedByEnv,
      repoRoot,
      shared: {
        agents: sharedAgentsDir,
        skills: sharedSkillsDir,
      },
      created: state.created,
      skipped: state.skipped,
      backups: state.backups,
      errors: state.errors,
    };
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  await ensureDir(sharedAgentsDir, dryRun);
  await ensureDir(sharedSkillsDir, dryRun);

  for (const cli of cliHomes) {
    try {
      await ensureDir(cli.baseDir, dryRun);
      const agentsTarget = path.join(cli.baseDir, 'agents');
      const skillsTarget = path.join(cli.baseDir, 'skills');

      await bindPath(agentsTarget, sharedAgentsDir, state);
      await bindPath(skillsTarget, sharedSkillsDir, state);
    } catch (error) {
      state.errors.push({
        cli: cli.name,
        baseDir: cli.baseDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report = {
    dryRun,
    skippedByEnv,
    repoRoot,
    shared: {
      agents: sharedAgentsDir,
      skills: sharedSkillsDir,
    },
    created: state.created,
    skipped: state.skipped,
    backups: state.backups,
    errors: state.errors,
  };

  stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (state.errors.length > 0 && strict) {
    return 1;
  }

  return 0;
}

async function main() {
  const exitCode = await runSetupCliPaths();
  process.exitCode = exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
