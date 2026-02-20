export const providers = ['codex', 'claude'] as const;
export const modes = ['autopilot', 'team', 'ralph', 'ultrawork', 'pipeline'] as const;
export const statuses = ['queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'canceled'] as const;
export const actions = ['approve', 'reject', 'cancel'] as const;

export type Provider = (typeof providers)[number];
export type JobMode = (typeof modes)[number];
export type JobAction = (typeof actions)[number];
