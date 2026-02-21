export type TeamRole = 'planner' | 'researcher' | 'designer' | 'developer' | 'executor' | 'verifier';
export type TeamMailboxKind = 'question' | 'instruction' | 'notice' | 'reassign';

export interface TeamTaskState {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'canceled';
  dependencies?: string[];
  role?: TeamRole;
  attempt?: number;
  workerId?: string;
  claimToken?: string;
  claimExpiresAt?: string;
  lastHeartbeatAt?: string;
}

export interface TeamMailboxMessage {
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

export interface TeamRunState {
  tasks: TeamTaskState[];
  mailbox?: TeamMailboxMessage[];
}

export interface MailboxReassignOptions {
  now?: () => string;
  isTaskReady?: (task: TeamTaskState, tasks: TeamTaskState[]) => boolean;
  onReassign?: (params: { taskId: string; role: TeamRole; message: string }) => void | Promise<void>;
  onQuestion?: (params: { taskId?: string; message: string }) => void | Promise<void>;
  onInstruction?: (params: { taskId?: string; message: string }) => void | Promise<void>;
  onNotice?: (params: { taskId?: string; message: string }) => void | Promise<void>;
}

function toISOStringNow(): string {
  return new Date().toISOString();
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function isTaskReady(task: TeamTaskState, tasks: TeamTaskState[]): boolean {
  if (task.status === 'succeeded') {
    return true;
  }

  if (!task.dependencies || task.dependencies.length === 0) {
    return task.status !== 'failed' && task.status !== 'canceled';
  }

  const byId = new Map(tasks.map((item) => [item.id, item]));
  return task.dependencies.every((dependencyId) => byId.get(dependencyId)?.status === 'succeeded');
}

export function normalizeMailboxMessages(value: unknown): TeamMailboxMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const mapped = value.map((raw, index): TeamMailboxMessage | null => {
    const item = asObject(raw);
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const message = typeof item.message === 'string' ? item.message.trim() : '';
    const delivered =
      typeof item.delivered === 'boolean'
        ? item.delivered
        : typeof item.deliveredAt === 'string' && item.deliveredAt.trim().length > 0;

    if (!['question', 'instruction', 'notice', 'reassign'].includes(kind)) {
      return null;
    }

    const createdAt = typeof item.createdAt === 'string' && item.createdAt.trim() ? item.createdAt : toISOStringNow();
    const deliveredAt = typeof item.deliveredAt === 'string' && item.deliveredAt.trim() ? item.deliveredAt : null;
    const taskId = typeof item.taskId === 'string' && item.taskId.trim() ? item.taskId.trim() : undefined;
    const rawTo = item.to;
    const validTo: TeamMailboxMessage['to'] =
      rawTo === 'leader'
        || rawTo === 'planner'
        || rawTo === 'researcher'
        || rawTo === 'designer'
        || rawTo === 'developer'
        || rawTo === 'executor'
        || rawTo === 'verifier'
        ? rawTo
        : Array.isArray(rawTo) &&
            rawTo.every(
              (entry) =>
                entry === 'planner' || entry === 'researcher' || entry === 'designer' || entry === 'developer' || entry === 'executor' || entry === 'verifier',
            )
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

  return mapped.filter((item): item is TeamMailboxMessage => item !== null).sort((a, b) => {
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

export async function applyMailboxReassign(
  jobId: string,
  state: TeamRunState,
  options: MailboxReassignOptions = {},
): Promise<{ state: TeamRunState; changed: boolean; hasUndeliveredMessages: boolean }> {
  const queue = normalizeMailboxMessages(state.mailbox);
  const now = options.now ?? toISOStringNow;
  const isTaskReadyFn = options.isTaskReady ?? isTaskReady;
  let changed = false;
  let hasUndeliveredMessages = false;
  let nextTasks = state.tasks;

  const nextMailbox = queue.map((message) => {
    if (message.delivered) {
      return message;
    }

    hasUndeliveredMessages = true;

    if (message.kind !== 'reassign' || !message.taskId) {
      if (message.kind === 'question' && options.onQuestion) {
        void options.onQuestion({
          taskId: message.taskId,
          message: message.message,
        });
      }

      if (message.kind === 'instruction' && options.onInstruction) {
        void options.onInstruction({
          taskId: message.taskId,
          message: message.message,
        });
      }

      if (message.kind === 'notice' && options.onNotice) {
        void options.onNotice({
          taskId: message.taskId,
          message: message.message,
        });
      }

      return {
        ...message,
        delivered: true,
        deliveredAt: now(),
      };
    }

    let reassigned = false;
    nextTasks = nextTasks.map((task) => {
      if (task.id !== message.taskId || reassigned) {
        return task;
      }

      const updatedStatus = task.dependencies?.length && !isTaskReadyFn(task, state.tasks) ? ('blocked' as const) : ('queued' as const);
      changed = true;
      reassigned = true;

      if (options.onReassign) {
        void options.onReassign({
          taskId: task.id,
          role: (task.role ?? 'planner') as TeamRole,
          message: message.message,
        });
      }

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
      deliveredAt: now(),
    };
  });

  if (!hasUndeliveredMessages) {
    return {
      state,
      changed: false,
      hasUndeliveredMessages: false,
    };
  }

  return {
    state: {
      ...state,
      mailbox: nextMailbox,
      tasks: nextTasks,
    },
    changed,
    hasUndeliveredMessages: true,
  };
};
