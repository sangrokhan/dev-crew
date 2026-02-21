export type TeamTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'canceled';
export type TeamRunStatus = 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'canceled';

export interface TeamTaskTemplate {
  id: string;
  name: string;
  role: 'planner' | 'researcher' | 'designer' | 'developer' | 'executor' | 'verifier';
  dependencies?: string[];
}

export interface TeamTaskState extends TeamTaskTemplate {
  status: TeamTaskStatus;
  attempt: number;
}

export interface TeamRunState {
  status: TeamRunStatus;
  phase: string;
  fixAttempts: number;
  maxFixAttempts: number;
  parallelTasks: number;
  currentTaskId?: string | null;
  tasks: TeamTaskState[];
}

const TEAM_TERMINAL_TASK_STATUS: TeamTaskStatus[] = ['succeeded', 'failed', 'canceled'];

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

export function allTasksFinished(state: TeamRunState): boolean {
  return state.tasks.every((task) => TEAM_TERMINAL_TASK_STATUS.includes(task.status));
}

export function collectFailureCascade(state: TeamRunState): Set<string> {
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

export function buildFailureRecoveryState(state: TeamRunState): TeamRunState | null {
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
  }) as Array<TeamTaskState & Record<string, unknown>>;

  const readyTasks = resetTasks.map((task) => {
    if (!retryIds.has(task.id) || task.status === 'succeeded') {
      return task;
    }

    return {
      ...task,
      status: isTaskReady(task as TeamTaskState, resetTasks as TeamTaskState[]) ? ('queued' as TeamTaskStatus) : ('blocked' as TeamTaskStatus),
    };
  }) as TeamTaskState[];

  return {
    ...state,
    status: 'running',
    fixAttempts: state.fixAttempts + 1,
    currentTaskId: null,
    tasks: readyTasks,
  };
}

export function toTeamTaskPhase(tasks: TeamTaskState[]): string {
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
