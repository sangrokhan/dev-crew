import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyTaskPatch,
  heartbeatLeaseExpiresAt,
  isClaimExpired,
  isTaskNonReporting,
  lockTaskForExecution,
  normalizeRunningClaims,
  refreshRunningClaims,
  selectRunnableTasks,
  startTaskBatch,
  type ClaimLeaseConfig,
  type TeamRunState,
  type TeamTaskState,
} from '../src/team/task-runtime';

describe('task runtime claim and scheduler', () => {
  const baseTask: TeamTaskState = {
    id: 'team-planner',
    name: 'plan',
    role: 'planner',
    status: 'queued',
    attempt: 0,
  };

  const claimConfig: ClaimLeaseConfig = {
    claimTtlMs: 60_000,
    claimLeaseSlackMs: 15_000,
    heartbeatMs: 10_000,
    nonReportingGraceMs: 30_000,
    workerId: 'worker-test',
  };

  test('calculates lease expiry timestamp above now', () => {
    const now = Date.parse('2025-01-01T00:00:00Z');
    const expires = heartbeatLeaseExpiresAt(60_000, 15_000, now);
    assert.equal(new Date(expires).getTime() > now, true);
  });

  test('detects non-reporting and expired claims', () => {
    const oldTime = Date.parse('2025-01-01T00:00:00Z');
    const staleTask: TeamTaskState = {
      id: 'team-exec',
      name: 'exec',
      role: 'executor',
      status: 'running',
      attempt: 0,
      claimExpiresAt: new Date('2025-01-01T00:00:10Z').toISOString(),
      lastHeartbeatAt: new Date('2024-12-31T23:59:00Z').toISOString(),
    };

    const nonReporting = isTaskNonReporting(staleTask, oldTime + 60_000, claimConfig);
    const claimExpired = isClaimExpired(staleTask, oldTime + 60_000, claimConfig);
    assert.equal(nonReporting, true);
    assert.equal(claimExpired, true);
  });

  test('normalizes running claim when it is stale', () => {
    const state: TeamRunState = {
      tasks: [
        {
          ...baseTask,
          id: 'team-planner',
          status: 'running',
          attempt: 1,
          claimExpiresAt: new Date('2025-01-01T00:00:10Z').toISOString(),
          lastHeartbeatAt: new Date('2024-12-31T23:00:00Z').toISOString(),
        },
        {
          id: 'team-executor',
          name: 'execute',
          role: 'executor',
          status: 'blocked',
          dependencies: ['team-planner'],
          attempt: 0,
        },
      ],
    };

    const normalized = normalizeRunningClaims(state, { ...claimConfig, nowMs: Date.parse('2025-01-01T00:02:00Z') });
    const plannerTask = normalized.tasks.find((task) => task.id === 'team-planner');
    const execTask = normalized.tasks.find((task) => task.id === 'team-executor');
    assert.equal(plannerTask?.status, 'queued');
    assert.equal(execTask?.status, 'blocked');
    assert.equal(Boolean(plannerTask?.workerId), false);
  });

  test('refreshes running claim heartbeat and token', () => {
    const state: TeamRunState = {
      tasks: [
        {
          ...baseTask,
          id: 'team-planner',
          status: 'running',
          attempt: 0,
          claimExpiresAt: new Date('2025-01-01T00:00:30Z').toISOString(),
          lastHeartbeatAt: new Date('2025-01-01T00:00:00Z').toISOString(),
        },
      ],
    };

    const refreshed = refreshRunningClaims(state, { ...claimConfig, nowMs: Date.parse('2025-01-01T00:00:45Z') });
    const task = refreshed.tasks[0];
    assert.equal(task.lastHeartbeatAt !== state.tasks[0].lastHeartbeatAt, true);
    assert.equal(task.claimExpiresAt !== state.tasks[0].claimExpiresAt, true);
    assert.equal(task.workerId, claimConfig.workerId);
  });

  test('does not lock task if it is claimed by another worker', () => {
    const lockResult = lockTaskForExecution(
      {
        ...baseTask,
        status: 'queued',
        attempt: 0,
        workerId: 'other-worker',
        claimToken: 'token-other',
      },
      claimConfig,
    );

    assert.equal(Object.keys(lockResult).length, 0);
  });

  test('does not refresh running claim for another worker', () => {
    const state: TeamRunState = {
      tasks: [
        {
          ...baseTask,
          status: 'running',
          attempt: 1,
          workerId: 'other-worker',
          claimToken: 'token-other',
          claimExpiresAt: new Date('2025-01-01T00:00:40Z').toISOString(),
          lastHeartbeatAt: new Date('2025-01-01T00:00:00Z').toISOString(),
        },
      ],
    };

    const refreshed = refreshRunningClaims(state, {
      ...claimConfig,
      nowMs: Date.parse('2025-01-01T00:00:45Z'),
    });
    const task = refreshed.tasks[0];
    assert.equal(task.workerId, 'other-worker');
    assert.equal(task.claimToken, 'token-other');
    assert.equal(task.lastHeartbeatAt, state.tasks[0].lastHeartbeatAt);
    assert.equal(task.claimExpiresAt, state.tasks[0].claimExpiresAt);
  });

  test('picks runnable tasks and starts batch with lock', () => {
    const readyState: TeamRunState = {
      tasks: [
        {
          ...baseTask,
          status: 'queued',
          attempt: 0,
          dependencies: [],
        },
        {
          id: 'team-exec',
          name: 'execute',
          role: 'executor',
          status: 'queued',
          dependencies: ['team-planner'],
          attempt: 0,
        },
      ],
    };

    const runnable = selectRunnableTasks(readyState, ['planner', 'executor']);
    assert.equal(runnable.length, 1);
    assert.equal(runnable[0].id, 'team-planner');

    const afterStart = startTaskBatch(readyState, runnable, claimConfig);
    const planner = afterStart.tasks.find((task) => task.id === 'team-planner');
    assert.equal(planner?.status, 'running');
    assert.equal(planner?.workerId, claimConfig.workerId);
  });

  test('applyTaskPatch unlocks dependent task', () => {
    const patched = applyTaskPatch(
      {
        tasks: [
          {
            id: 'planner',
            name: 'plan',
            role: 'planner',
            status: 'running',
            attempt: 1,
          },
          {
            id: 'executor',
            name: 'exec',
            role: 'executor',
            status: 'blocked',
            dependencies: ['planner'],
            attempt: 0,
          },
        ],
      },
      'planner',
      {
        status: 'succeeded',
        attempt: 1,
      },
    );

    const executor = patched.tasks.find((task) => task.id === 'executor');
    assert.equal(executor?.status, 'queued');
  });
});
