import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ApprovalState, Job as JobRecord, JobStatus, Prisma, PrismaClient, Provider } from '@prisma/client';
import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';

const JOB_QUEUE_NAME = 'jobs';
const prisma = new PrismaClient();
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);
const workRoot = process.env.WORK_ROOT ?? '/tmp/omx-web-runs';

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

type Role = 'planner' | 'executor' | 'verifier';
const ROLES: Role[] = ['planner', 'executor', 'verifier'];

interface PaneRuntime {
  role: Role;
  paneId: string;
  logPath: string;
  scriptPath: string;
  offset: number;
}

interface PaneState {
  paneId: string;
  dead: boolean;
  deadStatus: number | null;
  title: string;
}

interface JobOptionsNormalized {
  maxMinutes: number;
  keepTmuxSession: boolean;
  agentCommands: Partial<Record<Role, string>>;
}

interface RunResult {
  state: 'succeeded' | 'canceled';
  output?: Prisma.JsonObject;
}

interface TemplateContext {
  jobId: string;
  provider: Provider;
  mode: string;
  repo: string;
  ref: string;
  role: Role;
  task: string;
  workdir: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function normalizeJobOptions(raw: Prisma.JsonValue | null): JobOptionsNormalized {
  const obj = asObject(raw);
  const defaultKeepTmux = (process.env.TMUX_KEEP_SESSION_ON_FINISH ?? '1') !== '0';

  const maxMinutes = toPositiveInt(obj.maxMinutes, 60);
  const keepTmuxSession = typeof obj.keepTmuxSession === 'boolean' ? obj.keepTmuxSession : defaultKeepTmux;

  const commandObj = asObject(obj.agentCommands);
  const agentCommands: Partial<Record<Role, string>> = {};

  for (const role of ROLES) {
    const value = commandObj[role];
    if (typeof value === 'string' && value.trim()) {
      agentCommands[role] = value.trim();
    }
  }

  return {
    maxMinutes,
    keepTmuxSession,
    agentCommands,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function applyTemplate(template: string, context: TemplateContext): string {
  const map: Record<string, string> = {
    JOB_ID: context.jobId,
    PROVIDER: context.provider,
    MODE: context.mode,
    REPO: context.repo,
    REF: context.ref,
    ROLE: context.role,
    TASK: context.task,
    WORKDIR: context.workdir,
  };

  return template.replace(/\{([A-Z_]+)\}/g, (raw, key: string) => map[key] ?? raw);
}

function commandResultOrThrow(
  binary: string,
  args: string[],
  options?: {
    cwd?: string;
    allowFailure?: boolean;
  },
) {
  const result = spawnSync(binary, args, {
    cwd: options?.cwd,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  const status = result.status ?? 1;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (!options?.allowFailure && status !== 0) {
    throw new Error(`${binary} ${args.join(' ')} failed (${status}): ${stderr || stdout}`);
  }

  return {
    status,
    stdout,
    stderr,
  };
}

function ensureBinary(binary: string, versionArgs: string[] = ['--version']) {
  const result = commandResultOrThrow(binary, versionArgs, { allowFailure: true });
  if (result.status !== 0) {
    throw new Error(`required binary is missing or broken: ${binary}`);
  }
}

function runTmux(args: string[], allowFailure = false) {
  return commandResultOrThrow('tmux', args, { allowFailure });
}

function hasTmuxSession(sessionName: string): boolean {
  const result = runTmux(['has-session', '-t', sessionName], true);
  return result.status === 0;
}

function killTmuxSession(sessionName: string) {
  if (!hasTmuxSession(sessionName)) {
    return;
  }
  runTmux(['kill-session', '-t', sessionName]);
}

function normalizeRepo(repo: string): string {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return `https://github.com/${repo}.git`;
  }
  return repo;
}

function buildSessionName(jobId: string): string {
  const compact = jobId.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return `job-${compact.slice(0, 16)}`;
}

function listPaneStates(sessionName: string): PaneState[] {
  const result = runTmux(
    ['list-panes', '-t', `${sessionName}:0`, '-F', '#{pane_id}|#{pane_dead}|#{pane_dead_status}|#{pane_title}'],
    true,
  );

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [paneId, deadFlag, deadStatusRaw, title] = line.split('|');
      const deadStatus = deadStatusRaw ? Number.parseInt(deadStatusRaw, 10) : null;
      return {
        paneId,
        dead: deadFlag === '1',
        deadStatus: Number.isNaN(deadStatus ?? Number.NaN) ? null : deadStatus,
        title: title ?? '',
      };
    });
}

async function addEvent(jobId: string, type: string, message: string, payload?: Prisma.InputJsonValue) {
  await prisma.jobEvent.create({
    data: {
      jobId,
      type,
      message,
      payload,
    },
  });
}

async function prepareWorkspace(job: JobRecord, runDir: string): Promise<string> {
  const skipClone = (process.env.JOB_SKIP_GIT_CLONE ?? '0') === '1';

  if (skipClone) {
    await addEvent(job.id, 'phase_changed', 'Skipping git clone (JOB_SKIP_GIT_CLONE=1)');
    return runDir;
  }

  ensureBinary('git');

  const workspaceDir = path.join(runDir, 'workspace');
  const repoUrl = normalizeRepo(job.repo);

  const cloneResult = commandResultOrThrow(
    'git',
    ['clone', '--depth', '1', '--branch', job.ref, repoUrl, workspaceDir],
    { allowFailure: true },
  );

  if (cloneResult.status !== 0) {
    throw new Error(`git clone failed: ${cloneResult.stderr || cloneResult.stdout}`);
  }

  await addEvent(job.id, 'phase_changed', 'Repository cloned', {
    repo: repoUrl,
    ref: job.ref,
    workspaceDir,
  });

  return workspaceDir;
}

function resolveRoleCommand(
  provider: Provider,
  role: Role,
  customCommands: Partial<Record<Role, string>>,
): string {
  if (customCommands[role]) {
    return customCommands[role] as string;
  }

  const providerKey = `JOB_${provider.toUpperCase()}_${role.toUpperCase()}_CMD`;
  const genericKey = `JOB_${role.toUpperCase()}_CMD`;
  const envTemplate = process.env[providerKey] ?? process.env[genericKey];

  if (envTemplate?.trim()) {
    return envTemplate.trim();
  }

  if (provider === 'codex') {
    return `codex exec --json --full-auto --skip-git-repo-check --cd \"$JOB_WORKDIR\" \"You are the ${role} agent in a multi-agent tmux run. Job ID: $JOB_ID. Repository: $JOB_REPO ($JOB_REF). Task: $JOB_TASK. Return concise ${role} output for shared logs.\"`;
  }

  return `echo \"[${role}] No default command for provider '${provider}'. Set ${providerKey} or ${genericKey}.\"; exit 1`;
}

async function writePaneScript(pane: PaneRuntime, commandTemplate: string, context: TemplateContext) {
  const taskMarker = `__JOB_TASK_${pane.role.toUpperCase()}_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
  const renderedCommand = applyTemplate(commandTemplate, context);

  const script = `#!/usr/bin/env bash
set -euo pipefail

export JOB_ID=${shellQuote(context.jobId)}
export JOB_PROVIDER=${shellQuote(context.provider)}
export JOB_MODE=${shellQuote(context.mode)}
export JOB_REPO=${shellQuote(context.repo)}
export JOB_REF=${shellQuote(context.ref)}
export JOB_ROLE=${shellQuote(context.role)}
export JOB_WORKDIR=${shellQuote(context.workdir)}
export JOB_TASK=$(cat <<'${taskMarker}'
${context.task}
${taskMarker}
)

echo "[${context.role}] started $(date -Iseconds)"
${renderedCommand}
status=$?
echo "[${context.role}] finished $(date -Iseconds) status=$status"
exit $status
`;

  await fs.writeFile(pane.scriptPath, script, { mode: 0o755 });
}

function makePaneLayout(sessionName: string, workspaceDir: string): PaneRuntime[] {
  runTmux(['new-session', '-d', '-s', sessionName, '-n', 'crew', '-c', workspaceDir]);
  runTmux(['set-option', '-t', sessionName, 'remain-on-exit', 'on']);

  runTmux(['split-window', '-h', '-t', `${sessionName}:0`, '-c', workspaceDir]);
  runTmux(['split-window', '-v', '-t', `${sessionName}:0.1`, '-c', workspaceDir]);

  const paneIdResult = runTmux(['list-panes', '-t', `${sessionName}:0`, '-F', '#{pane_index}|#{pane_id}']);
  const paneRows = paneIdResult.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [indexRaw, paneId] = row.split('|');
      return {
        index: Number.parseInt(indexRaw, 10),
        paneId,
      };
    })
    .sort((a, b) => a.index - b.index);

  if (paneRows.length < ROLES.length) {
    throw new Error(`failed to allocate 3 panes, got ${paneRows.length}`);
  }

  return ROLES.map((role, idx) => {
    const paneId = paneRows[idx].paneId;
    runTmux(['select-pane', '-t', paneId, '-T', role], true);

    return {
      role,
      paneId,
      logPath: '',
      scriptPath: '',
      offset: 0,
    };
  });
}

async function pipePaneLogs(jobId: string, panes: PaneRuntime[]) {
  for (const pane of panes) {
    const command = `cat >> ${shellQuote(pane.logPath)}`;
    runTmux(['pipe-pane', '-o', '-t', pane.paneId, command]);
    runTmux(['send-keys', '-t', pane.paneId, 'bash', pane.scriptPath, 'C-m']);

    await addEvent(
      jobId,
      'phase_changed',
      `Pane started: ${pane.role}`,
      {
        role: pane.role,
        paneId: pane.paneId,
        scriptPath: pane.scriptPath,
      } as Prisma.InputJsonValue,
    );
  }
}

async function forwardNewLogs(jobId: string, panes: PaneRuntime[]) {
  for (const pane of panes) {
    let content: Buffer;
    try {
      content = await fs.readFile(pane.logPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    if (content.length <= pane.offset) {
      continue;
    }

    const nextChunk = content.subarray(pane.offset).toString('utf8');
    pane.offset = content.length;

    const lines = nextChunk
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    for (const line of lines.slice(0, 80)) {
      await addEvent(jobId, 'log', `[${pane.role}] ${line.slice(0, 1500)}`, {
        role: pane.role,
        paneId: pane.paneId,
      });
    }

    if (lines.length > 80) {
      await addEvent(jobId, 'log', `[${pane.role}] ... ${lines.length - 80} additional lines omitted`);
    }
  }
}

async function runProviderOrchestration(job: JobRecord): Promise<RunResult> {
  ensureBinary('tmux', ['-V']);

  await fs.mkdir(workRoot, { recursive: true });
  const runDir = path.join(workRoot, job.id);
  await fs.mkdir(runDir, { recursive: true });

  const options = normalizeJobOptions(job.options);
  const workspaceDir = await prepareWorkspace(job, runDir);

  const sessionName = buildSessionName(job.id);
  if (hasTmuxSession(sessionName)) {
    killTmuxSession(sessionName);
  }

  const panes = makePaneLayout(sessionName, workspaceDir);

  for (const pane of panes) {
    pane.logPath = path.join(runDir, `${pane.role}.log`);
    pane.scriptPath = path.join(runDir, `${pane.role}.sh`);

    await fs.writeFile(pane.logPath, '');

    const commandTemplate = resolveRoleCommand(job.provider, pane.role, options.agentCommands);
    await writePaneScript(pane, commandTemplate, {
      jobId: job.id,
      provider: job.provider,
      mode: job.mode,
      repo: job.repo,
      ref: job.ref,
      role: pane.role,
      task: job.task,
      workdir: workspaceDir,
    });
  }

  const attachCommand = `tmux attach -t ${sessionName}`;
  await addEvent(job.id, 'tmux_session_started', `tmux session started: ${sessionName}`, {
    sessionName,
    attachCommand,
    runDir,
    workspaceDir,
    panes: panes.map((pane) => ({ role: pane.role, paneId: pane.paneId })),
  });

  await pipePaneLogs(job.id, panes);

  const timeoutMs = options.maxMinutes * 60 * 1000;
  const startedAt = Date.now();

  while (true) {
    await forwardNewLogs(job.id, panes);

    const latest = await prisma.job.findUnique({
      where: { id: job.id },
      select: { status: true },
    });

    if (latest?.status === JobStatus.canceled) {
      killTmuxSession(sessionName);
      await addEvent(job.id, 'canceled', 'Job canceled while tmux session was running');
      return { state: 'canceled' };
    }

    const paneStates = listPaneStates(sessionName);
    if (paneStates.length === 0) {
      throw new Error(`tmux session disappeared unexpectedly: ${sessionName}`);
    }

    const allDead = paneStates.every((paneState) => paneState.dead);
    if (allDead) {
      await forwardNewLogs(job.id, panes);

      const paneResults = panes.map((pane) => {
        const state = paneStates.find((paneState) => paneState.paneId === pane.paneId);
        return {
          role: pane.role,
          paneId: pane.paneId,
          dead: state?.dead ?? false,
          exitStatus: state?.deadStatus ?? -1,
          logPath: pane.logPath,
        };
      });

      const failedPane = paneResults.find((pane) => pane.exitStatus !== 0);
      if (failedPane) {
        if (!options.keepTmuxSession) {
          killTmuxSession(sessionName);
        }
        throw new Error(`pane failed: ${failedPane.role} (exit=${failedPane.exitStatus})`);
      }

      if (!options.keepTmuxSession) {
        killTmuxSession(sessionName);
      }

      return {
        state: 'succeeded',
        output: {
          summary: 'tmux multi-pane run completed',
          tmux: {
            sessionName,
            attachCommand,
            keepSession: options.keepTmuxSession,
            panes: paneResults,
          },
          workspaceDir,
          runDir,
        },
      };
    }

    if (Date.now() - startedAt > timeoutMs) {
      killTmuxSession(sessionName);
      throw new Error(`tmux run timed out after ${options.maxMinutes} minutes`);
    }

    await sleep(1000);
  }
}

async function processJob(queueJob: Job<{ jobId: string }>) {
  const jobId = queueJob.data.jobId;
  const current = await prisma.job.findUnique({ where: { id: jobId } });

  if (!current) {
    throw new Error(`job not found: ${jobId}`);
  }

  if ([JobStatus.succeeded, JobStatus.failed, JobStatus.canceled].includes(current.status)) {
    return;
  }

  if (current.status === JobStatus.waiting_approval) {
    return;
  }

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.running,
      startedAt: current.startedAt ?? new Date(),
      finishedAt: null,
      error: null,
    },
  });
  await addEvent(jobId, 'phase_changed', 'Worker started processing');

  if (current.approvalState === ApprovalState.required) {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.waiting_approval,
      },
    });
    await addEvent(jobId, 'approval_required', 'Approval is required before execution');
    return;
  }

  const runResult = await runProviderOrchestration(current);

  if (runResult.state === 'canceled') {
    return;
  }

  const latest = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (latest?.status === JobStatus.canceled) {
    await addEvent(jobId, 'canceled', 'Job reached canceled state before completion update');
    return;
  }

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.succeeded,
      output: runResult.output,
      finishedAt: new Date(),
    },
  });

  await addEvent(jobId, 'completed', 'Job completed successfully', runResult.output);
}

async function main() {
  await prisma.$connect();

  const worker = new Worker(
    JOB_QUEUE_NAME,
    async (job) => {
      try {
        await processJob(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const jobId = job.data.jobId;

        const latest = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
        if (latest?.status !== JobStatus.canceled) {
          await prisma.job.update({
            where: { id: jobId },
            data: {
              status: JobStatus.failed,
              error: message,
              finishedAt: new Date(),
            },
          });
          await addEvent(jobId, 'failed', message);
        }

        throw error;
      }
    },
    {
      connection,
      concurrency,
    },
  );

  worker.on('ready', () => {
    console.log(`[worker] ready. queue=${JOB_QUEUE_NAME}, concurrency=${concurrency}`);
  });

  worker.on('failed', (job, error) => {
    console.error(`[worker] failed job=${job?.id}:`, error);
  });

  const shutdown = async () => {
    console.log('[worker] shutting down...');
    await worker.close();
    await prisma.$disconnect();
    await connection.quit();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error) => {
  console.error('[worker] fatal error', error);
  await prisma.$disconnect();
  await connection.quit();
  process.exit(1);
});
