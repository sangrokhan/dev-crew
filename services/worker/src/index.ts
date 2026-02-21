import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Job, Worker } from 'bullmq';
import { JobFileStore } from './storage/job-file-store';
import { type JobRecord, Provider, type TeamRole as StoredTeamRole } from './storage/job-types';

const JOB_QUEUE_NAME = 'jobs';
const jobStore = new JobFileStore();
const redisUrl = process.env.REDIS_URL ?? '';
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);
const workRoot = process.env.WORK_ROOT ?? '/tmp/omx-web-runs';
const fileQueueEnabled = !process.env.REDIS_URL;
const fileQueueStaleMs = Number(process.env.WORK_QUEUE_STALE_CLAIM_MS ?? 15 * 60 * 1000);
const TEAM_TASK_CLAIM_TTL_MS = Number(process.env.TEAM_TASK_CLAIM_TTL_MS ?? 60_000);
const TEAM_TASK_CLAIM_LEASE_SLACK_MS = Number(process.env.TEAM_TASK_CLAIM_LEASE_SLACK_MS ?? 15_000);
const TEAM_TASK_HEARTBEAT_MS = Number(process.env.TEAM_TASK_HEARTBEAT_MS ?? 10_000);
const TEAM_TASK_NON_REPORTING_GRACE_MS = clampPositiveInt(
  Number(process.env.TEAM_TASK_NON_REPORTING_GRACE_MS ?? 30_000),
  30_000,
);
let shutdownRequested = false;

const redisConnection = (() => {
  if (!redisUrl) {
    return null;
  }
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
  };
})();

type Role = 'planner' | 'executor' | 'verifier';
type TeamRole = StoredTeamRole;
const TMUX_ROLES: Role[] = ['planner', 'executor', 'verifier'];
const TEAM_ROLES: TeamRole[] = ['planner', 'researcher', 'designer', 'developer', 'executor', 'verifier'];
const TEAM_IDLE_BACKOFF_BASE_MS = Number(process.env.TEAM_IDLE_BACKOFF_BASE_MS ?? 800);
const TEAM_IDLE_BACKOFF_MAX_MS = Number(process.env.TEAM_IDLE_BACKOFF_MAX_MS ?? 8_000);
const JOB_LLM_RATE_LIMIT_RETRY_MAX_ATTEMPTS = (() => {
  const raw = Number(process.env.JOB_LLM_RATE_LIMIT_RETRY_MAX_ATTEMPTS ?? 0);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
})();
const JOB_LLM_RATE_LIMIT_RETRY_BASE_MS = (() => {
  const raw = Number(process.env.JOB_LLM_RATE_LIMIT_RETRY_BASE_MS ?? 1_500);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1_500;
})();
const JOB_LLM_RATE_LIMIT_RETRY_MAX_MS = (() => {
  const raw = Number(process.env.JOB_LLM_RATE_LIMIT_RETRY_MAX_MS ?? 60_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
})();
const JOB_LLM_RETRY_MAX_ATTEMPTS = (() => {
  const raw = Number(process.env.JOB_LLM_RETRY_MAX_ATTEMPTS ?? 0);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
})();
const JOB_LLM_RETRY_BASE_MS = (() => {
  const raw = Number(process.env.JOB_LLM_RETRY_BASE_MS ?? 1_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1_000;
})();
const JOB_LLM_RETRY_MAX_MS = (() => {
  const raw = Number(process.env.JOB_LLM_RETRY_MAX_MS ?? 15_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15_000;
})();
const TEAM_WORKER_ID = `worker-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
const SHELL_COMMAND_PREFIXES = new Set([
  'bash',
  'echo',
  'git',
  'node',
  'npm',
  'python',
  'python3',
  'sh',
  'tmux',
  'yarn',
  'bun',
  'pnpm',
  'npx',
]);
const DEFAULT_CLI_BINARIES: Record<Provider, string> = {
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini',
};

type TeamTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'canceled';
type TeamRunStatus = 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'canceled';

interface TeamTaskTemplate {
  id: string;
  name: string;
  role: TeamRole;
  dependencies?: string[];
  maxAttempts?: number;
  timeoutSeconds?: number;
}

interface TeamTaskState extends TeamTaskTemplate {
  status: TeamTaskStatus;
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  workerId?: string;
  claimToken?: string;
  claimExpiresAt?: string;
  lastHeartbeatAt?: string;
  error?: string;
  output?: Record<string, unknown> | undefined;
}

type TeamMailboxKind = 'question' | 'instruction' | 'notice' | 'reassign';

interface TeamMailboxMessage {
  id: string;
  kind: TeamMailboxKind;
  to?: TeamRole | TeamRole[] | 'leader';
  taskId?: string;
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  deliveredAt?: string | null;
  delivered: boolean;
  meta?: Record<string, unknown>;
}

interface TeamRunState {
  status: TeamRunStatus;
  phase: string;
  fixAttempts: number;
  maxFixAttempts: number;
  parallelTasks: number;
  currentTaskId?: string | null;
  tasks: TeamTaskState[];
  mailbox?: TeamMailboxMessage[];
}

interface PaneRuntime {
  role: Role;
  paneId: string;
  logPath: string;
  scriptPath: string;
  resultPath: string;
  completionMarker: string;
  offset: number;
}

interface PaneState {
  paneId: string;
  dead: boolean;
  deadStatus: number | null;
  title: string;
}

type CompletionMarkerSource = 'result-file' | 'log-line' | 'tmux-dead-status' | 'unknown';

interface PaneCompletion {
  role: Role;
  paneId: string;
  logPath: string;
  resultPath: string;
  dead: boolean;
  deadStatus: number | null;
  exitStatus: number | null;
  completionMarkerSeen: boolean;
  completionMarkerSource: CompletionMarkerSource;
}

interface JobOptionsNormalized {
  maxMinutes: number;
  keepTmuxSession: boolean;
  parallelism: number;
  agentCommands: Partial<Record<TeamRole, string>>;
  maxFixAttempts: number;
}

const TEAM_TASK_STATUSES: TeamTaskStatus[] = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'canceled'];
const TEAM_TERMINAL_TASK_STATUS: TeamTaskStatus[] = ['succeeded', 'failed', 'canceled'];

function normalizeTaskStatus(raw: unknown): TeamTaskStatus {
  if (typeof raw === 'string' && TEAM_TASK_STATUSES.includes(raw as TeamTaskStatus)) {
    return raw as TeamTaskStatus;
  }
  return 'queued';
}

interface RunResult {
  state: 'succeeded' | 'canceled' | 'failed' | 'waiting_approval';
  output?: Record<string, unknown>;
}

type RetryFailureKind = 'rate_limit' | 'general';

interface RetryFailure {
  kind: RetryFailureKind;
  retryAfterMs?: number;
}

interface TemplateContext {
  jobId: string;
  provider: Provider;
  mode: string;
  repo: string;
  ref: string;
  role: TeamRole;
  task: string;
  taskId?: string;
  phase?: string;
  attempt?: number;
  workdir: string;
  dependencyOutputs?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toISOStringNow(): string {
  return new Date().toISOString();
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function randomTaskToken(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function clampPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function isClaimExpired(task: TeamTaskState, nowMs: number): boolean {
  if (task.status !== 'running') {
    return false;
  }

  const expiresAtMs = parseIsoMs(task.claimExpiresAt);
  const heartbeatMs = parseIsoMs(task.lastHeartbeatAt);
  const heartbeatGraceMs = Math.max(TEAM_TASK_NON_REPORTING_GRACE_MS, TEAM_TASK_HEARTBEAT_MS * 3);

  if (expiresAtMs === null || heartbeatMs === null) {
    return true;
  }

  return expiresAtMs <= nowMs || nowMs - heartbeatMs > heartbeatGraceMs;
}

function isTaskNonReporting(task: TeamTaskState, nowMs: number): boolean {
  if (task.status !== 'running') {
    return false;
  }

  const heartbeatMs = parseIsoMs(task.lastHeartbeatAt);
  if (heartbeatMs === null) {
    return true;
  }

  return nowMs - heartbeatMs > Math.max(TEAM_TASK_NON_REPORTING_GRACE_MS, TEAM_TASK_HEARTBEAT_MS * 3);
}

function toIsoTimeOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  return undefined;
}

function summarizeValueForTemplate(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseBooleanish(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 0 || value === 1) {
      return value === 1;
    }
    return null;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'n'].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function detectApprovalRequired(value: unknown): boolean {
  const parsed = asObject(value);
  const direct = parseBooleanish(parsed.requiresApproval) ?? parseBooleanish(parsed.requires_approval) ?? parseBooleanish(parsed.requireApproval) ??
    parseBooleanish(parsed.require_approval);

  if (direct !== null) {
    return direct;
  }

  const approval = asObject(parsed.approval);
  const nested = parseBooleanish(approval.required) ?? parseBooleanish(approval.isRequired) ?? parseBooleanish(approval.requiredApproval);

  if (nested !== null) {
    return nested;
  }

  return false;
}

function withConfigurableBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const safeBase = clampPositiveInt(baseMs, 800);
  const safeMax = clampPositiveInt(maxMs, 8_000);
  const capped = Math.min(safeMax, safeBase * 2 ** Math.max(0, attempt));
  const jitter = 0.75 + (Math.random() * 0.5);
  const jittered = Math.floor(capped * jitter);
  const floor = Math.min(200, capped);
  const upper = Math.max(0, capped - floor);
  const floorWithJitter = floor + Math.floor(upper * Math.random());

  return Math.max(floor, jittered + floorWithJitter);
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function parseErrorCode(parsed: Record<string, unknown>): number | null {
  const direct = parseNumericValue(parsed.code) ?? parseNumericValue(parsed.status) ?? parseNumericValue(parsed.statusCode);
  if (direct !== null) {
    return direct;
  }

  const details = asObject(parsed.details);
  const nested = parseNumericValue(details.code) ?? parseNumericValue(details.status) ?? parseNumericValue(details.statusCode);
  if (nested !== null) {
    return nested;
  }

  const error = asObject(parsed.error);
  return (
    parseNumericValue(error.code)
    ?? parseNumericValue(error.status)
    ?? parseNumericValue(error.statusCode)
    ?? null
  );
}

function parseRetryAfterMs(payload: string): number | undefined {
  const patterns = [
    /retry[- ]?after\s*[:=]?\s*(\d+)\s*(ms|s|sec|secs|seconds|m|min|minutes)?/i,
    /retry\s+after\s*[:=]?\s*(\d+)\s*(ms|s|sec|secs|seconds|m|min|minutes)?/i,
    /retry\s+in\s*(\d+)\s*(ms|s|sec|secs|seconds|m|min|minutes)?/i,
  ] as const;

  for (const pattern of patterns) {
    const match = payload.match(pattern);
    if (!match) {
      continue;
    }

    const rawDelay = Number.parseInt(match[1], 10);
    if (!Number.isFinite(rawDelay) || rawDelay <= 0) {
      continue;
    }

    const unit = match[2]?.toLowerCase() ?? 's';
    if (unit === 'ms') {
      return rawDelay;
    }
    if (unit === 'm' || unit === 'min' || unit === 'minutes') {
      return rawDelay * 60_000;
    }
    return rawDelay * 1000;
  }

  const dateMatch = payload.match(
    /retry[- ]?after[^0-9a-z]+([a-z]{3},\s+\d{1,2}\s+[a-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+gmt)/i,
  );
  if (dateMatch) {
    const dateValue = Date.parse(dateMatch[1]);
    if (!Number.isNaN(dateValue)) {
      const delay = dateValue - Date.now();
      if (delay > 0) {
        return delay;
      }
    }
  }

  return undefined;
}

function detectRateLimitFailure(parsed: Record<string, unknown> | undefined, payload: string): RetryFailure | null {
  const parsedText = JSON.stringify(parsed ?? {});
  const combined = `${payload}\n${parsedText}`.toLowerCase();
  const errorCode = parseErrorCode(asObject(parsed ?? {}));

  const isRateLimit = combined.includes('429')
    || combined.includes('rate limit')
    || combined.includes('too many requests')
    || combined.includes('quota')
    || combined.includes('throttle')
    || errorCode === 429;

  if (!isRateLimit) {
    return null;
  }

  return {
    kind: 'rate_limit',
    retryAfterMs: parseRetryAfterMs(payload),
  };
}

function getRetryMaxAttempts(task: TeamTaskState, kind: RetryFailureKind): number {
  const baseline = task.maxAttempts ?? 1;
  if (kind === 'rate_limit' && JOB_LLM_RATE_LIMIT_RETRY_MAX_ATTEMPTS > 0) {
    return Math.max(baseline, JOB_LLM_RATE_LIMIT_RETRY_MAX_ATTEMPTS);
  }
  if (kind === 'general' && JOB_LLM_RETRY_MAX_ATTEMPTS > 0) {
    return Math.max(baseline, JOB_LLM_RETRY_MAX_ATTEMPTS);
  }
  return baseline;
}

function getRetryDelayMs(attempt: number, kind: RetryFailureKind, retryAfterMs?: number): number {
  if (kind === 'rate_limit') {
    if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
      return Math.min(retryAfterMs, JOB_LLM_RATE_LIMIT_RETRY_MAX_MS);
    }
    return withConfigurableBackoff(attempt - 1, JOB_LLM_RATE_LIMIT_RETRY_BASE_MS, JOB_LLM_RATE_LIMIT_RETRY_MAX_MS);
  }

  return withConfigurableBackoff(attempt - 1, JOB_LLM_RETRY_BASE_MS, JOB_LLM_RETRY_MAX_MS);
}

function withBackoffDelay(attempt: number): number {
  const safeBase = clampPositiveInt(TEAM_IDLE_BACKOFF_BASE_MS, 800);
  const safeMax = clampPositiveInt(TEAM_IDLE_BACKOFF_MAX_MS, 8_000);
  const capped = Math.min(safeMax, safeBase * 2 ** attempt);
  const jitter = 0.75 + (Math.random() * 0.5);
  const jittered = Math.floor(capped * jitter);
  const floor = Math.min(200, capped);
  const upper = Math.max(0, capped - floor);
  const floorWithJitter = floor + Math.floor(upper * Math.random());

  return Math.max(floor, jittered + floorWithJitter);
}

function heartbeatLeaseExpiresAt(): string {
  const leaseMs = Math.max(15_000, TEAM_TASK_CLAIM_TTL_MS + TEAM_TASK_CLAIM_LEASE_SLACK_MS);
  return new Date(Date.now() + leaseMs).toISOString();
}

function normalizeRunningClaims(state: TeamRunState): TeamRunState {
  const nowMs = Date.now();
  let hadReclaim = false;

  const recovered = state.tasks.map((task) => {
    if (!isClaimExpired(task, nowMs)) {
      return task;
    }

    hadReclaim = true;
    const initial = {
      ...task,
      workerId: undefined,
      claimToken: undefined,
      claimExpiresAt: undefined,
      lastHeartbeatAt: undefined,
      error: task.error
        ? `${task.error}\nTask reclaim reason: ${
          isTaskNonReporting(task, nowMs) ? 'non-reporting worker detected' : 'claim lease expired'
        }; task reclaimed for rescheduling`
        : `Task reclaim reason: ${
          isTaskNonReporting(task, nowMs) ? 'non-reporting worker detected' : 'claim lease expired'
        }; task reclaimed for rescheduling`,
    };

    return {
      ...initial,
      status: initial.dependencies?.length ? ('blocked' as TeamTaskStatus) : ('queued' as TeamTaskStatus),
    };
  });

  const unlocked = recovered.map((task) => {
    if (task.status !== 'blocked') {
      return task;
    }

    return {
      ...task,
      status: isTaskReady(task, recovered) ? ('queued' as TeamTaskStatus) : 'blocked',
    };
  });

  if (!hadReclaim) {
    return state;
  }

  return {
    ...state,
    tasks: unlocked,
  };
}

function refreshRunningClaims(state: TeamRunState): TeamRunState {
  const nowMs = Date.now();
  const heartbeatAt = new Date(nowMs).toISOString();
  const heartbeatIntervalMs = Math.max(1_000, TEAM_TASK_HEARTBEAT_MS);
  const refreshed = state.tasks.map((task) => {
    if (task.status !== 'running') {
      return task;
    }

    const isClaimFresh = parseIsoMs(task.claimExpiresAt) !== null && parseIsoMs(task.claimExpiresAt)! > nowMs;
    const heartbeatDue = parseIsoMs(task.lastHeartbeatAt) === null || nowMs - parseIsoMs(task.lastHeartbeatAt)! >= heartbeatIntervalMs;

    if (isClaimFresh && !heartbeatDue) {
      return task;
    }

    return {
      ...task,
      workerId: TEAM_WORKER_ID,
      claimToken: task.claimToken ?? randomTaskToken(`task-${task.id}`),
      lastHeartbeatAt: heartbeatAt,
      claimExpiresAt: heartbeatLeaseExpiresAt(),
    };
  });

  return {
    ...state,
    tasks: refreshed,
  };
}

function buildNormalizedTaskOutput(task: TeamTaskState, runner: CodexRunOutput) {
  const parsed = asObject(runner.parsed);
  const output: Record<string, unknown> = {
    status: runner.status === 0 ? 'ok' : 'error',
    exitCode: runner.status,
    stdout: runner.stdout,
    stderr: runner.stderr,
    parsed,
    task: task.id,
    role: task.role,
    attempt: task.attempt,
  };

  return {
    output,
    requiresApproval: detectApprovalRequired(parsed),
  };
}

type PlannerOutputValidation = {
  planSummary: string;
  tasks: TeamTaskTemplate[];
};

function normalizeTeamRole(value: unknown): TeamRole | null {
  if (
    value === 'planner' ||
    value === 'researcher' ||
    value === 'designer' ||
    value === 'developer' ||
    value === 'executor' ||
    value === 'verifier'
  ) {
    return value;
  }

  return null;
}

function parsePlannerOutput(value: unknown): PlannerOutputValidation | null {
  const parsed = asObject(value);
  const planSummary = typeof parsed.plan_summary === 'string' ? parsed.plan_summary.trim() : '';
  if (!planSummary) {
    return null;
  }

  const tasksRaw = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  if (tasksRaw.length === 0) {
    return null;
  }

  const taskIds = new Set<string>();
  const tasks: TeamTaskTemplate[] = [];

  for (const entry of tasksRaw) {
    const source = asObject(entry);
    const role = normalizeTeamRole(source.role);
    if (!role) {
      return null;
    }

    const subject = typeof source.subject === 'string' && source.subject.trim() ? source.subject.trim() : '';
    const description = typeof source.description === 'string' && source.description.trim() ? source.description.trim() : '';
    if (!subject && !description) {
      return null;
    }

    const idRaw = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : '';
    const id = idRaw || `${role}-${subject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` || `${role}-${tasks.length + 1}`;
    if (taskIds.has(id)) {
      return null;
    }
    taskIds.add(id);

    const dependencySource = source.depends_on ?? source.dependencies;
    const dependenciesRaw = Array.isArray(dependencySource) ? dependencySource : [];
    const dependencies = dependenciesRaw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);

    tasks.push({
      id,
      name: subject || description,
      role,
      dependencies,
      maxAttempts: typeof source.maxAttempts === 'number' && source.maxAttempts > 0 ? Math.floor(source.maxAttempts) : 1,
      timeoutSeconds:
        typeof source.timeoutSeconds === 'number' && source.timeoutSeconds > 0 ? Math.floor(source.timeoutSeconds) : 1200,
    });
  }

  const idSet = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependencies ?? []) {
      if (!idSet.has(dependency)) {
        return null;
      }
    }
  }

  const visit = new Map<string, 'unvisited' | 'visiting' | 'visited'>();
  const byId = new Map(tasks.map((task) => [task.id, task]));

  function hasCycle(taskId: string): boolean {
    const state = visit.get(taskId) ?? 'unvisited';
    if (state === 'visiting') {
      return true;
    }
    if (state === 'visited') {
      return false;
    }

    visit.set(taskId, 'visiting');
    const task = byId.get(taskId);
    if (!task) {
      visit.set(taskId, 'visited');
      return false;
    }

    for (const dependency of task.dependencies ?? []) {
      if (hasCycle(dependency)) {
        return true;
      }
    }

    visit.set(taskId, 'visited');
    return false;
  }

  for (const id of idSet) {
    if (hasCycle(id)) {
      return null;
    }
  }

  return {
    planSummary,
    tasks,
  };
}

function parseVerifierResult(value: unknown): 'pass' | 'fail' | null {
  const parsed = asObject(value);
  const status = parsed.status;
  if (status !== 'pass' && status !== 'fail') {
    return null;
  }
  return status;
}

function lockTaskForExecution(task: TeamTaskState): Partial<TeamTaskState> {
  return {
    status: 'running',
    attempt: task.attempt + 1,
    startedAt: toISOStringNow(),
    workerId: TEAM_WORKER_ID,
    claimToken: randomTaskToken(`task-${task.id}`),
    claimExpiresAt: heartbeatLeaseExpiresAt(),
    lastHeartbeatAt: toISOStringNow(),
    error: undefined,
    output: undefined,
  };
}

function resolveStateRoot(): string {
  const explicit = process.env.OMX_STATE_ROOT;
  if (explicit) {
    return path.resolve(explicit);
  }

  return path.resolve(process.cwd(), '.omx', 'state', 'jobs');
}

function getQueueDirs(stateRoot: string) {
  return {
    root: path.join(stateRoot, '.queue'),
    pending: path.join(stateRoot, '.queue', 'pending'),
    processing: path.join(stateRoot, '.queue', 'processing'),
  };
}

async function ensureDir(filePath: string) {
  await fs.mkdir(filePath, { recursive: true });
}

async function claimQueuedJob(directories: { pending: string; processing: string; root: string }): Promise<string | null> {
  const entries = await fs.readdir(directories.pending, { withFileTypes: true });
  const pendingFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const file of pendingFiles) {
    const pendingPath = path.join(directories.pending, file.name);
    const jobId = file.name.replace(/\.json$/, '');
    const processingPath = path.join(directories.processing, `${jobId}.json`);

    try {
      await fs.rename(pendingPath, processingPath);
      await fs.access(processingPath);
      return jobId;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        continue;
      }
      if (err.code === 'EXDEV') {
        throw error;
      }
      continue;
    }
  }

  return null;
}

async function reapStaleClaims(directories: { pending: string; processing: string; root: string }) {
  const staleMs = Math.max(fileQueueStaleMs, 60_000);
  const entries = await fs.readdir(directories.processing, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const processingPath = path.join(directories.processing, entry.name);
    try {
      const stat = await fs.stat(processingPath);
      if (Date.now() - stat.mtimeMs <= staleMs) {
        continue;
      }

      const jobId = entry.name.replace(/\.json$/, '');
      const pendingPath = path.join(directories.pending, entry.name);
      const exists = await fs
        .access(pendingPath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        await fs.rename(processingPath, pendingPath);
      } else {
        await fs.unlink(processingPath);
      }
    } catch (error) {
      continue;
    }
  }
}

async function clearClaim(jobId: string, directories: { pending: string; processing: string; root: string }) {
  const processingPath = path.join(directories.processing, `${jobId}.json`);
  await fs.unlink(processingPath).catch(() => undefined);
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return parsed >= 0 ? parsed : fallback;
}

function normalizeJobOptions(raw: Record<string, unknown> | null): JobOptionsNormalized {
  const obj = asObject(raw);
  const team = asObject(obj.team);
  const defaultKeepTmux = (process.env.TMUX_KEEP_SESSION_ON_FINISH ?? '1') !== '0';

  const maxMinutes = toPositiveInt(obj.maxMinutes, 60);
  const keepTmuxSession = typeof obj.keepTmuxSession === 'boolean' ? obj.keepTmuxSession : defaultKeepTmux;
  const parallelism = toPositiveInt(team.parallelTasks, toPositiveInt(obj.parallelTasks, 1));
  const maxFixAttempts = toNonNegativeInt(team.maxFixAttempts, toNonNegativeInt(obj.maxFixAttempts, 0));

  const commandObj = asObject(obj.agentCommands);
  const agentCommands: Partial<Record<TeamRole, string>> = {};

  for (const role of TEAM_ROLES) {
    const value = commandObj[role];
    if (typeof value === 'string' && value.trim()) {
      agentCommands[role] = value.trim();
    }
  }

  return {
    maxMinutes,
    keepTmuxSession,
    parallelism,
    maxFixAttempts,
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
    TASK_ID: context.taskId ?? '',
    PHASE: context.phase ?? '',
    ATTEMPT: String(context.attempt ?? 1),
    WORKDIR: context.workdir,
    DEPENDENCY_OUTPUTS: context.dependencyOutputs ?? '',
  };

  return template
    .replace(/\{([A-Z_]+)\}/g, (raw, key: string) => map[key] ?? raw)
    .replace(/\$\{([A-Z_]+)\}/g, (raw, key: string) => map[key] ?? raw)
    .replace(/\$([A-Z_]+)/g, (raw, key: string) => map[key] ?? raw);
}

function commandResultOrThrow(
  binary: string,
  args: string[],
  options?: {
    cwd?: string;
    allowFailure?: boolean;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
) {
  const result = spawnSync(binary, args, {
    cwd: options?.cwd,
    env: options?.env,
    encoding: 'utf8',
    timeout: options?.timeout,
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

interface CodexRunOutput {
  status: number;
  stdout: string;
  stderr: string;
  parsed?: Record<string, unknown>;
}

function resolveCliBinary(provider: Provider): string {
  const providerBinary = process.env[`JOB_${provider.toUpperCase()}_CLI_BIN`];
  if (providerBinary?.trim()) {
    return providerBinary.trim();
  }

  const genericBinary = process.env.JOB_CLI_BIN;
  if (genericBinary?.trim()) {
    return genericBinary.trim();
  }

  return DEFAULT_CLI_BINARIES[provider] ?? 'codex';
}

function resolveCliCommandTemplate(command: string, provider: Provider): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return '';
  }

  const token = trimmed.split(/\s+/)[0] ?? '';
  const binary = resolveCliBinary(provider);
  const commandBase = token.endsWith(`/${path.basename(binary)}`) ? path.basename(binary) : token;
  if (SHELL_COMMAND_PREFIXES.has(commandBase)) {
    return 'shell';
  }

  if (token === binary || token === path.basename(binary) || token.endsWith(`/${path.basename(binary)}`)) {
    return binary;
  }

  return '';
}

function runCodexCommand(provider: Provider, command: string, workdir: string, timeoutMs = 120000): CodexRunOutput {
  const trimmed = command.trim();
  const binary = resolveCliBinary(provider);
  const directMode = resolveCliCommandTemplate(trimmed, provider);
  const result = directMode
    ? commandResultOrThrow('sh', ['-lc', trimmed], {
        cwd: workdir,
        allowFailure: true,
        timeout: timeoutMs,
        env: process.env,
      })
    : commandResultOrThrow(
        binary,
        [
          'exec',
          '--json',
          '--full-auto',
          '--skip-git-repo-check',
          '--cd',
          workdir,
          trimmed,
        ],
        {
          cwd: workdir,
          env: process.env,
          allowFailure: true,
          timeout: timeoutMs,
        },
      );

  const payload = result.stdout + '\n' + result.stderr;
  let parsed: unknown = null;

  for (const line of payload.split('\n').map((item) => item.trim()).filter(Boolean).reverse()) {
    try {
      const parsedLine = JSON.parse(line);
      if (parsedLine && typeof parsedLine === 'object') {
        parsed = parsedLine;
      }
      break;
    } catch {
      continue;
    }
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNumericExitCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

async function readPaneCompletion(
  pane: PaneRuntime,
  paneState?: PaneState,
): Promise<PaneCompletion> {
  let exitStatus: number | null = null;
  let completionMarkerSeen = false;
  let completionMarkerSource: CompletionMarkerSource = 'unknown';

  const resultFileStatus = await fs.readFile(pane.resultPath, 'utf8').catch(() => null);
  if (resultFileStatus) {
    try {
      const parsed = JSON.parse(resultFileStatus.trim()) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') {
        const parsedExit = parseNumericExitCode(parsed.exitCode);
        if (parsedExit !== null) {
          exitStatus = parsedExit;
          completionMarkerSeen = true;
          completionMarkerSource = 'result-file';
        }
      }
    } catch {
      // ignore malformed completion files
    }
  }

  if (exitStatus === null) {
    const logContent = await fs.readFile(pane.logPath, 'utf8').catch(() => null);
    if (logContent) {
      const markerRegex = new RegExp(
        `^${escapeRegExp(pane.completionMarker)}\\s+.*status=([+-]?\\d+)`,
        'm',
      );
      const match = logContent.match(markerRegex);
      if (match) {
        const status = parseNumericExitCode(match[1]);
        if (status !== null) {
          exitStatus = status;
          completionMarkerSeen = true;
          completionMarkerSource = 'log-line';
        }
      }
    }
  }

  if (exitStatus === null && paneState?.deadStatus !== null && paneState?.deadStatus !== undefined) {
    exitStatus = paneState.deadStatus;
    completionMarkerSource = 'tmux-dead-status';
  }

  return {
    role: pane.role,
    paneId: pane.paneId,
    logPath: pane.logPath,
    resultPath: pane.resultPath,
    dead: paneState?.dead ?? false,
    deadStatus: paneState?.deadStatus ?? null,
    exitStatus,
    completionMarkerSeen,
    completionMarkerSource,
  };
}

async function addEvent(jobId: string, type: string, message: string, payload?: Record<string, unknown>) {
  await jobStore.addEvent(jobId, type, message, payload);
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

function normalizeTemplateTasks(raw: unknown): TeamTaskTemplate[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      const record = asObject(item);
      const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : '';
      const role = record.role;
      if (
        role !== 'planner' &&
        role !== 'researcher' &&
        role !== 'designer' &&
        role !== 'developer' &&
        role !== 'executor' &&
        role !== 'verifier'
      ) {
        return null;
      }

      const dependencies = Array.isArray(record.dependencies)
        ? record.dependencies.filter((dependency) => typeof dependency === 'string')
        : [];
      const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `${role}-${name.toLowerCase().replace(/\\W+/g, '-')}`;

      return {
        id,
        name: name || `${role} task`,
        role,
        dependencies: dependencies as string[],
        maxAttempts: Number.isFinite(typeof record.maxAttempts === 'number' ? record.maxAttempts : Number.NaN)
          ? Math.max(1, Math.floor(record.maxAttempts as number))
          : 1,
        timeoutSeconds: Number.isFinite(typeof record.timeoutSeconds === 'number' ? record.timeoutSeconds : Number.NaN)
          ? Math.max(60, Math.floor(record.timeoutSeconds as number))
          : 1200,
      } as TeamTaskTemplate;
    })
    .filter((item): item is TeamTaskTemplate => item !== null);
}

function normalizeTeamTaskTemplateSource(rawTeamOptions: Record<string, unknown>): Array<Record<string, unknown>> {
  const preferred = rawTeamOptions.teamTasks;
  if (Array.isArray(preferred)) {
    return preferred.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object') as Array<Record<string, unknown>>;
  }

  const legacy = rawTeamOptions.taskTemplates;
  if (Array.isArray(legacy)) {
    return legacy.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object') as Array<Record<string, unknown>>;
  }

  return [];
}

function defaultTeamTaskTemplate(): TeamTaskState[] {
  return [
    {
      id: 'team-planner',
      name: 'Plan breakdown and acceptance criteria',
      role: 'planner',
      dependencies: [],
      status: 'queued',
      maxAttempts: 1,
      timeoutSeconds: 1200,
      attempt: 0,
    },
    {
      id: 'team-research',
      name: 'Research references and constraints',
      role: 'researcher',
      dependencies: ['team-planner'],
      status: 'blocked',
      maxAttempts: 1,
      timeoutSeconds: 1200,
      attempt: 0,
    },
    {
      id: 'team-designer',
      name: 'Propose design and rollout strategy',
      role: 'designer',
      dependencies: ['team-planner'],
      status: 'blocked',
      maxAttempts: 1,
      timeoutSeconds: 1200,
      attempt: 0,
    },
    {
      id: 'team-developer',
      name: 'Implement changes in branch',
      role: 'developer',
      dependencies: ['team-designer', 'team-research'],
      status: 'blocked',
      maxAttempts: 2,
      timeoutSeconds: 3600,
      attempt: 0,
    },
    {
      id: 'team-executor',
      name: 'Run commands, tests, and build',
      role: 'executor',
      dependencies: ['team-developer'],
      status: 'blocked',
      maxAttempts: 1,
      timeoutSeconds: 1200,
      attempt: 0,
    },
    {
      id: 'team-verifier',
      name: 'Verify results and summarize',
      role: 'verifier',
      dependencies: ['team-executor'],
      status: 'blocked',
      maxAttempts: 1,
      timeoutSeconds: 1200,
      attempt: 0,
    },
  ];
}

function seedTeamStateFromOptions(options: Record<string, unknown> | null): TeamRunState {
  const base = asObject(options);
  const team = asObject(base.team);
  const state = asObject(team.state);
  const templates = normalizeTemplateTasks(normalizeTeamTaskTemplateSource(team));
  const initialTasks =
    templates.length > 0
      ? templates.map((task) => ({
          ...task,
          status: task.dependencies && task.dependencies.length > 0 ? ('blocked' as TeamTaskStatus) : ('queued' as TeamTaskStatus),
          attempt: 0,
        }))
      : defaultTeamTaskTemplate();

  if (state.status && Array.isArray(state.tasks)) {
    const stateTasks = state.tasks as TeamTaskState[];
    const persistedTasks = stateTasks.map((item, idx) => ({
      ...item,
      status:
        item.status === 'running'
          ? ('queued' as TeamTaskStatus)
          : item.status === 'queued' && item.dependencies?.length
            ? (isTaskReady(item, stateTasks) ? ('queued' as TeamTaskStatus) : ('blocked' as TeamTaskStatus))
            : normalizeTaskStatus(item.status),
      attempt: Number.isFinite(item.attempt) ? item.attempt : 0,
      output: item.output && typeof item.output === 'object' ? (item.output as Record<string, unknown>) : undefined,
      startedAt: typeof item.startedAt === 'string' ? item.startedAt : undefined,
      finishedAt: typeof item.finishedAt === 'string' ? item.finishedAt : undefined,
    }));

    return {
      status: (state.status as TeamRunState['status']) ?? 'queued',
      phase: typeof state.phase === 'string' && state.phase.trim() ? state.phase : 'planning',
      fixAttempts: 0,
      maxFixAttempts: toNonNegativeInt(state.maxFixAttempts, toNonNegativeInt(asObject(team).maxFixAttempts, 1)),
      parallelTasks: Math.max(1, toPositiveInt(state.parallelTasks, toPositiveInt(asObject(team).parallelTasks, 1))),
      currentTaskId: typeof state.currentTaskId === 'string' ? state.currentTaskId : null,
      mailbox: normalizeMailboxMessages(state.mailbox),
      tasks: persistedTasks,
    };
  }

  const normalized = initialTasks;
  return {
    status: 'queued',
    phase: typeof state.phase === 'string' && state.phase.trim() ? state.phase : 'planning',
    fixAttempts: 0,
    maxFixAttempts: toNonNegativeInt(asObject(team).maxFixAttempts, 2),
    parallelTasks: Math.max(1, toPositiveInt(asObject(team).parallelTasks, 1)),
    mailbox: [],
    tasks: normalized,
  };
}

async function readTeamState(job: JobRecord): Promise<TeamRunState> {
  const base = asObject(job.options);
  const team = asObject(base.team);
  const state = asObject(team.state);
  const seed = seedTeamStateFromOptions(job.options);
  const tasks = Array.isArray(state.tasks)
    ? (state.tasks as TeamTaskState[]).map((task, idx) => ({
        ...task,
        status: normalizeTaskForRead(task, state.tasks as TeamTaskState[]),
        output: asObject(task.output) as Record<string, unknown>,
        attempt: Number.isFinite(task.attempt) ? task.attempt : 0,
      }))
    : seed.tasks;

  const merged: TeamRunState = {
    status: (state.status as TeamRunState['status']) ?? 'queued',
    phase: typeof state.phase === 'string' ? state.phase : seed.phase,
    fixAttempts: toPositiveInt(state.fixAttempts, 0),
    maxFixAttempts: toNonNegativeInt(state.maxFixAttempts, seed.maxFixAttempts),
    parallelTasks: Math.max(1, toPositiveInt(state.parallelTasks, seed.parallelTasks)),
    currentTaskId: typeof state.currentTaskId === 'string' ? state.currentTaskId : null,
    mailbox: normalizeMailboxMessages(state.mailbox),
    tasks,
  };

  return {
    ...merged,
    mailbox: normalizeMailboxMessages(state.mailbox),
    tasks: tasks.map((task, idx) => ({
      ...task,
      status:
        task.status === 'queued' && task.dependencies?.length
          ? (isTaskReady(task, tasks) ? 'queued' : 'blocked')
          : task.status,
      attempt: Number.isFinite(task.attempt) ? task.attempt : 0,
    })),
  };
}

function collectDependencyOutputs(task: TeamTaskState, tasks: TeamTaskState[]): Record<string, unknown> {
  const dependencyOutputs: Record<string, unknown> = {};
  const byId = new Map(tasks.map((item) => [item.id, item]));

  for (const dependencyId of task.dependencies ?? []) {
    const dependency = byId.get(dependencyId);
    if (!dependency || !dependency.output) {
      continue;
    }
    dependencyOutputs[dependencyId] = dependency.output;
  }

  return dependencyOutputs;
}

function normalizeMailboxMessages(value: unknown): TeamMailboxMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const mapped: Array<TeamMailboxMessage | null> = value.map((raw, index): TeamMailboxMessage | null => {
      const item = asObject(raw);
      const kind = item.kind;
      const message = typeof item.message === 'string' && item.message.trim() ? item.message.trim() : '';
      const delivered =
        typeof item.delivered === 'boolean'
          ? item.delivered
          : typeof item.deliveredAt === 'string' && item.deliveredAt.trim().length > 0;

      if (!['question', 'instruction', 'notice', 'reassign'].includes(String(kind))) {
        return null;
      }

      const createdAt = typeof item.createdAt === 'string' && item.createdAt.trim() ? item.createdAt : toISOStringNow();
      const deliveredAt = typeof item.deliveredAt === 'string' && item.deliveredAt.trim() ? item.deliveredAt : null;
      const taskId = typeof item.taskId === 'string' && item.taskId.trim() ? item.taskId.trim() : undefined;
      const rawTo = item.to;
      const validTo: TeamMailboxMessage['to'] =
        rawTo === 'leader' || rawTo === 'planner' || rawTo === 'researcher' || rawTo === 'designer' || rawTo === 'developer' || rawTo === 'executor' || rawTo === 'verifier'
          ? rawTo
          : Array.isArray(rawTo) && rawTo.every((entry) => entry === 'planner' || entry === 'researcher' || entry === 'designer' || entry === 'developer' || entry === 'executor' || entry === 'verifier')
            ? (rawTo as TeamRole[])
            : undefined;

      if (!message) {
        return null;
      }

      const normalized: TeamMailboxMessage = {
        id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `mailbox-${Date.now().toString(36)}-${index}`,
        kind: kind as TeamMailboxKind,
        taskId,
        message,
        payload: asObject(item.payload),
        createdAt,
        deliveredAt,
        delivered,
        meta: asObject(item.meta),
      };

      if (validTo !== undefined) {
        normalized.to = validTo;
      }

      return normalized;
    });

  return mapped
    .filter((item): item is TeamMailboxMessage => item !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

async function applyMailboxReassign(
  jobId: string,
  state: TeamRunState,
): Promise<{ state: TeamRunState; changed: boolean; hasUndeliveredMessages: boolean }> {
  const queue = Array.isArray(state.mailbox) ? [...state.mailbox] : [];
  let changed = false;
  let hasUndeliveredMessages = false;
  let nextTasks = state.tasks;
  const nextMailbox = queue.map((message) => {
    if (message.delivered) {
      return message;
    }

    hasUndeliveredMessages = true;

    if (message.kind !== 'reassign' || !message.taskId) {
      return {
        ...message,
        delivered: true,
        deliveredAt: toISOStringNow(),
      };
    }

    let reassigned = false;
    nextTasks = nextTasks.map((task) => {
      if (task.id !== message.taskId || reassigned) {
        return task;
      }

      const updatedStatus = task.dependencies?.length && !isTaskReady(task, state.tasks) ? ('blocked' as TeamTaskStatus) : ('queued' as TeamTaskStatus);
      changed = true;
      reassigned = true;

      addEvent(jobId, 'team.task.reassigned', `Task ${task.id} reassigned by mailbox instruction`, {
        taskId: task.id,
        role: task.role,
        reason: message.message,
      }).catch(() => undefined);

      return {
        ...task,
        status: updatedStatus,
        attempt: 0,
        error: `Task re-assigned by mail instruction: ${message.message}`,
        workerId: undefined,
        claimToken: undefined,
        claimExpiresAt: undefined,
        lastHeartbeatAt: undefined,
      };
    });

    return {
      ...message,
      delivered: true,
      deliveredAt: toISOStringNow(),
    };
  });

  if (!hasUndeliveredMessages) {
    return {
      state,
      changed: false,
      hasUndeliveredMessages: false,
    };
  }

  const unresolved = queue.map((message) => ({
    ...message,
    delivered: true,
    deliveredAt: message.deliveredAt ?? toISOStringNow(),
  }));

  return {
    state: {
      ...state,
      mailbox: unresolved,
      tasks: nextTasks,
    },
    changed,
    hasUndeliveredMessages: true,
  };
}

function normalizeTaskForRead(task: TeamTaskState, tasks: TeamTaskState[]): TeamTaskStatus {
  const status = normalizeTaskStatus(task.status);
  if (status === 'running') {
    return 'queued';
  }

  if (status === 'queued' && task.dependencies?.length && !isTaskReady({ ...task, status: 'queued' }, tasks)) {
    return 'blocked';
  }

  return status;
}

function isTaskReady(task: TeamTaskState, tasks: TeamTaskState[]): boolean {
  if (task.status === 'succeeded' || task.status === 'running') {
    return true;
  }

  if (!task.dependencies || task.dependencies.length === 0) {
    return task.status !== 'failed' && task.status !== 'canceled';
  }

  const taskById = new Map(tasks.map((item) => [item.id, item]));
  return task.dependencies.every((dependencyId) => {
    const dependency = taskById.get(dependencyId);
    return dependency?.status === 'succeeded';
  });
}

function selectRunnableTasks(state: TeamRunState): TeamTaskState[] {
  return state.tasks
    .filter((task) => task.status === 'queued' || task.status === 'blocked')
    .filter((task) => isTaskReady(task, state.tasks))
    .sort((a, b) => {
      const ai = TEAM_ROLES.indexOf(a.role);
      const bi = TEAM_ROLES.indexOf(b.role);
      return ai - bi;
    });
}

function collectFailureCascade(state: TeamRunState): Set<string> {
  const affected = new Set(state.tasks.filter((task) => task.status === 'failed').map((task) => task.id));
  if (affected.size === 0) {
    return affected;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const task of state.tasks) {
      if (affected.has(task.id)) {
        continue;
      }

      const dependsOnFailed = (task.dependencies ?? []).some((dependencyId) => affected.has(dependencyId));
      if (dependsOnFailed) {
        affected.add(task.id);
        changed = true;
      }
    }
  }

  return affected;
}

function buildFailureRecoveryState(state: TeamRunState): TeamRunState | null {
  if (!state.tasks.some((task) => task.status === 'failed')) {
    return null;
  }

  const retryIds = collectFailureCascade(state);
  if (retryIds.size === 0) {
    return null;
  }

  const resetTasks = state.tasks.map((task) => {
    if (!retryIds.has(task.id)) {
      return task;
    }

    const status = task.dependencies?.length ? ('blocked' as TeamTaskStatus) : ('queued' as TeamTaskStatus);
    return {
      ...task,
      status,
      startedAt: undefined,
      finishedAt: undefined,
      output: undefined,
      error: undefined,
    };
  });

  const readyTasks = resetTasks.map((task) => {
    if (!retryIds.has(task.id) || task.status === 'succeeded') {
      return task;
    }

    return {
      ...task,
      status: isTaskReady(task, resetTasks) ? ('queued' as TeamTaskStatus) : ('blocked' as TeamTaskStatus),
    };
  });

  return {
    ...state,
    status: 'running',
    fixAttempts: state.fixAttempts + 1,
    currentTaskId: null,
    tasks: readyTasks,
  };
}

function allTasksFinished(state: TeamRunState): boolean {
  return state.tasks.every((task) => TEAM_TERMINAL_TASK_STATUS.includes(task.status));
}

function toTeamTaskPhase(tasks: TeamTaskState[]): string {
  const running = tasks.find((task) => task.status === 'running');
  if (running) {
    return running.role;
  }

  const queued = tasks.find((task) => task.status === 'queued');
  if (queued) {
    return queued.role;
  }

  const failed = tasks.find((task) => task.status === 'failed');
  if (failed) {
    return `retry_${failed.role}`;
  }

  const blocked = tasks.find((task) => task.status === 'blocked');
  if (blocked) {
    return blocked.role;
  }

  return tasks.every((task) => task.status === 'succeeded') ? 'completed' : 'blocked';
}

async function persistTeamState(job: JobRecord, state: TeamRunState) {
  const current = await jobStore.findJobById(job.id);
  if (!current) {
    throw new Error(`job not found: ${job.id}`);
  }
  const base = asObject(current.options);
  const team = asObject(base.team);
  await jobStore.updateJob(job.id, {
    options: {
      ...base,
      team: {
        ...team,
        state: state as unknown as Record<string, unknown>,
      },
    },
  });
}

function applyTaskPatch(state: TeamRunState, taskId: string, patch: Partial<TeamTaskState>): TeamRunState {
  const nextTasks = state.tasks.map((task) => {
    if (task.id !== taskId) {
      return task;
    }

    return {
      ...task,
      ...patch,
      startedAt: patch.startedAt ?? task.startedAt,
      finishedAt: patch.finishedAt ?? task.finishedAt,
    };
  });

  const unlocked = nextTasks.map((item) => {
    if (item.status !== 'blocked') {
      return item;
    }
    return {
      ...item,
      status: isTaskReady(item, nextTasks) ? ('queued' as TeamTaskStatus) : 'blocked',
    };
  });

  const next = {
    ...state,
    tasks: unlocked,
    phase: selectRunnableTasks({ ...state, tasks: unlocked })[0]?.role ?? state.phase,
    currentTaskId: taskId,
  };

  return next;
}

function startTaskBatch(state: TeamRunState, tasks: TeamTaskState[]): TeamRunState {
  return tasks.reduce((nextState, task) => {
    const current = nextState.tasks.find((entry) => entry.id === task.id);
    if (!current) {
      return nextState;
    }

    if (current.status === 'running' || current.status === 'succeeded' || current.status === 'failed' || current.status === 'canceled') {
      return nextState;
    }

    if (!isTaskReady(current, nextState.tasks)) {
      return nextState;
    }

    return applyTaskPatch(nextState, task.id, lockTaskForExecution(current));
  }, state);
}

interface TeamTaskExecutionResult {
  taskId: string;
  patch: Partial<TeamTaskState>;
  requiresApproval?: boolean;
}

async function executeTeamTask(
  job: JobRecord,
  options: JobOptionsNormalized,
  task: TeamTaskState,
  allTasks: TeamTaskState[],
  phase: string,
  workspaceDir: string,
): Promise<TeamTaskExecutionResult> {
  const commandTemplate = resolveRoleCommand(job.provider, task.role, options.agentCommands);
  let currentAttempt = task.attempt;

  await addEvent(job.id, 'team.task.started', `Role=${task.role} task=${task.id} attempt=${currentAttempt}`, {
    taskId: task.id,
    role: task.role,
    attempt: currentAttempt,
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const taskForAttempt = {
      ...task,
      attempt: currentAttempt,
    };

    const command = applyTemplate(commandTemplate, {
      jobId: job.id,
      provider: job.provider,
      mode: job.mode,
      repo: job.repo,
      ref: job.ref,
      role: task.role,
      task: `${task.name}\n${task.role} objective:\n${job.task}`,
      taskId: task.id,
      phase,
      attempt: currentAttempt,
      workdir: workspaceDir,
      dependencyOutputs: summarizeValueForTemplate(collectDependencyOutputs(task, allTasks)),
    });

    const runner = runCodexCommand(
      job.provider,
      command,
      workspaceDir,
      Math.max(30_000, (task.timeoutSeconds ?? 1200) * 1000),
    );
    const normalized = buildNormalizedTaskOutput(taskForAttempt, runner);
    const plannerValidation = task.role === 'planner' ? parsePlannerOutput(normalized.output.parsed) : null;
    const verifierStatus = task.role === 'verifier' ? parseVerifierResult(normalized.output.parsed) : null;
    const validationError =
      task.role === 'planner'
        ? (plannerValidation ? undefined : 'Planner output did not match required JSON schema')
        : verifierStatus === 'fail'
          ? 'Verifier reported status=fail'
          : undefined;

    if (validationError) {
      await addEvent(job.id, 'team.task.validation_failed', `${task.id} validation failed`, {
        taskId: task.id,
        role: task.role,
        attempt: currentAttempt,
        reason: validationError,
        output: normalized.output,
      });
    }

    if (normalized.requiresApproval) {
      await addEvent(job.id, 'team.task.approval_required', `${task.id} requested approval`, {
        taskId: task.id,
        role: task.role,
        attempt: currentAttempt,
        output: normalized.output,
      });

      return {
        taskId: task.id,
        requiresApproval: true,
        patch: {
          status: 'queued',
          attempt: currentAttempt,
          error: 'Task output requested approval before continuing.',
          output: normalized.output,
          finishedAt: new Date().toISOString(),
          workerId: undefined,
          claimToken: undefined,
          claimExpiresAt: undefined,
          lastHeartbeatAt: undefined,
        },
      };
    }

    const hasExecutionFailure = runner.status !== 0 || Boolean(validationError);
    const retryFailure = hasExecutionFailure
      ? detectRateLimitFailure(asObject(normalized.output.parsed), `${runner.stderr}\n${runner.stdout}`)
      : null;
    const failureKind: RetryFailureKind = retryFailure?.kind ?? 'general';
    const retryMaxAttempts = hasExecutionFailure ? getRetryMaxAttempts(taskForAttempt, failureKind) : 0;

    if (!hasExecutionFailure) {
      await addEvent(job.id, 'team.task.completed', `${task.id} succeeded`, {
        taskId: task.id,
        role: task.role,
        attempt: currentAttempt,
        status: 'succeeded',
      });
      return {
        taskId: task.id,
        patch: {
          status: 'succeeded',
          attempt: currentAttempt,
          output: normalized.output,
          finishedAt: new Date().toISOString(),
          workerId: undefined,
          claimToken: undefined,
          claimExpiresAt: undefined,
          lastHeartbeatAt: undefined,
        },
      };
    }

    if (currentAttempt < retryMaxAttempts) {
      const delayMs = getRetryDelayMs(currentAttempt, failureKind, retryFailure?.retryAfterMs);
      await addEvent(job.id, 'team.task.retry', `${task.id} failed; scheduling retry`, {
        taskId: task.id,
        role: task.role,
        attempt: currentAttempt,
        kind: failureKind,
        maxAttempts: retryMaxAttempts,
        retryAfterMs: retryFailure?.retryAfterMs,
        delayMs,
      });
      await addEvent(job.id, 'team.task.completed', `${task.id} completed with retry`, {
        taskId: task.id,
        role: task.role,
        attempt: currentAttempt,
        status: 'queued',
      });
      await sleep(delayMs);
      currentAttempt += 1;
      continue;
    }

    await addEvent(job.id, 'team.task.completed', `${task.id} failed`, {
      taskId: task.id,
      role: task.role,
      attempt: currentAttempt,
      status: 'failed',
    });
    return {
      taskId: task.id,
      patch: {
        status: 'failed',
        attempt: currentAttempt,
        error: validationError ?? `${runner.stderr || runner.stdout}`.slice(0, 4000),
        output: normalized.output,
        finishedAt: new Date().toISOString(),
        workerId: undefined,
        claimToken: undefined,
        claimExpiresAt: undefined,
        lastHeartbeatAt: undefined,
      },
    };
  }
}

async function runTeamOrchestration(job: JobRecord): Promise<RunResult> {
  await fs.mkdir(workRoot, { recursive: true });
  const runDir = path.join(workRoot, job.id);
  await fs.mkdir(runDir, { recursive: true });
  const options = normalizeJobOptions(job.options);
  const workspaceDir = await prepareWorkspace(job, runDir);

  let state = await readTeamState(job);
  state.status = 'running';
  await persistTeamState(job, state);

  let idleCycles = 0;
  let idleBackoff = 0;

  while (idleCycles < 600) {
    const latest = await jobStore.findJobById(job.id);

    if (latest?.status === 'canceled') {
      return { state: 'canceled' };
    }

    if (latest?.status === 'waiting_approval') {
      state.status = 'waiting_approval';
      await persistTeamState(job, state);
      return { state: 'waiting_approval' };
    }

    const current = await readTeamState(job);
    const nowMs = Date.now();
    const staleRunning = current.tasks.filter((task) => task.status === 'running' && isClaimExpired(task, nowMs));
    const nonReportingRunning = current.tasks.filter((task) => isTaskNonReporting(task, nowMs));
    const normalizedClaims = normalizeRunningClaims(current);
    const refreshedState = refreshRunningClaims(normalizedClaims);
    state = refreshedState;
    const mailboxResult = await applyMailboxReassign(job.id, state);
    state = mailboxResult.state;

    if (JSON.stringify(normalizedClaims) !== JSON.stringify(refreshedState) || mailboxResult.hasUndeliveredMessages) {
      const claimRecoveredTaskIds = state.tasks
        .filter((task) => task.status === 'queued' || task.status === 'blocked')
        .map((task) => task.id);
      if (claimRecoveredTaskIds.length > 0) {
        await addEvent(job.id, 'team.claim_recovered', 'Recovered or refreshed task claims for scheduling', {
          taskIds: claimRecoveredTaskIds,
        });
      }
      await persistTeamState(job, state);
    }

    if (staleRunning.length > 0) {
      await addEvent(job.id, 'team.task.non_reporting', 'Recovered stale running tasks based on heartbeat expiry', {
        taskIds: staleRunning.map((task) => task.id),
        reason: `claim lease / heartbeat stale (${TEAM_TASK_NON_REPORTING_GRACE_MS}ms grace)`,
      });
    }

    if (nonReportingRunning.length > staleRunning.length) {
      const nonReportingIds = nonReportingRunning.map((task) => task.id);
      await addEvent(job.id, 'team.task.non_reporting', 'Recovered tasks from non-reporting heartbeat lag', {
        taskIds: nonReportingIds,
        reason: `heartbeat stale over ${TEAM_TASK_NON_REPORTING_GRACE_MS}ms`,
      });
    }

    const parallelLimit = Math.max(1, state.parallelTasks ?? options.parallelism);
    const runnable = selectRunnableTasks(state).slice(0, parallelLimit);
    const hasRunning = state.tasks.some((task) => task.status === 'running');
    const hasQueued = state.tasks.some((task) => task.status === 'queued');

    if (runnable.length === 0 && allTasksFinished(state)) {
      const hasFailed = state.tasks.some((task) => task.status === 'failed');
      if (hasFailed && state.fixAttempts < state.maxFixAttempts) {
        const recovered = buildFailureRecoveryState(state);
        if (recovered) {
          state = recovered;
          await persistTeamState(job, state);
          await addEvent(job.id, 'team.retry', `Retrying failed task path (attempt ${state.fixAttempts}/${state.maxFixAttempts})`, {
            taskIds: state.tasks.map((task) => task.id),
          });
          continue;
        }
      }

      state.status = state.tasks.every((task) => task.status === 'succeeded') ? 'succeeded' : 'failed';
      await persistTeamState(job, state);
      await addEvent(job.id, 'team.completed', `Team run ${state.status}`);
      return {
        state: state.status === 'succeeded' ? 'succeeded' : 'failed',
        output: {
          phase: state.phase,
          status: state.status,
          tasks: state.tasks as unknown as Record<string, unknown>,
        },
      };
    }

    if (runnable.length === 0 && !hasRunning && !hasQueued) {
      if (state.tasks.some((task) => task.status === 'failed')) {
        if (state.fixAttempts >= state.maxFixAttempts) {
          state.status = 'failed';
          await persistTeamState(job, state);
          throw new Error('team run fixed attempts exhausted');
        }

        const recovered = buildFailureRecoveryState(state);
        if (recovered) {
          state = recovered;
          await persistTeamState(job, state);
          await addEvent(
            job.id,
            'team.retry',
            `Retrying failed task path (attempt ${state.fixAttempts}/${state.maxFixAttempts})`,
            {
              taskIds: state.tasks.map((task) => task.id),
            },
          );
          continue;
        }
      }

      if (state.fixAttempts >= state.maxFixAttempts) {
        state.status = 'failed';
        await persistTeamState(job, state);
        throw new Error('team run blocked with no runnable tasks');
      }

      state.status = 'running';
      state.fixAttempts += 1;
      await persistTeamState(job, state);
      await addEvent(job.id, 'team.blocked', 'No runnable task; applying fix attempt backoff');
      await sleep(withBackoffDelay(idleBackoff));
      idleBackoff += 1;
      continue;
    }

    if (runnable.length === 0) {
      idleCycles += 1;
      idleBackoff += 1;
      await sleep(withBackoffDelay(idleBackoff));
      continue;
    }

    idleCycles = 0;
    idleBackoff = 0;

    state = startTaskBatch(state, runnable);
    await persistTeamState(job, state);

    const runningBatch = runnable
      .map((task) => state.tasks.find((entry) => entry.id === task.id && entry.status === 'running'))
      .filter((task): task is TeamTaskState => Boolean(task));

    if (runningBatch.length === 0) {
      continue;
    }

    const results = await Promise.all(
      runningBatch.map((task) => executeTeamTask(job, options, task, state.tasks, state.phase, workspaceDir)),
    );

    for (const result of results) {
      state = applyTaskPatch(state, result.taskId, result.patch);
    }

    state.phase = toTeamTaskPhase(state.tasks);

    const requiresApproval = results.some((result) => result.requiresApproval);
    if (requiresApproval) {
      state.status = 'waiting_approval';
      const approvalTask = results.find((result) => result.requiresApproval);
      const approvalTaskId = approvalTask?.taskId ?? 'unknown';
      await persistTeamState(job, state);
      await jobStore.updateJob(job.id, {
        status: 'waiting_approval',
        approvalState: 'required',
        error: `Team task requires approval: ${approvalTaskId}`,
      });
      await addEvent(job.id, 'team.waiting_approval', `Team task requires approval: ${approvalTaskId}`, {
        taskId: approvalTaskId,
      });
      return {
        state: 'waiting_approval',
        output: {
          phase: state.phase,
          status: state.status,
          tasks: state.tasks as unknown as Record<string, unknown>,
        },
      };
    }

    await persistTeamState(job, state);
  }

  state.status = 'failed';
  await persistTeamState(job, state);
  return {
    state: 'failed',
      output: {
        reason: 'Team run loop timed out while waiting for task progress',
        state: state as unknown as Record<string, unknown>,
      },
    };
  }


function resolveRoleCommand(
  provider: Provider,
  role: TeamRole,
  customCommands: Partial<Record<TeamRole, string>>,
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

  if (provider === 'codex' || provider === 'gemini') {
    const defaultPrompt = `You are the ${role} agent in a Team-Codex run. Job ID: {JOB_ID}, repo: {REPO} ({REF}), task: {TASK}.`;
    const roleGuidance: Record<TeamRole, string> = {
      planner: `${defaultPrompt} Provide a concise plan, explicit deliverables, and dependency list with risks.`,
      researcher: `${defaultPrompt} Gather and summarize references, assumptions, and tradeoffs for implementation.`,
      designer: `${defaultPrompt} Create implementation sketch and acceptance criteria.`,
      developer: `${defaultPrompt} Implement changes in the repository and return modified file list.`,
      executor: `${defaultPrompt} Run commands/tests and report pass/fail with artifacts or commands executed.`,
      verifier: `${defaultPrompt} Validate the output of previous steps and provide pass/fail decision with remediation notes.`,
    };

    return roleGuidance[role];
  }

  return `echo "[${role}] No default command for provider '${provider}'. Set ${providerKey} or ${genericKey}."; exit 1`;
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
export JOB_RESULT_PATH=${shellQuote(pane.resultPath)}
export JOB_COMPLETION_MARKER=${shellQuote(pane.completionMarker)}
export JOB_TASK=$(cat <<'${taskMarker}'
${context.task}
${taskMarker}
)

echo "[${context.role}] started $(date -Iseconds)"
status=0
set +e
${renderedCommand}
status=$?
set -e
echo "${'$'}JOB_COMPLETION_MARKER role=${'$'}JOB_ROLE status=${'$'}status"
cat > "${'$'}JOB_RESULT_PATH" <<JSON
{"role":"${'$'}JOB_ROLE","exitCode":${'$'}status,"finishedAt":"$(date -Iseconds)"}
JSON
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

  if (paneRows.length < TMUX_ROLES.length) {
    throw new Error(`failed to allocate 3 panes, got ${paneRows.length}`);
  }

  return TMUX_ROLES.map((role, idx) => {
    const paneId = paneRows[idx].paneId;
    runTmux(['select-pane', '-t', paneId, '-T', role], true);

    return {
      role,
      paneId,
      logPath: '',
      scriptPath: '',
      resultPath: '',
      completionMarker: `__TMUX_TASK_COMPLETION__${role}__${Date.now()}_${Math.random().toString(16).slice(2)}__`,
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
      },
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
    pane.resultPath = path.join(runDir, `${pane.role}.result.json`);

    await fs.writeFile(pane.logPath, '');
    await fs.writeFile(pane.resultPath, '{}', { encoding: 'utf8' });

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

    const latest = await jobStore.findJobById(job.id);

    if (latest?.status === 'canceled') {
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

      const paneResults = await Promise.all(
        panes.map(async (pane) => {
          const state = paneStates.find((paneState) => paneState.paneId === pane.paneId);
          return readPaneCompletion(pane, state);
        }),
      );

      const failedPane = paneResults.find((pane) => !pane.completionMarkerSeen || pane.exitStatus !== 0 || pane.exitStatus === null);
      if (failedPane) {
        if (!options.keepTmuxSession) {
          killTmuxSession(sessionName);
        }

        if (!failedPane.completionMarkerSeen) {
          throw new Error(
            `pane failed: ${failedPane.role} (no completion marker, source=${failedPane.completionMarkerSource})`,
          );
        }

        throw new Error(
          `pane failed: ${failedPane.role} (exit=${failedPane.exitStatus}, source=${failedPane.completionMarkerSource})`,
        );
      }

      const succeededPaneResults = paneResults.map((pane) => ({
        ...pane,
        exitStatus: pane.exitStatus ?? 0,
      }));

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
            panes: succeededPaneResults,
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

async function processJobById(jobId: string) {
  const current = await jobStore.findJobById(jobId);

  if (!current) {
    throw new Error(`job not found: ${jobId}`);
  }

  if (
    current.status === 'succeeded' ||
    current.status === 'failed' ||
    current.status === 'canceled'
  ) {
    return;
  }

  if (current.status === 'waiting_approval') {
    return;
  }

  await jobStore.updateJob(jobId, {
    status: 'running',
    startedAt: current.startedAt ?? new Date().toISOString(),
    finishedAt: undefined,
    error: null,
  });
  await addEvent(jobId, 'phase_changed', 'Worker started processing');

  if (current.approvalState === 'required') {
    await jobStore.updateJob(jobId, {
      status: 'waiting_approval',
    });
    await addEvent(jobId, 'approval_required', 'Approval is required before execution');
    return;
  }

  const runResult =
    current.mode === 'team'
      ? await runTeamOrchestration(current)
      : await runProviderOrchestration(current);

  if (runResult.state === 'canceled') {
    return;
  }

  if (runResult.state === 'waiting_approval') {
    await addEvent(jobId, 'waiting_approval', 'Team run paused for approval');
    return;
  }

  if (runResult.state === 'failed') {
    const reason = runResult.output && typeof runResult.output.reason === 'string' ? String(runResult.output.reason) : undefined;
    await jobStore.updateJob(jobId, {
      status: 'failed',
      error: reason ?? 'Team run failed',
      finishedAt: new Date().toISOString(),
    });
    await addEvent(jobId, 'failed', 'Team mode execution failed', runResult.output);
    return;
  }

  const latest = await jobStore.findJobById(jobId);
  if (latest?.status === 'canceled') {
    await addEvent(jobId, 'canceled', 'Job reached canceled state before completion update');
    return;
  }

  await jobStore.updateJob(jobId, {
    status: 'succeeded',
    output: runResult.output ?? null,
    finishedAt: new Date().toISOString(),
  });

  await addEvent(jobId, 'completed', 'Job completed successfully', runResult.output);
}

async function processJob(queueJob: Job<{ jobId: string }>) {
  const jobId = queueJob.data.jobId;
  await processJobById(jobId);
}

async function processFileQueuedJob(jobId: string, directories: { pending: string; processing: string; root: string }) {
  try {
    await processJobById(jobId);
  } finally {
    await clearClaim(jobId, directories);
  }
}

async function runBullWorker() {
  if (!redisConnection) {
    throw new Error('BullMQ worker requested but redis connection is not configured');
  }

  const worker = new Worker(
    JOB_QUEUE_NAME,
    async (job) => {
      try {
        await processJob(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const jobId = job.data.jobId;

        const latest = await jobStore.findJobById(jobId);
        if (latest?.status !== 'canceled') {
          await jobStore.updateJob(jobId, {
            status: 'failed',
            error: message,
            finishedAt: new Date().toISOString(),
          });
          await addEvent(jobId, 'failed', message);
        }

        throw error;
      }
    },
    {
      connection: redisConnection,
      concurrency,
    },
  );

  worker.on('ready', () => {
    console.log(`[worker] ready. queue=${JOB_QUEUE_NAME}, concurrency=${concurrency}`);
  });

  worker.on('failed', (job, error) => {
    console.error(`[worker] failed job=${job?.id}:`, error);
  });

  return worker;
}

async function runFileQueueWorker() {
  const stateRoot = resolveStateRoot();
  const directories = getQueueDirs(stateRoot);
  await ensureDir(directories.root);
  await ensureDir(directories.pending);
  await ensureDir(directories.processing);

  console.log('[worker] queue mode: file');
  await reapStaleClaims(directories);

  const running = new Set<string>();

  const start = () => {
    const loop = async () => {
      while (!shutdownRequested) {
        while (running.size < concurrency && !shutdownRequested) {
          const jobId = await claimQueuedJob(directories);
          if (!jobId) {
            break;
          }

          if (running.has(jobId)) {
            await clearClaim(jobId, directories);
            continue;
          }

          running.add(jobId);
          processFileQueuedJob(jobId, directories)
            .catch(async (error) => {
              const message = error instanceof Error ? error.message : String(error);
              const latest = await jobStore.findJobById(jobId);
              if (latest?.status !== 'canceled') {
                await jobStore.updateJob(jobId, {
                  status: 'failed',
                  error: message,
                  finishedAt: new Date().toISOString(),
                });
                await addEvent(jobId, 'failed', message);
              }
            })
            .finally(() => {
              running.delete(jobId);
            });
        }

        if (!shutdownRequested) {
          await sleep(400);
        }
      }
    };

    return loop().catch((error) => {
      console.error('[worker] file queue loop failed', error);
      process.exit(1);
    });
  };

  return start();
}

async function main() {
  await Promise.resolve();
  let workerInstance: Worker | undefined;

  if (fileQueueEnabled) {
    runFileQueueWorker().catch((error) => {
      console.error('[worker] file queue runner failed', error);
      process.exit(1);
    });
  } else {
    workerInstance = await runBullWorker();
  }

  const shutdown = async () => {
    shutdownRequested = true;
    if (fileQueueEnabled) {
      console.log('[worker] shutting down...');
      process.exit(0);
      return;
    }

    console.log('[worker] shutting down...');
    await workerInstance?.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error) => {
  console.error('[worker] fatal error', error);
  process.exit(1);
});
