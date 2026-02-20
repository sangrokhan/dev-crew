import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  approvalStates,
  jobStatuses,
  type ApprovalState,
  type JobMode,
  type JobRecord,
  type JobStatus,
  type Provider,
} from '../job.types';

import { CreateJobDto } from '../dto/create-job.dto';

export interface JobEventRecord {
  id: string;
  jobId: string;
  type: string;
  message: string;
  payload?: unknown;
  createdAt: string;
}

interface StoredEventEnvelope extends JobEventRecord {
  v: 1;
}

type JobRecordStore = Omit<JobRecord, 'id'> & {
  id: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJobDir(stateRoot: string, jobId: string): string {
  return path.join(stateRoot, jobId);
}

function getRecordPath(jobDir: string): string {
  return path.join(jobDir, 'record.json');
}

function getEventsPath(jobDir: string): string {
  return path.join(jobDir, 'events.jsonl');
}

function getLockPath(jobDir: string): string {
  return path.join(jobDir, '.lock');
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeApprovalState(value: string): ApprovalState {
  return approvalStates.includes(value as ApprovalState) ? (value as ApprovalState) : 'none';
}

function normalizeJobStatus(value: string | undefined): JobStatus {
  return jobStatuses.includes((value as JobStatus) ?? 'queued') ? ((value ?? 'queued') as JobStatus) : 'queued';
}

function normalizeJobRecord(value: unknown, jobId?: string): JobRecord | null {
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
  const status = normalizeJobStatus(typeof record.status === 'string' ? record.status : undefined);
  const approvalState = normalizeApprovalState(typeof record.approvalState === 'string' ? record.approvalState : 'none');

  const options = record.options == null ? null : asRecord(record.options);

  return {
    id,
    provider: provider as Provider,
    mode: mode as JobMode,
    repo,
    ref,
    task,
    options,
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

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  while (true) {
    try {
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: nowIso() }),
        { flag: 'wx' },
      );
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

async function pruneStaleLock(lockPath: string) {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as { startedAt?: string };
    if (!parsed?.startedAt) {
      return;
    }
    const startedAt = new Date(parsed.startedAt).getTime();
    if (Number.isNaN(startedAt)) return;
    if (Date.now() - startedAt > 30_000) {
      await fs.rm(lockPath, { force: true });
    }
  } catch {
    return;
  }
}

export class JobFileStore {
  private readonly stateRoot = defaultStateRoot();

  constructor() {}

  async createJob(dto: CreateJobDto, approvalState: ApprovalState): Promise<JobRecord> {
    const id = randomUUID();
    const now = nowIso();
    const options = asRecord(dto.options);
    const record: JobRecordStore = {
      id,
      provider: dto.provider,
      mode: dto.mode,
      repo: hasText(dto.repo) ? dto.repo : 'unknown',
      ref: hasText(dto.ref) ? dto.ref : 'main',
      task: dto.task,
      options,
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
    await this.writeRecord(record);
    return record;
  }

  async findJobById(jobId: string): Promise<JobRecord | null> {
    const raw = await this.readRecord(jobId);
    return normalizeJobRecord(raw, jobId);
  }

  async updateJob(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    const jobDir = getJobDir(this.stateRoot, jobId);
    const lockPath = getLockPath(jobDir);
    return withLock(lockPath, async () => {
      const currentRaw = await this.readRecord(jobId);
      const current = normalizeJobRecord(currentRaw, jobId);
      if (!current) {
        throw new Error(`job not found: ${jobId}`);
      }

      const merged = this.normalizePatch({
        ...current,
        ...patch,
      });
      await this.writeRecord(merged);
      return merged;
    });
  }

  async addEvent(jobId: string, type: string, message: string, payload?: unknown): Promise<void> {
    const event: StoredEventEnvelope = {
      v: 1,
      id: randomUUID(),
      jobId,
      type,
      message,
      payload,
      createdAt: nowIso(),
    };
    const jobDir = getJobDir(this.stateRoot, jobId);
    const eventsPath = getEventsPath(jobDir);
    await ensureParentDir(eventsPath);
    await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async listRecentEvents(jobId: string, take = 100): Promise<JobEventRecord[]> {
    const jobDir = getJobDir(this.stateRoot, jobId);
    const eventsPath = getEventsPath(jobDir);
    try {
      const raw = await fs.readFile(eventsPath, 'utf8');
      const parsed = raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const envelope = JSON.parse(line) as StoredEventEnvelope;
          return {
            id: envelope.id,
            jobId: envelope.jobId,
            type: envelope.type,
            message: envelope.message,
            payload: envelope.payload,
            createdAt: envelope.createdAt,
          } as JobEventRecord;
        });

      const start = Math.max(parsed.length - take, 0);
      return parsed.slice(start);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      throw error;
    }
  }

  private async readRecord(jobId: string): Promise<unknown> {
    const pathToRecord = getRecordPath(getJobDir(this.stateRoot, jobId));
    try {
      const raw = await fs.readFile(pathToRecord, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return null;
      throw error;
    }
  }

  private normalizePatch(value: JobRecord | (Partial<JobRecord> & { id: string })): JobRecord {
    const result = value as JobRecord;
    return {
      ...result,
      id: result.id,
      provider: (result.provider as Provider) ?? 'codex',
      mode: (result.mode as JobMode) ?? 'team',
      repo: hasText(result.repo) ? result.repo : 'unknown',
      ref: hasText(result.ref) ? result.ref : 'main',
      task: result.task ?? '',
      options: result.options === undefined ? null : result.options,
      status: normalizeJobStatus(result.status),
      approvalState: normalizeApprovalState(result.approvalState ?? 'none'),
      output: result.output ?? null,
      error: result.error ?? null,
      createdAt: result.createdAt || nowIso(),
      updatedAt: nowIso(),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
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
