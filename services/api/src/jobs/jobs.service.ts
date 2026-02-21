import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';
import { CreateJobDto } from './dto/create-job.dto';
import { JobAction, JobRecord, JobStatus, TeamRole } from './job.types';
import { JobFileStore } from './storage/job-store';

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

const TERMINAL_STATUSES: JobStatus[] = ['succeeded', 'failed', 'canceled'];

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
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

  async getTeamState(jobId: string): Promise<Record<string, unknown>> {
    const job = await this.getJob(jobId);
    if (job.mode !== 'team') {
      throw new BadRequestException('not a team job');
    }

    const options = asRecord(job.options);
    const team = asRecord(options.team);
    const rawState = asRecord(team.state);
    if (!rawState.status || !Array.isArray(rawState.tasks)) {
      const defaultState = defaultTeamState(team) as unknown as Record<string, unknown> & { tasks?: TeamTaskState[] };
      return {
        ...defaultState,
        metrics: buildTeamTaskMetrics(defaultState.tasks as TeamTaskState[]),
      } as Record<string, unknown>;
    }

    const tasks = Array.isArray(rawState.tasks) ? (rawState.tasks as TeamTaskState[]) : [];
    return {
      ...(rawState as Record<string, unknown>),
      metrics: buildTeamTaskMetrics(tasks),
    };
  }

  async listRecentEvents(jobId: string, take = 100) {
    await this.getJob(jobId);
    return this.store.listRecentEvents(jobId, take);
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
    return {
      ...defaultTeamState(options.team as Record<string, unknown>),
      ...state,
      tasks: Array.isArray(state.tasks) ? (state.tasks as TeamTaskState[]) : [],
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
}
