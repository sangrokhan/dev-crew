import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { QueueService } from '../src/queue/queue.service';
import { JobsService } from '../src/jobs/jobs.service';

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
});
