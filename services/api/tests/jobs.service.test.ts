import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { QueueService } from '../src/queue/queue.service';
import { extractTokenUsage, JobsService } from '../src/jobs/jobs.service';

type QueuedJob = {
  jobId: string;
};

class FakeQueueService extends QueueService {
  public calls: QueuedJob[] = [];

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async enqueueJob(jobId: string): Promise<void> {
    this.calls.push({ jobId });
  }
}

function createTempStateRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'omx-api-state-'));
}

async function createService(stateRoot: string) {
  const queue = new FakeQueueService();
  const previousStateRoot = process.env.OMX_STATE_ROOT;
  process.env.OMX_STATE_ROOT = stateRoot;

  const service = new JobsService(queue as unknown as QueueService);
  return {
    service,
    queue,
    restore: () => {
      process.env.OMX_STATE_ROOT = previousStateRoot;
    },
  };
}

describe('JobsService', () => {
  let stateRoot: string;
  let cleanup = false;

  beforeEach(() => {
    stateRoot = createTempStateRoot();
    cleanup = true;
    process.env.REDIS_URL = '';
  });

  afterEach(() => {
    if (cleanup) {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  test('creates team job with default team state', async () => {
    const created = await (async () => {
      const holder = await createService(stateRoot);
      const job = await holder.service.createJob({
        provider: 'codex',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'build feature',
      } as never);
      return { job, holder };
    })();

    const { job, holder } = created;
    assert.equal(job.status, 'queued');
    assert.equal(job.approvalState, 'none');
    assert.equal(holder.queue.calls.length, 1);
    assert.equal(holder.queue.calls[0].jobId, job.id);

    const teamState = (await holder.service.getTeamState(job.id)) as {
      status: string;
      tasks: Array<{ id: string; status: string }>;
      metrics: { queued: number; blocked: number };
    };
    assert.equal(teamState.status, 'queued');
    assert.equal(teamState.tasks.length, 6);
    assert.equal(teamState.metrics.queued, 1);
    assert.equal(teamState.metrics.blocked, 5);
    holder.restore();
  });

  test('creates approval-required job when requested', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'gemini',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'approval test',
      options: {
        requireApproval: true,
      },
    } as never);
    assert.equal(job.approvalState, 'required');
    holder.restore();
  });

  test('returns not found for missing job', async () => {
    const holder = await createService(stateRoot);
    await assert.rejects(() => holder.service.getJob('missing'), /Job not found/);
    holder.restore();
  });

  test('rejects team-state request for non-team job', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'gemini',
      mode: 'autopilot',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'single mode',
    } as never);
    await assert.rejects(() => holder.service.getTeamState(job.id), /not a team job/);
    holder.restore();
  });

  test('getTeamMailbox returns mailbox list for team job', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'team mailbox read',
    } as never);

    await holder.service.sendTeamMailboxMessage(job.id, {
      kind: 'reassign',
      message: 'rerun planner',
      taskId: 'team-planner',
      to: 'planner',
    } as never);

    const mailbox = (await holder.service.getTeamMailbox(job.id)) as Array<{ kind: string; taskId: string; to: string }>;
    assert.equal(mailbox.length, 1);
    assert.equal(mailbox[0].kind, 'reassign');
    assert.equal(mailbox[0].taskId, 'team-planner');
    assert.equal(mailbox[0].to, 'planner');
    holder.restore();
  });

  test('sendTeamMailboxMessage rejects invalid mailbox payload', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'team mailbox validate',
    } as never);

    await assert.rejects(
      () =>
        holder.service.sendTeamMailboxMessage(job.id, {
          kind: 'notice',
        } as never),
      /Invalid mailbox message payload/,
    );
    holder.restore();
  });

  test('sendTeamMailboxMessage rejects unknown mailbox kind', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'team mailbox invalid kind',
    } as never);

    await assert.rejects(
      () =>
        holder.service.sendTeamMailboxMessage(job.id, {
          kind: 'invalid-kind',
          message: 'bad message',
        } as never),
      /Invalid mailbox message payload/,
    );
    holder.restore();
  });

  test('sendTeamMailboxMessage defaults optional fields and stores normalized message', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'team mailbox defaults',
    } as never);

    const sent = (await holder.service.sendTeamMailboxMessage(job.id, {
      kind: 'question',
      message: 'status check',
    } as never)) as {
      id: string;
      delivered: boolean;
      deliveredAt: string | null;
    };

    assert.equal(sent.delivered, false);
    assert.equal(sent.deliveredAt, null);
    assert.equal(sent.id.startsWith('question-'), true);

    const mailbox = (await holder.service.getTeamMailbox(job.id)) as Array<{ id: string; delivered: boolean; deliveredAt: string | null }>;
    assert.equal(mailbox.length, 1);
    assert.equal(mailbox[0].id, sent.id);
    assert.equal(mailbox[0].delivered, false);
    assert.equal(mailbox[0].deliveredAt, null);
    holder.restore();
  });

  test('getTeamMailbox normalizes and sorts mailbox messages by createdAt', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'team mailbox sort normalize',
    } as never);

    const store = (holder.service as never as {
      store: {
        updateJob: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
      };
    }).store;

    await store.updateJob(job.id, {
      options: {
        team: {
          state: {
            mailbox: [
              { kind: 'notice', message: 'later', createdAt: '2026-02-20T00:05:00.000Z' },
              { kind: 'question', message: 'first', createdAt: '2026-02-20T00:01:00.000Z', taskId: 'team-planner', to: 'planner' },
              { kind: 'invalid-kind', message: 'ignore-this', createdAt: '2026-02-20T00:02:00.000Z' },
              { kind: 'reassign', message: 'last', createdAt: '2026-02-20T00:10:00.000Z', taskId: 'team-planner', to: 'team-planner' },
            ],
          },
        },
      } as never,
    });

    const mailbox = (await holder.service.getTeamMailbox(job.id)) as Array<{ message: string; createdAt: string }>;
    assert.equal(mailbox.length, 3);
    assert.equal(mailbox[0].message, 'first');
    assert.equal(mailbox[1].message, 'later');
    assert.equal(mailbox[2].message, 'last');
    assert.equal(mailbox[1].createdAt, '2026-02-20T00:05:00.000Z');
    holder.restore();
  });

  test('getTeamMailbox is forbidden for non-team jobs', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'gemini',
      mode: 'autopilot',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'autopilot mailbox',
    } as never);

    await assert.rejects(() => holder.service.getTeamMailbox(job.id), /not a team job/);
    holder.restore();
  });

  test('cancel action updates terminal state and prevents duplicate cancel', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'autopilot',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'cancel me',
    } as never);
    const canceled = await holder.service.applyAction(job.id, 'cancel');
    assert.equal(canceled.status, 'canceled');

    await assert.rejects(() => holder.service.applyAction(job.id, 'cancel'), /already in a terminal state/);
    holder.restore();
  });

  test('resumes terminal job and requeues it', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'resume flow',
    } as never);

    await (holder.service as never as { store: { updateJob: (id: string, patch: Record<string, unknown>) => Promise<unknown> } })
      .store.updateJob(job.id, { status: 'failed', finishedAt: new Date().toISOString() });

    const resumed = await holder.service.applyAction(job.id, 'resume');
    assert.equal(resumed.status, 'queued');
    assert.equal(resumed.approvalState, 'none');
    assert.equal(holder.queue.calls.some((entry) => entry.jobId === job.id), true);
    const restoredState = (await holder.service.getTeamState(job.id)) as {
      status: string;
    };
    assert.equal(restoredState.status, 'queued');
    holder.restore();
  });

  test('approve action requires waiting approval state', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'gemini',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'approval queue',
      options: { requireApproval: true },
    } as never);

    await (holder.service as never as { store: { updateJob: (id: string, patch: Record<string, unknown>) => Promise<unknown> } })
      .store.updateJob(job.id, { status: 'waiting_approval', approvalState: 'required' });

    const approved = await holder.service.applyAction(job.id, 'approve');
    assert.equal(approved.status, 'queued');
    assert.equal(approved.approvalState, 'approved');
    holder.restore();
  });

  test('reject action marks job failed and stores rejection', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'gemini',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'reject path',
      options: { requireApproval: true },
    } as never);

    await (holder.service as never as { store: { updateJob: (id: string, patch: Record<string, unknown>) => Promise<unknown> } })
      .store.updateJob(job.id, { status: 'waiting_approval', approvalState: 'required' });

    const rejected = await holder.service.applyAction(job.id, 'reject');
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.approvalState, 'rejected');
    assert.equal(rejected.error, 'Rejected by approver');

    const state = (await holder.service.getTeamState(job.id)) as {
      status: string;
      metrics?: never;
      tasks?: Array<{ id: string; status: string }>;
    };
    assert.equal(state.status, 'waiting_approval');
    holder.restore();
  });

  test('updates team task state and reflects phase transition rules', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'dependency unlock',
    } as never);

    const afterPlanner = (await holder.service.updateTeamTaskState(job.id, (state) => {
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === 'team-planner'
            ? { ...task, status: 'succeeded', finishedAt: new Date().toISOString(), attempt: task.attempt + 1 }
            : task,
        ),
      };
    })) as {
      phase: string;
      tasks: Array<{ id: string; status: string }>;
      metrics?: { queued?: number };
    };

    const research = afterPlanner.tasks.find((task) => task.id === 'team-research');
    assert.equal(research?.status, 'blocked');
    assert.equal(afterPlanner.tasks.length, 6);
    assert.equal(afterPlanner.phase, 'researcher');
  });

  test('does not force team defaults for non-team mode', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'gemini',
      mode: 'autopilot',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'no team defaults',
    } as never);

    const found = await holder.service.getJob(job.id);
    const options = found.options as never as { team?: Record<string, unknown> };
    assert.equal(Boolean(options.team), false);
    holder.restore();
  });

  test('falls back to default team state when team tasks are manually corrupted', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'corrupt team state',
    } as never);

    const store = (holder.service as never as {
      store: {
        updateJob: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
      };
    }).store;

    await store.updateJob(job.id, {
      options: {
        team: {
          state: {
            status: 'running',
            tasks: [],
          },
        },
      },
    });

    const stateWithCorruptTasks = (await holder.service.getTeamState(job.id)) as {
      status: string;
      tasks: Array<unknown>;
      metrics: Record<string, number>;
    };
    assert.equal(stateWithCorruptTasks.status, 'running');
    assert.equal(stateWithCorruptTasks.tasks.length, 0);

    await store.updateJob(job.id, { options: { team: {} } as never });
    const state = (await holder.service.getTeamState(job.id)) as {
      status: string;
      tasks: Array<{ id: string; status: string }>;
      metrics: { total: number };
    };
    assert.equal(state.status, 'queued');
    assert.equal(state.tasks.length, 6);
    holder.restore();
  });

  test('updateTeamTaskState keeps non-team job at default status', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'pipeline',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'autonomy mode',
    } as never);

    const state = await holder.service.updateTeamTaskState(job.id, (existing) => ({
      ...existing,
      phase: 'noop',
      tasks: [...existing.tasks],
    }));
    assert.equal(state.status, 'queued');
    assert.equal(state.tasks.length, 6);
    holder.restore();
  });

  test('resume action is rejected when job is not eligible', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'gemini',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'resume conflict',
    } as never);

    await assert.rejects(() => holder.service.applyAction(job.id, 'resume'), /Only terminal or approval-pending jobs can be resumed/);
    holder.restore();
  });

  test('listRecentEvents returns empty array when event log is absent', async () => {
    const holder = await createService(stateRoot);
    const job = await holder.service.createJob({
      provider: 'codex',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'no event log',
    } as never);

    const events = await holder.service.listRecentEvents(job.id, 3);
    assert.equal(events.length >= 1, true);
    assert.equal(events[0].message, 'Job queued');
    holder.restore();
  });

  test('extractTokenUsage supports structured formats and total fallback', () => {
    const usageA = extractTokenUsage({ usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } });
    assert.equal(usageA?.inputTokens, 10);
    assert.equal(usageA?.outputTokens, 4);
    assert.equal(usageA?.totalTokens, 14);

    const usageB = extractTokenUsage({ token_usage: { input: 7, output: 3 } });
    assert.equal(usageB?.inputTokens, 7);
    assert.equal(usageB?.outputTokens, 3);
    assert.equal(usageB?.totalTokens, 10);

    const usageC = extractTokenUsage({ message: 'no usage' });
    assert.equal(usageC, null);
  });

  test('getMonitorOverview aggregates active jobs, active agents, and tokens', async () => {
    const holder = await createService(stateRoot);
    const teamJob = await holder.service.createJob({
      provider: 'codex',
      mode: 'team',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'team monitor',
    } as never);
    const providerJob = await holder.service.createJob({
      provider: 'gemini',
      mode: 'autopilot',
      repo: 'git@github.com:example/repo.git',
      ref: 'main',
      task: 'provider monitor',
    } as never);

    const now = new Date().toISOString();
    const store = (holder.service as never as {
      store: {
        updateJob: (jobId: string, patch: Record<string, unknown>) => Promise<unknown>;
      };
    }).store;

    await store.updateJob(teamJob.id, {
      status: 'running',
      options: {
        team: {
          state: {
            status: 'running',
            phase: 'developer',
            currentTaskId: 'task-dev-1',
            tasks: [
              {
                id: 'task-dev-1',
                name: 'Implement monitor',
                role: 'developer',
                status: 'running',
                attempt: 1,
                workerId: 'worker-dev-1',
                startedAt: now,
                lastHeartbeatAt: now,
                claimExpiresAt: now,
                output: {
                  parsed: {
                    usage: {
                      input_tokens: 11,
                      output_tokens: 5,
                      total_tokens: 16,
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
    await store.updateJob(providerJob.id, {
      status: 'queued',
      output: {
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
        },
      },
    });

    const overview = await holder.service.getMonitorOverview(20);
    assert.equal(overview.jobs.active >= 2, true);
    assert.equal(overview.activeJobs.some((job) => job.id === teamJob.id), true);
    assert.equal(overview.activeAgents.some((agent) => agent.jobId === teamJob.id), true);
    assert.equal(overview.tokens.totalTokens >= 21, true);
    assert.equal(overview.tokens.jobsWithUsage >= 2, true);
    holder.restore();
  });
});
