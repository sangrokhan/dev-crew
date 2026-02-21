export type PlannerValidationError = {
  path: string;
  message: string;
};

export type TeamRole = 'planner' | 'researcher' | 'designer' | 'developer' | 'executor' | 'verifier';

export type PlannerTaskTemplate = {
  id: string;
  name: string;
  role: TeamRole;
  dependencies: string[];
  maxAttempts: number;
  timeoutSeconds: number;
};

export type PlannerOutput = {
  planSummary: string;
  tasks: PlannerTaskTemplate[];
};

type PlannerOutputValidation = PlannerOutput;

export type PlannerParseResult =
  | { ok: true; value: PlannerOutput }
  | { ok: false; errors: PlannerValidationError[] };

export type PlannerParseFailure = {
  ok: false;
  errors: PlannerValidationError[];
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as UnknownRecord;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function isTeamRole(value: unknown): value is TeamRole {
  return (
    value === 'planner' ||
    value === 'researcher' ||
    value === 'designer' ||
    value === 'developer' ||
    value === 'executor' ||
    value === 'verifier'
  );
}

function collectStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value.trim()].filter(Boolean);
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function addError(errors: PlannerValidationError[], path: string, message: string) {
  errors.push({ path, message });
}

export function validatePlannerOutput(value: unknown): PlannerValidationError[] {
  const errors: PlannerValidationError[] = [];
  const root = asRecord(value);
  const planSummary = firstString([root.planSummary, root.plan_summary]);

  if (!planSummary) {
    addError(errors, 'plan_summary', 'plan_summary must be a non-empty string');
  }

  const rawTasks = Array.isArray(root.tasks) ? root.tasks : [];
  if (rawTasks.length === 0) {
    addError(errors, 'tasks', 'tasks must be a non-empty array');
    return errors;
  }

  const tasks: PlannerOutputValidation['tasks'] = [];
  const usedIds = new Set<string>();

  for (let index = 0; index < rawTasks.length; index += 1) {
    const rawTask = asRecord(rawTasks[index]);
    const role = isTeamRole(rawTask.role) ? rawTask.role : null;
    if (!role) {
      addError(errors, `tasks[${index}].role`, `invalid role: ${String(rawTask.role)}`);
    }

    const subject = asString(rawTask.subject);
    const description = asString(rawTask.description);
    const name = firstString([subject, description, rawTask.name]);
    if (!name) {
      addError(errors, `tasks[${index}].subject`, 'subject or description must be provided');
    }

    const dependencySource = rawTask.depends_on ?? rawTask.dependsOn ?? rawTask.dependencies;
    const dependencies = collectStringList(dependencySource);
    const maxAttemptsRaw = Number(rawTask.maxAttempts);
    const timeoutRaw = Number(rawTask.timeoutSeconds);

    const maxAttempts = Number.isInteger(maxAttemptsRaw) && maxAttemptsRaw > 0 ? maxAttemptsRaw : 1;
    const timeoutSeconds = Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 1200;

    const idRaw = asString(rawTask.id);
    const id = idRaw || `${role ?? 'task'}-${index + 1}`;

    if (usedIds.has(id)) {
      addError(errors, `tasks[${index}].id`, `duplicate task id: ${id}`);
    } else {
      usedIds.add(id);
    }

    tasks.push({
      id,
      name,
      role: role ?? 'executor',
      dependencies,
      maxAttempts,
      timeoutSeconds,
    });
  }

  const taskById = new Map<string, PlannerOutputValidation['tasks'][number]>();
  for (const task of tasks) {
    taskById.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependencies) {
      if (!taskById.has(dependencyId)) {
        addError(errors, `tasks.${task.id}.dependencies`, `unknown dependency: ${dependencyId}`);
      }
    }
  }

  const state = new Map<string, 'unvisited' | 'visiting' | 'visited'>();

  const hasCycle = (taskId: string): boolean => {
    const current = state.get(taskId);
    if (current === 'visiting') {
      return true;
    }
    if (current === 'visited') {
      return false;
    }

    state.set(taskId, 'visiting');
    const task = taskById.get(taskId);
    for (const dependencyId of task?.dependencies ?? []) {
      if (hasCycle(dependencyId)) {
        return true;
      }
    }

    state.set(taskId, 'visited');
    return false;
  };

  for (const taskId of taskById.keys()) {
    if (hasCycle(taskId)) {
      addError(errors, 'tasks', `dependency cycle detected for task: ${taskId}`);
      break;
    }
  }

  if (tasks.length === 0) {
    addError(errors, 'tasks', 'no valid task was parsed from planner output');
  }

  return errors;
}

export function parsePlannerOutput(value: unknown): PlannerParseResult {
  const root = asRecord(value);
  const errors = validatePlannerOutput(root);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const rawTasks = root.tasks as Array<UnknownRecord>;
  const normalizedTasks = rawTasks.map((rawTask, index): PlannerTaskTemplate => {
    const dependencies = collectStringList(rawTask.depends_on ?? rawTask.dependsOn ?? rawTask.dependencies);
    const id = asString(rawTask.id) || `task-${index + 1}`;
    const name = firstString([asString(rawTask.subject), asString(rawTask.description), asString(rawTask.name)]);
    const role = isTeamRole(rawTask.role) ? (rawTask.role as TeamRole) : 'executor';
    const maxAttemptsRaw = Number(rawTask.maxAttempts);
    const timeoutRaw = Number(rawTask.timeoutSeconds);
    const maxAttempts = Number.isInteger(maxAttemptsRaw) && maxAttemptsRaw > 0 ? maxAttemptsRaw : 1;
    const timeoutSeconds = Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 1200;

    return {
      id,
      name,
      role,
      dependencies,
      maxAttempts,
      timeoutSeconds,
    };
  });

  return {
    ok: true,
    value: {
      planSummary: firstString([asString(root.planSummary), asString(root.plan_summary)]),
      tasks: normalizedTasks,
    },
  };
}
