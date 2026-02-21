export type TeamTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'canceled';

export interface TeamTaskTemplate {
  id: string;
  name: string;
  role: 'planner' | 'researcher' | 'designer' | 'developer' | 'executor' | 'verifier';
  dependencies?: string[];
  maxAttempts?: number;
  timeoutSeconds?: number;
}

export interface TeamTaskState extends TeamTaskTemplate {
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

export interface TeamRunState {
  tasks: TeamTaskState[];
  phase?: string;
  currentTaskId?: string | null;
}

export interface ClaimLeaseConfig {
  claimTtlMs: number;
  claimLeaseSlackMs: number;
  heartbeatMs: number;
  nonReportingGraceMs: number;
  workerId: string;
  nowMs?: number;
}

function isClaimedByOtherWorker(task: TeamTaskState, config: Pick<ClaimLeaseConfig, 'workerId'>): boolean {
  return Boolean(task.claimToken && task.workerId && task.workerId !== config.workerId);
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function nowMs(now?: number): number {
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
}

function toISOStringNow(): string {
  return new Date().toISOString();
}

function randomTaskToken(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function heartbeatLeaseExpiresAt(claimTtlMs: number, claimLeaseSlackMs: number, now: number = Date.now()): string {
  const leaseMs = Math.max(15_000, claimTtlMs + claimLeaseSlackMs);
  return new Date(now + leaseMs).toISOString();
}

export function isTaskNonReporting(task: TeamTaskState, nowMsValue: number, config: Pick<ClaimLeaseConfig, 'heartbeatMs' | 'nonReportingGraceMs'>): boolean {
  if (task.status !== 'running') {
    return false;
  }

  const heartbeatMs = parseIsoMs(task.lastHeartbeatAt);
  if (heartbeatMs === null) {
    return true;
  }

  const graceMs = Math.max(config.nonReportingGraceMs, config.heartbeatMs * 3);
  return nowMsValue - heartbeatMs > graceMs;
}

export function isClaimExpired(
  task: TeamTaskState,
  nowMsValue: number,
  config: Omit<ClaimLeaseConfig, 'workerId' | 'nowMs'>,
): boolean {
  if (task.status !== 'running') {
    return false;
  }

  const expiresAtMs = parseIsoMs(task.claimExpiresAt);
  const heartbeatMs = parseIsoMs(task.lastHeartbeatAt);
  const heartbeatGraceMs = Math.max(config.nonReportingGraceMs, config.heartbeatMs * 3);

  if (expiresAtMs === null || heartbeatMs === null) {
    return true;
  }

  return expiresAtMs <= nowMsValue || nowMsValue - heartbeatMs > heartbeatGraceMs;
}

export function lockTaskForExecution(task: TeamTaskState, config: Omit<ClaimLeaseConfig, 'heartbeatMs' | 'nonReportingGraceMs' | 'nowMs'>): Partial<TeamTaskState> {
  if (isClaimedByOtherWorker(task, config)) {
    return {};
  }

  return {
    status: 'running',
    attempt: task.attempt + 1,
    startedAt: toISOStringNow(),
    workerId: config.workerId,
    claimToken: randomTaskToken(`task-${task.id}`),
    claimExpiresAt: heartbeatLeaseExpiresAt(config.claimTtlMs, config.claimLeaseSlackMs),
    lastHeartbeatAt: toISOStringNow(),
    error: undefined,
    output: undefined,
  };
}

export function isTaskReady(task: TeamTaskState, tasks: TeamTaskState[]): boolean {
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

export function normalizeRunningClaims(
  state: TeamRunState,
  config: ClaimLeaseConfig,
): TeamRunState {
  const nowMsValue = nowMs(config.nowMs);
  let hadReclaim = false;
  const normalized = state.tasks.map((task) => {
    if (!isClaimExpired(task, nowMsValue, config)) {
      return task;
    }

    hadReclaim = true;

    const reason = isTaskNonReporting(task, nowMsValue, {
      heartbeatMs: config.heartbeatMs,
      nonReportingGraceMs: config.nonReportingGraceMs,
    })
      ? 'non-reporting worker detected'
      : 'claim lease expired';

    const reclaimed: TeamTaskState = {
      ...task,
      workerId: undefined,
      claimToken: undefined,
      claimExpiresAt: undefined,
      lastHeartbeatAt: undefined,
      error: task.error
        ? `${task.error}\nTask reclaim reason: ${reason}; task reclaimed for rescheduling`
        : `Task reclaim reason: ${reason}; task reclaimed for rescheduling`,
      status: task.dependencies?.length ? ('blocked' as TeamTaskStatus) : ('queued' as TeamTaskStatus),
    };

    return reclaimed;
  });

  const unlocked = normalized.map((task) => {
    if (task.status !== 'blocked') {
      return task;
    }

    return {
      ...task,
      status: isTaskReady(task, normalized) ? ('queued' as TeamTaskStatus) : 'blocked',
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

export function refreshRunningClaims(state: TeamRunState, config: Pick<ClaimLeaseConfig, 'claimTtlMs' | 'claimLeaseSlackMs' | 'workerId' | 'heartbeatMs' | 'nowMs'>): TeamRunState {
  const nowMsValue = nowMs(config.nowMs);
  const heartbeatAt = new Date(nowMsValue).toISOString();
  const heartbeatIntervalMs = Math.max(1_000, config.heartbeatMs);

  const refreshed = state.tasks.map((task) => {
    if (task.status !== 'running') {
      return task;
    }

    if (isClaimedByOtherWorker(task, config)) {
      return task;
    }

    const isClaimFresh = parseIsoMs(task.claimExpiresAt) !== null && parseIsoMs(task.claimExpiresAt)! > nowMsValue;
    const lastHeartbeatAt = parseIsoMs(task.lastHeartbeatAt);
    const heartbeatDue = lastHeartbeatAt === null || nowMsValue - lastHeartbeatAt >= heartbeatIntervalMs;

    if (isClaimFresh && !heartbeatDue) {
      return task;
    }

    return {
      ...task,
      workerId: config.workerId,
      claimToken: task.claimToken ?? randomTaskToken(`task-${task.id}`),
      lastHeartbeatAt: heartbeatAt,
      claimExpiresAt: heartbeatLeaseExpiresAt(config.claimTtlMs, config.claimLeaseSlackMs, nowMsValue),
    };
  });

  return { ...state, tasks: refreshed };
}

export function selectRunnableTasks(state: TeamRunState, roleOrder: readonly string[]): TeamTaskState[] {
  return state.tasks
    .filter((task) => task.status === 'queued' || task.status === 'blocked')
    .filter((task) => isTaskReady(task, state.tasks))
    .sort((a, b) => {
      const ai = roleOrder.indexOf(a.role);
      const bi = roleOrder.indexOf(b.role);
      return ai - bi;
    });
}

export function applyTaskPatch(state: TeamRunState, taskId: string, patch: Partial<TeamTaskState>): TeamRunState {
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

  const unlocked = nextTasks.map((task) => {
    if (task.status !== 'blocked') {
      return task;
    }

    return {
      ...task,
      status: isTaskReady(task, nextTasks) ? ('queued' as TeamTaskStatus) : 'blocked',
    };
  });

  return {
    ...state,
    tasks: unlocked,
    currentTaskId: taskId,
  };
}

export function startTaskBatch(
  state: TeamRunState,
  tasks: TeamTaskState[],
  claimConfig: Omit<ClaimLeaseConfig, 'heartbeatMs' | 'nonReportingGraceMs' | 'nowMs'>,
): TeamRunState {
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

    return applyTaskPatch(nextState, task.id, lockTaskForExecution(current, claimConfig));
  }, state);
}
