import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  allTasksFinished,
  buildFailureRecoveryState,
  toTeamTaskPhase,
  collectFailureCascade,
  type TeamRunState,
} from '../src/team/task-state-machine';

describe('team state machine transitions', () => {
  const baseRun: TeamRunState = {
    status: 'running' as const,
    phase: 'planning',
    fixAttempts: 0,
    maxFixAttempts: 3,
    parallelTasks: 2,
    currentTaskId: null,
    tasks: [
      {
        id: 'planner',
        name: 'plan',
        role: 'planner',
        status: 'failed' as const,
        attempt: 1,
      },
      {
        id: 'developer',
        name: 'implement',
        role: 'developer',
        dependencies: ['planner'],
        status: 'blocked' as const,
        attempt: 0,
      },
    ],
  };

  test('toTeamTaskPhase prioritizes running/queued state', () => {
    const phase = toTeamTaskPhase([
      { id: 'a', name: 'a', role: 'planner', status: 'blocked', dependencies: [], attempt: 0 },
      { id: 'b', name: 'b', role: 'executor', status: 'queued', attempt: 0 },
    ]);
    assert.equal(phase, 'executor');
  });

  test('detects failure cascade correctly', () => {
    const cascade = collectFailureCascade(baseRun);
    assert.equal(cascade.has('planner'), true);
    assert.equal(cascade.has('developer'), true);
  });

  test('recovers failed tasks into retriable state', () => {
    const recovered = buildFailureRecoveryState(baseRun);
    assert.equal(recovered?.status, 'running');
    assert.equal(recovered?.fixAttempts, 1);
    if (!recovered) {
      return;
    }
    const planner = recovered.tasks.find((item) => item.id === 'planner');
    const developer = recovered.tasks.find((item) => item.id === 'developer');
    assert.equal(planner?.status, 'queued');
    assert.equal(developer?.status, 'blocked');
  });

  test('allTasksFinished reports when every task is terminal', () => {
    const allSuccess = allTasksFinished({
      ...baseRun,
      tasks: [
        { id: 'planner', name: 'plan', role: 'planner', status: 'succeeded', attempt: 1 },
        { id: 'developer', name: 'impl', role: 'developer', status: 'succeeded', attempt: 0 },
      ],
    });
    assert.equal(allSuccess, true);

    const withRunning = allTasksFinished({
      ...baseRun,
      tasks: [
        { id: 'planner', name: 'plan', role: 'planner', status: 'running', attempt: 1 },
        { id: 'developer', name: 'impl', role: 'developer', status: 'succeeded', attempt: 0 },
      ],
    });
    assert.equal(withRunning, false);
  });
});
