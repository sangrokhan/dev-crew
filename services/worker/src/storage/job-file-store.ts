import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { approvalStates, jobStatuses, type JobRecord } from './job-types';

interface StoredEventEnvelope {
  v: 1;
  id: string;
  jobId: string;
  type: string;
  message: string;
  payload?: unknown;
  createdAt: string;
}

export interface JobEventRecord {
  id: string;
  jobId: string;
  type: string;
  message: string;
  payload?: unknown;
  createdAt: string;
}

type CreateJobInput = {
  provider: JobRecord['provider'];
  mode: JobRecord['mode'];
  repo: string;
  ref: string;
  task: string;
  options?: Record<string, unknown> | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function findRepositoryRoot(startDir = process.cwd()): string {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const hasApi = existsSync(path.join(current, 'services', 'api', 'package.json'));
    const hasWorker = existsSync(path.join(current, 'services', 'worker', 'package.json'));
    if (hasApi || hasWorker) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return process.cwd();
}

function defaultStateRoot(): string {
  const explicit = process.env.OMX_STATE_ROOT;
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.resolve(findRepositoryRoot(), '.omx', 'state', 'jobs');
}

function getJobDir(stateRoot: string, jobId: string) {
  return path.join(stateRoot, jobId);
}

function getRecordPath(jobDir: string) {
  return path.join(jobDir, 'record.json');
}

function getEventsPath(jobDir: string) {
  return path.join(jobDir, 'events.jsonl');
}

function getLockPath(jobDir: string) {
  return path.join(jobDir, '.lock');
}

function normalizeApprovalState(value: string): JobRecord['approvalState'] {
  return approvalStates.includes(value as JobRecord['approvalState']) ? (value as JobRecord['approvalState']) : 'none';
}

function normalizeStatus(value: string): JobRecord['status'] {
  return jobStatuses.includes(value as JobRecord['status']) ? (value as JobRecord['status']) : 'queued';
}

function asJobRecord(value: unknown, jobId?: string): JobRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id.trim() ? record.id : jobId;
  if (!id) {
    return null;
  }

  const provider = typeof record.provider === 'string' ? record.provider : 'codex';
  const mode = typeof record.mode === 'string' ? record.mode : 'team';
  const repo = typeof record.repo === 'string' ? record.repo : '';
  const ref = typeof record.ref === 'string' ? record.ref : 'main';
  const task = typeof record.task === 'string' ? record.task : '';
  const status = normalizeStatus(typeof record.status === 'string' ? record.status : 'queued');
  const approvalState = normalizeApprovalState(typeof record.approvalState === 'string' ? record.approvalState : 'none');

  return {
    id,
    provider: provider as JobRecord['provider'],
    mode: mode as JobRecord['mode'],
    repo,
    ref,
    task,
    options: asRecord(record.options),
    status,
    approvalState,
    output: record.output ?? null,
    error: typeof record.error === 'string' ? record.error : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : nowIso(),
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : undefined,
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : undefined,
  };
}

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pruneStaleLock(lockPath: string) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as { startedAt?: string };
    const startedAt = parsed.startedAt ? Date.parse(parsed.startedAt) : Number.NaN;
    if (!Number.isNaN(startedAt) && Date.now() - startedAt > 30_000) {
      await fs.rm(lockPath, { force: true });
    }
  } catch {
    return;
  }
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  while (true) {
    try {
      await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: nowIso() }), { flag: 'wx' });
      try {
        return await fn();
      } finally {
        await fs.rm(lockPath, { force: true });
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() - start > 5000) {
        throw new Error(`failed to acquire job lock: ${lockPath}`);
      }
      await sleep(25);
      await pruneStaleLock(lockPath);
    }
  }
}

export class JobFileStore {
  private readonly stateRoot = defaultStateRoot();

  constructor() {}

  async createJob(dto: CreateJobInput, approvalState: JobRecord['approvalState']): Promise<JobRecord> {
    const id = randomUUID();
    const now = nowIso();
    const normalizedOptions = asRecord(dto.options);

    const record: JobRecord = {
      id,
      provider: dto.provider,
      mode: dto.mode,
      repo: dto.repo,
      ref: dto.ref,
      task: dto.task,
      options: normalizedOptions,
      status: 'queued',
      approvalState,
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: undefined,
      finishedAt: undefined,
    };

    await ensureParentDir(getRecordPath(getJobDir(this.stateRoot, id)));
    const temp = `${getRecordPath(getJobDir(this.stateRoot, id))}.tmp-${Date.now()}`;
    await fs.writeFile(temp, JSON.stringify(record, null, 2), 'utf8');
    await fs.rename(temp, getRecordPath(getJobDir(this.stateRoot, id)));
    return record;
  }

  async findJobById(jobId: string): Promise<JobRecord | null> {
    const raw = await this.readRecord(jobId);
    return asJobRecord(raw, jobId);
  }

  async updateJob(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    const jobDir = getJobDir(this.stateRoot, jobId);
    const lockPath = getLockPath(jobDir);

    return withLock(lockPath, async () => {
      const currentRaw = await this.readRecord(jobId);
      const current = asJobRecord(currentRaw, jobId);
      if (!current) {
        throw new Error(`job not found: ${jobId}`);
      }

      const normalized = this.normalizePatch({
        ...current,
        ...patch,
      });
      await this.writeRecord(normalized);
      return normalized;
    });
  }

  async addEvent(jobId: string, type: string, message: string, payload?: unknown): Promise<void> {
    const jobDir = getJobDir(this.stateRoot, jobId);
    const eventPath = getEventsPath(jobDir);
    await ensureParentDir(eventPath);
    const event: StoredEventEnvelope = {
      v: 1,
      id: randomUUID(),
      jobId,
      type,
      message,
      payload,
      createdAt: nowIso(),
    };
    await fs.appendFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async listRecentEvents(jobId: string, take = 100): Promise<JobEventRecord[]> {
    const jobDir = getJobDir(this.stateRoot, jobId);
    const eventPath = getEventsPath(jobDir);
    try {
      const raw = await fs.readFile(eventPath, 'utf8');
      const parsed = raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parsedLine = JSON.parse(line) as StoredEventEnvelope;
          return {
            id: parsedLine.id,
            jobId: parsedLine.jobId,
            type: parsedLine.type,
            message: parsedLine.message,
            payload: parsedLine.payload,
            createdAt: parsedLine.createdAt,
          } as JobEventRecord;
        });
      const start = Math.max(parsed.length - take, 0);
      return parsed.slice(start);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async readRecord(jobId: string): Promise<unknown> {
    const recordPath = getRecordPath(getJobDir(this.stateRoot, jobId));
    try {
      const raw = await fs.readFile(recordPath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private normalizePatch(value: JobRecord): JobRecord {
    return {
      ...value,
      provider: value.provider ?? 'codex',
      mode: value.mode ?? 'team',
      repo: value.repo || '',
      ref: value.ref || 'main',
      task: value.task || '',
      options: value.options ?? {},
      status: normalizeStatus(value.status ?? 'queued'),
      approvalState: normalizeApprovalState(value.approvalState ?? 'none'),
      output: value.output ?? null,
      error: value.error ?? null,
      createdAt: value.createdAt || nowIso(),
      updatedAt: nowIso(),
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
    };
  }

  private async writeRecord(record: JobRecord): Promise<void> {
    const jobDir = getJobDir(this.stateRoot, record.id);
    const recordPath = getRecordPath(jobDir);
    await ensureParentDir(recordPath);
    const normalized = this.normalizePatch(record);
    const temp = `${recordPath}.tmp-${Date.now()}`;
    await fs.writeFile(temp, JSON.stringify(normalized, null, 2), 'utf8');
    await fs.rename(temp, recordPath);
  }
}
