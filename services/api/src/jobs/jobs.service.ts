import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';
import { CreateJobDto } from './dto/create-job.dto';
import { JobAction, JobRecord, JobStatus, TeamRole } from './job.types';
import { JobFileStore, ListJobsOptions } from './storage/job-store';

type TeamTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'canceled';
type TeamRunStatus = 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'canceled';
type TeamTaskOutput = Record<string, unknown> | null;

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
  error?: string | null;
  output?: TeamTaskOutput;
}

interface TeamRunState {
  status: TeamRunStatus;
  phase: string;
  currentTaskId?: string | null;
  fixAttempts: number;
  maxFixAttempts: number;
  parallelTasks: number;
  tasks: TeamTaskState[];
  mailbox?: TeamMailboxMessage[];
}

type TeamMailboxKind = 'question' | 'instruction' | 'notice' | 'reassign';

interface TeamMailboxMessage {
  id: string;
  kind: TeamMailboxKind;
  to?: TeamRole | TeamRole[] | 'leader';
  taskId?: string;
  message: string;
  payload?: TeamTaskOutput;
  createdAt: string;
  deliveredAt?: string | null;
  delivered: boolean;
  meta?: Record<string, unknown>;
}

interface TeamTaskMetrics {
  total: number;
  queued: number;
  running: number;
  blocked: number;
  succeeded: number;
  failed: number;
  canceled: number;
  terminal: number;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface MonitorActiveAgent {
  jobId: string;
  taskId: string;
  role: TeamRole;
  workerId: string | null;
  status: TeamTaskStatus;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  claimExpiresAt: string | null;
}

export interface MonitorActiveJob {
  id: string;
  provider: JobRecord['provider'];
  mode: JobRecord['mode'];
  status: JobRecord['status'];
  task: string;
  repo: string;
  ref: string;
  startedAt?: string;
  updatedAt: string;
  teamPhase?: string;
  teamMetrics?: TeamTaskMetrics;
}

export interface MonitorOverview {
  generatedAt: string;
  jobs: Record<JobStatus | 'active' | 'total', number>;
  activeJobs: MonitorActiveJob[];
  activeAgents: MonitorActiveAgent[];
  tokens: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    jobsWithUsage: number;
    jobsWithoutUsage: number;
  };
}

const TERMINAL_STATUSES: JobStatus[] = ['succeeded', 'failed', 'canceled'];

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toTokenNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function pickTokenValue(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const found = toTokenNumber(record[key]);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

export function extractTokenUsage(value: unknown): TokenUsage | null {
  const root = asRecord(value);
  const candidates = [root, asRecord(root.usage), asRecord(root.token_usage)];

  for (const candidate of candidates) {
    const inputTokens = pickTokenValue(candidate, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'input']);
    const outputTokens = pickTokenValue(candidate, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'output']);
    let totalTokens = pickTokenValue(candidate, ['total_tokens', 'totalTokens', 'total']);

    if (inputTokens === null && outputTokens === null && totalTokens === null) {
      continue;
    }

    if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
      totalTokens = inputTokens + outputTokens;
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }

  return null;
}

function normalizeDependencies(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item) => typeof item === 'string' && item.trim().length > 0);
}

function normalizeTeamTaskTemplateSource(teamOptions: Record<string, unknown>): Array<Record<string, unknown>> {
  const preferred = teamOptions.teamTasks;
  if (Array.isArray(preferred)) {
    return preferred.filter(
      (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
    ) as Array<Record<string, unknown>>;
  }

  const legacy = teamOptions.taskTemplates;
  if (Array.isArray(legacy)) {
    return legacy.filter(
      (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
    ) as Array<Record<string, unknown>>;
  }

  return [];
}

function normalizeTeamRole(role: unknown): TeamRole | null {
  if (
    role === 'planner' ||
    role === 'researcher' ||
    role === 'designer' ||
    role === 'developer' ||
    role === 'executor' ||
    role === 'verifier'
  ) {
    return role;
  }
  return null;
}

function randomMailboxMessageId(): string {
  return `mailbox-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeTeamMailboxMessage(raw: unknown, defaultIdx: number): TeamMailboxMessage | null {
  const item = asRecord(raw);
  const kindCandidate = item.kind;
  const message = typeof item.message === 'string' && item.message.trim() ? item.message.trim() : '';
  if (!message) {
    return null;
  }

  const kind = typeof kindCandidate === 'string' ? kindCandidate : '';
  if (!['question', 'instruction', 'notice', 'reassign'].includes(kind)) {
    return null;
  }

  const toCandidate = item.to;
  const to =
    toCandidate === 'leader'
      ? 'leader'
      : normalizeTeamRole(toCandidate)
        ? (normalizeTeamRole(toCandidate) as TeamRole)
        : Array.isArray(toCandidate) &&
            toCandidate.every((entry) => normalizeTeamRole(entry) === entry)
          ? (toCandidate as TeamRole[])
          : undefined;

  const taskId = typeof item.taskId === 'string' && item.taskId.trim() ? item.taskId.trim() : undefined;
  return {
    id:
      typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `${kind}-${Date.now().toString(36)}-${defaultIdx}`,
    kind: kind as TeamMailboxKind,
    to,
    taskId,
    message,
    payload: asRecord(item.payload),
    createdAt: typeof item.createdAt === 'string' && item.createdAt.trim() ? item.createdAt : new Date().toISOString(),
    deliveredAt: typeof item.deliveredAt === 'string' && item.deliveredAt.trim() ? item.deliveredAt : null,
    delivered: typeof item.delivered === 'boolean' ? item.delivered : false,
    meta: asRecord(item.meta),
  };
}

function normalizeTeamMailbox(raw: unknown): TeamMailboxMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item, idx) => normalizeTeamMailboxMessage(item, idx))
    .filter((message): message is TeamMailboxMessage => message !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

function normalizeTaskTemplates(templates?: Array<Record<string, unknown>>): TeamTaskState[] {
  const normalized = (templates ?? [])
    .map((raw, index) => {
      const source = asRecord(raw);
      const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `Task ${index + 1}`;
      const role = normalizeTeamRole(source.role);
      if (!role) {
        return null;
      }

      const id = typeof source.id === 'string' && source.id.trim().length > 0 ? source.id : `${role}-${index + 1}`;
      const maxAttempts = typeof source.maxAttempts === 'number' && source.maxAttempts > 0 ? Math.floor(source.maxAttempts) : 1;
      const timeoutSeconds =
        typeof source.timeoutSeconds === 'number' && source.timeoutSeconds > 0 ? Math.floor(source.timeoutSeconds) : 900;
      const dependencies = normalizeDependencies(source.dependencies);

      return {
        id,
        name,
        role,
        dependencies,
        maxAttempts,
        timeoutSeconds,
        status: dependencies.length === 0 ? ('queued' as TeamTaskStatus) : ('blocked' as TeamTaskStatus),
        attempt: 0,
      } as TeamTaskState;
    })
    .filter((item): item is TeamTaskState => item !== null);

  if (normalized.length > 0) {
    return normalized;
  }

  return [
    {
      id: 'team-planner',
      name: 'Create execution plan',
      role: 'planner',
      dependencies: [],
      maxAttempts: 1,
      timeoutSeconds: 1200,
      status: 'queued',
      attempt: 0,
    },
    {
      id: 'team-research',
      name: 'Gather context and references',
      role: 'researcher',
      dependencies: ['team-planner'],
      maxAttempts: 1,
      timeoutSeconds: 1200,
      status: 'blocked',
      attempt: 0,
    },
    {
      id: 'team-designer',
      name: 'Propose solution design',
      role: 'designer',
      dependencies: ['team-planner'],
      maxAttempts: 1,
      timeoutSeconds: 1200,
      status: 'blocked',
      attempt: 0,
    },
    {
      id: 'team-developer',
      name: 'Implement requested changes',
      role: 'developer',
      dependencies: ['team-designer', 'team-research'],
      maxAttempts: 2,
      timeoutSeconds: 3600,
      status: 'blocked',
      attempt: 0,
    },
    {
      id: 'team-executor',
      name: 'Run implementation tasks',
      role: 'executor',
      dependencies: ['team-developer'],
      maxAttempts: 1,
      timeoutSeconds: 1200,
      status: 'blocked',
      attempt: 0,
    },
    {
      id: 'team-verifier',
      name: 'Verify results',
      role: 'verifier',
      dependencies: ['team-executor'],
      maxAttempts: 1,
      timeoutSeconds: 1200,
      status: 'blocked',
      attempt: 0,
    },
  ];
}

function buildTeamTaskMetrics(tasks: TeamTaskState[]): TeamTaskMetrics {
  const total = tasks.length;
  const queued = tasks.filter((task) => task.status === 'queued').length;
  const running = tasks.filter((task) => task.status === 'running').length;
  const blocked = tasks.filter((task) => task.status === 'blocked').length;
  const succeeded = tasks.filter((task) => task.status === 'succeeded').length;
  const failed = tasks.filter((task) => task.status === 'failed').length;
  const canceled = tasks.filter((task) => task.status === 'canceled').length;

  return {
    total,
    queued,
    running,
    blocked,
    succeeded,
    failed,
    canceled,
    terminal: succeeded + failed + canceled,
  };
}

function defaultTeamState(rawState?: Record<string, unknown>): TeamRunState {
  const state = asRecord(rawState);
  const maxFixAttempts = typeof state.maxFixAttempts === 'number' && state.maxFixAttempts >= 0 ? Math.floor(state.maxFixAttempts) : 2;
  const parallelTasks =
    typeof state.parallelTasks === 'number' && state.parallelTasks >= 1 ? Math.max(1, Math.floor(state.parallelTasks)) : 1;
  const taskTemplates = normalizeTeamTaskTemplateSource(state);
  const taskSeed = normalizeTaskTemplates(taskTemplates);

  const phase = typeof state.phase === 'string' && state.phase.trim() ? state.phase : 'planning';

  return {
    status: 'queued',
    phase,
    fixAttempts: 0,
    maxFixAttempts,
    parallelTasks,
    currentTaskId: null,
    mailbox: [],
    tasks: taskSeed,
  };
}

function toTeamTaskPhase(tasks: TeamTaskState[]): string {
  const firstQueued = tasks.find((task) => task.status === 'queued');
  if (firstQueued) {
    return firstQueued.role;
  }

  const running = tasks.find((task) => task.status === 'running');
  if (running) {
    return running.role;
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

function isTaskDependenciesSatisfied(task: TeamTaskState, tasks: TeamTaskState[]): boolean {
  if (!task.dependencies || task.dependencies.length === 0) {
    return true;
  }

  const byId = new Map(tasks.map((item) => [item.id, item]));
  return task.dependencies.every((id) => {
    const dependency = byId.get(id);
    return dependency?.status === 'succeeded';
  });
}

@Injectable()
export class JobsService {
  private readonly store = new JobFileStore();

  constructor(private readonly queue: QueueService) {}

  async createJob(dto: CreateJobDto) {
    const approvalState: JobRecord['approvalState'] = dto.options?.requireApproval ? 'required' : 'none';
    const options: Record<string, unknown> = asRecord(dto.options);

    if (dto.mode === 'team' && !asRecord(options.team).state) {
      options.team = {
        ...asRecord(options.team),
        state: defaultTeamState(asRecord(options.team)),
      };
    }

    const created = await this.store.createJob({ ...dto, options }, approvalState);
    await this.addEvent(created.id, 'queued', 'Job queued');
    await this.queue.enqueueJob(created.id);
    return created;
  }

  async getJob(jobId: string): Promise<JobRecord> {
    const job = await this.store.findJobById(jobId);
    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }
    return job;
  }

  async listJobs(options: ListJobsOptions = {}): Promise<JobRecord[]> {
    return this.store.listJobs(options);
  }

  async getTeamState(jobId: string): Promise<Record<string, unknown>> {
    const job = await this.getJob(jobId);
    if (job.mode !== 'team') {
      throw new BadRequestException('not a team job');
    }

    const state = this.extractJobTeamState(job);
    const normalizedMailbox = normalizeTeamMailbox(state.mailbox);
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    return {
      ...state,
      mailbox: normalizedMailbox,
      metrics: buildTeamTaskMetrics(tasks),
    } as Record<string, unknown>;
  }

  async getTeamMailbox(jobId: string): Promise<TeamMailboxMessage[]> {
    const job = await this.getJob(jobId);
    if (job.mode !== 'team') {
      throw new BadRequestException('not a team job');
    }

    const state = this.extractJobTeamState(job);
    return normalizeTeamMailbox(state.mailbox);
  }

  async sendTeamMailboxMessage(jobId: string, message: Record<string, unknown>): Promise<TeamMailboxMessage> {
    const job = await this.getJob(jobId);
    if (job.mode !== 'team') {
      throw new BadRequestException('not a team job');
    }

    const currentState = this.extractJobTeamState(job);
    const normalized = normalizeTeamMailboxMessage(message, currentState.mailbox?.length ?? 0);
    if (!normalized) {
      throw new BadRequestException('Invalid mailbox message payload');
    }

    const nextState: TeamRunState = {
      ...currentState,
      mailbox: [
        ...normalizeTeamMailbox(currentState.mailbox),
        {
          ...normalized,
          id: normalized.id || randomMailboxMessageId(),
          delivered: false,
          deliveredAt: null,
        },
      ],
    };

    await this.persistTeamState(jobId, nextState);
    await this.addEvent(jobId, 'team.mailbox.received', `Mailbox message received for task ${normalized.taskId ?? 'none'}`, {
      taskId: normalized.taskId,
      kind: normalized.kind,
      to: normalized.to,
      message: normalized.message,
    });
    return normalized;
  }

  async listRecentEvents(jobId: string, take = 100) {
    await this.getJob(jobId);
    return this.store.listRecentEvents(jobId, take);
  }

  async getMonitorOverview(limit = 200): Promise<MonitorOverview> {
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit || 200)));
    const jobs = await this.listJobs({ limit: safeLimit });
    const activeStatuses: JobStatus[] = ['queued', 'running', 'waiting_approval'];

    const counters = {
      total: jobs.length,
      queued: jobs.filter((job) => job.status === 'queued').length,
      running: jobs.filter((job) => job.status === 'running').length,
      waiting_approval: jobs.filter((job) => job.status === 'waiting_approval').length,
      succeeded: jobs.filter((job) => job.status === 'succeeded').length,
      failed: jobs.filter((job) => job.status === 'failed').length,
      canceled: jobs.filter((job) => job.status === 'canceled').length,
      active: jobs.filter((job) => activeStatuses.includes(job.status)).length,
    };

    const activeJobs: MonitorActiveJob[] = [];
    const activeAgents: MonitorActiveAgent[] = [];

    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let jobsWithUsage = 0;
    let jobsWithoutUsage = 0;

    for (const job of jobs) {
      const usage = this.collectJobTokenUsage(job);
      if (usage) {
        jobsWithUsage += 1;
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        totalTokens += usage.totalTokens ?? 0;
      } else {
        jobsWithoutUsage += 1;
      }

      if (!activeStatuses.includes(job.status)) {
        continue;
      }

      if (job.mode === 'team') {
        const teamState = this.extractJobTeamState(job);
        const metrics = buildTeamTaskMetrics(teamState.tasks);
        activeJobs.push({
          id: job.id,
          provider: job.provider,
          mode: job.mode,
          status: job.status,
          task: job.task,
          repo: job.repo,
          ref: job.ref,
          startedAt: job.startedAt,
          updatedAt: job.updatedAt,
          teamPhase: teamState.phase,
          teamMetrics: metrics,
        });

        for (const task of teamState.tasks) {
          if (task.status !== 'running' && !task.workerId) {
            continue;
          }
          activeAgents.push({
            jobId: job.id,
            taskId: task.id,
            role: task.role,
            workerId: task.workerId ?? null,
            status: task.status,
            startedAt: task.startedAt ?? null,
            lastHeartbeatAt: task.lastHeartbeatAt ?? null,
            claimExpiresAt: task.claimExpiresAt ?? null,
          });
        }
      } else {
        activeJobs.push({
          id: job.id,
          provider: job.provider,
          mode: job.mode,
          status: job.status,
          task: job.task,
          repo: job.repo,
          ref: job.ref,
          startedAt: job.startedAt,
          updatedAt: job.updatedAt,
        });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      jobs: counters,
      activeJobs,
      activeAgents,
      tokens: {
        inputTokens,
        outputTokens,
        totalTokens,
        jobsWithUsage,
        jobsWithoutUsage,
      },
    };
  }

  async applyAction(jobId: string, action: JobAction): Promise<JobRecord> {
    const current = await this.getJob(jobId);

    if (action === 'cancel') {
      if (TERMINAL_STATUSES.includes(current.status)) {
        throw new ConflictException('Job is already in a terminal state');
      }

      const updated = await this.store.updateJob(jobId, {
        status: 'canceled',
        finishedAt: new Date().toISOString(),
      });
      await this.addEvent(jobId, 'canceled', 'Job canceled by user');
      return updated;
    }

    if (action === 'resume') {
      if (!TERMINAL_STATUSES.includes(current.status) && current.status !== 'waiting_approval') {
        throw new ConflictException('Only terminal or approval-pending jobs can be resumed');
      }

      const jobOptions = asRecord(current.options);
      const team = asRecord(jobOptions.team);
      const updatedState = current.mode === 'team' ? team.state : undefined;
      const nextState =
        current.mode === 'team' && updatedState && asRecord(updatedState).status
          ? ({ ...asRecord(updatedState), status: 'queued' } as Record<string, unknown>)
          : updatedState;

      const updated = await this.store.updateJob(jobId, {
        status: 'queued',
        approvalState: current.approvalState === 'required' ? 'approved' : current.approvalState,
        error: null,
        options:
          current.mode === 'team'
            ? ({ ...jobOptions, team: { ...team, state: nextState } }) as Record<string, unknown>
            : (jobOptions as Record<string, unknown>),
      });

      await this.addEvent(jobId, 'queued', 'Job resumed by user');
      await this.queue.enqueueJob(jobId);
      return updated;
    }

    if (current.status !== 'waiting_approval' || current.approvalState !== 'required') {
      throw new ConflictException('Job is not waiting for approval');
    }

    if (action === 'approve') {
      const updated = await this.store.updateJob(jobId, {
        approvalState: 'approved',
        status: 'queued',
        error: null,
      });
      await this.addEvent(jobId, 'approval', 'Approval granted, re-queued');
      await this.queue.enqueueJob(jobId);
      return updated;
    }

    const updated = await this.store.updateJob(jobId, {
      approvalState: 'rejected',
      status: 'failed',
      error: 'Rejected by approver',
      finishedAt: new Date().toISOString(),
    });
    await this.addEvent(jobId, 'approval', 'Approval rejected');
    await this.rewindTeamStateForApproval(jobId, current.mode === 'team' ? this.extractJobTeamState(current) : undefined);
    return updated;
  }

  async rewindTeamStateForApproval(jobId: string, currentState?: TeamRunState) {
    if (!currentState) {
      return;
    }

    const rewoundTasks = currentState.tasks.map((task) => {
      const blocked = task.status === 'blocked' ? 'blocked' : task.status;
      return {
        ...task,
        status: blocked,
      };
    });

    const updatedState = {
      ...currentState,
      status: 'waiting_approval' as TeamRunStatus,
      tasks: rewoundTasks,
      currentTaskId: null,
    } as TeamRunState;

    await this.persistTeamState(jobId, updatedState);
  }

  async persistTeamState(jobId: string, nextState: TeamRunState) {
    const job = await this.getJob(jobId);
    const options = asRecord(job.options);
    const team = asRecord(options.team);
    const merged = { ...options, team: { ...team, state: nextState } };
    await this.store.updateJob(jobId, { options: merged as Record<string, unknown> });
  }

  extractJobTeamState(job: { options: unknown }): TeamRunState {
    const options = asRecord(job.options);
    const team = asRecord(options.team);
    const state = asRecord(team.state);
    const base = defaultTeamState(team as Record<string, unknown>);
    return {
      ...base,
      ...state,
      mailbox: normalizeTeamMailbox(state.mailbox),
      tasks: Array.isArray(state.tasks) ? (state.tasks as TeamTaskState[]) : base.tasks,
    };
  }

  async updateTeamTaskState(
    jobId: string,
    updater: (state: TeamRunState) => TeamRunState,
  ): Promise<TeamRunState> {
    const job = await this.getJob(jobId);
    if (job.mode !== 'team') {
      return defaultTeamState(asRecord(asRecord(job.options).team));
    }

    const options = asRecord(job.options);
    const team = asRecord(options.team);
    const current = asRecord(team.state);
    const taskSeed = Array.isArray(current.tasks) ? (current.tasks as TeamTaskState[]) : [];
    const state: TeamRunState =
      taskSeed.length > 0
        ? ({ ...defaultTeamState(team), ...current, tasks: taskSeed } as TeamRunState)
        : defaultTeamState(team);
    state.mailbox = normalizeTeamMailbox(current.mailbox);
    const next = updater({
      ...state,
      phase: toTeamTaskPhase(state.tasks),
    });
    next.phase = toTeamTaskPhase(next.tasks);
    const normalized = {
      ...next,
      tasks: next.tasks.map((task) => {
        const depsSatisfied = task.status !== 'queued' ? false : isTaskDependenciesSatisfied(task, next.tasks);
        return {
          ...task,
          status: task.status === 'blocked' && depsSatisfied ? ('queued' as TeamTaskStatus) : task.status,
          output:
            task.output && typeof task.output === 'object' ? (task.output as TeamTaskOutput) : undefined,
          attempt: task.attempt,
        };
      }),
    };

    await this.persistTeamState(jobId, normalized);
    return normalized;
  }

  async addEvent(jobId: string, type: string, message: string, payload?: Record<string, unknown>) {
    await this.store.addEvent(jobId, type, message, payload);
  }

  private collectJobTokenUsage(job: JobRecord): TokenUsage | null {
    if (job.mode === 'team') {
      const state = this.extractJobTeamState(job);
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      let hasUsage = false;

      for (const task of state.tasks) {
        const output = asRecord(task.output);
        const parsed = output.parsed;
        const usage = extractTokenUsage(parsed);
        if (!usage) {
          continue;
        }
        hasUsage = true;
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        totalTokens += usage.totalTokens ?? 0;
      }

      if (!hasUsage) {
        return null;
      }

      return {
        inputTokens,
        outputTokens,
        totalTokens,
      };
    }

    const output = asRecord(job.output);
    const directUsage = extractTokenUsage(output);
    if (directUsage) {
      return directUsage;
    }

    const parsedUsage = extractTokenUsage(output.parsed);
    if (parsedUsage) {
      return parsedUsage;
    }

    return null;
  }
}
