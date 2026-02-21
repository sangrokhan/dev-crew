export const providers = ['codex', 'claude', 'gemini'] as const;
export const modes = ['autopilot', 'team', 'ralph', 'ultrawork', 'pipeline'] as const;
export const jobStatuses = ['queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'canceled'] as const;
export const approvalStates = ['none', 'required', 'approved', 'rejected'] as const;
export const statuses = ['queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'canceled'] as const;
export const actions = ['approve', 'reject', 'cancel', 'resume'] as const;
export const teamTaskActions = ['approve', 'reject'] as const;
export const teamRoles = ['planner', 'researcher', 'designer', 'developer', 'executor', 'verifier'] as const;
export const teamStatuses = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'canceled'] as const;

export type Provider = (typeof providers)[number];
export type JobMode = (typeof modes)[number];
export type JobStatus = (typeof jobStatuses)[number];
export type ApprovalState = (typeof approvalStates)[number];
export type TeamRole = (typeof teamRoles)[number];
export type TeamStatus = (typeof teamStatuses)[number];
export type JobAction = (typeof actions)[number];
export type TeamTaskAction = (typeof teamTaskActions)[number];

export interface JobRecord {
  id: string;
  provider: Provider;
  mode: JobMode;
  repo: string;
  ref: string;
  task: string;
  options: Record<string, unknown> | null;
  status: JobStatus;
  approvalState: ApprovalState;
  output: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}
