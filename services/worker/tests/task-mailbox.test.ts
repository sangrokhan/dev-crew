import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyMailboxReassign,
  normalizeMailboxMessages,
} from '../src/team/task-mailbox';

describe('team mailbox', () => {
  test('normalizes and sorts mailbox entries', () => {
    const items = normalizeMailboxMessages([
      {
        id: '1',
        kind: 'notice',
        message: 'later',
        createdAt: '2025-02-01T00:00:01Z',
      },
      {
        kind: 'question',
        message: 'early',
        createdAt: '2025-02-01T00:00:00Z',
      },
      {
        kind: 'bad',
        message: 'ignore',
        createdAt: '2025-02-01T00:00:00Z',
      },
      {
        id: '2',
        kind: 'instruction',
        message: 'missing task',
        createdAt: '2025-02-01T00:00:02Z',
      },
    ]);

    assert.equal(items.length, 3);
    assert.equal(items[0].message, 'early');
    assert.equal(items[1].message, 'later');
    assert.equal(items[2].message, 'missing task');
  });

  test('reassign mailbox instruction resets target task', async () => {
    const base = {
      tasks: [
        {
          id: 'planner',
          status: 'succeeded' as const,
          role: 'planner' as const,
          name: 'plan',
          attempt: 2,
        },
        {
          id: 'executor',
          status: 'succeeded' as const,
          role: 'executor' as const,
          dependencies: ['planner'],
          name: 'exec',
          attempt: 1,
        },
      ],
      mailbox: [
        {
          id: 'msg-1',
          kind: 'reassign' as const,
          taskId: 'executor',
          message: 'Please rerun only this task',
          createdAt: '2025-02-01T00:00:00Z',
          delivered: false,
        },
      ],
    };

    const result = await applyMailboxReassign('job', base, {
      now: () => '2025-02-01T00:00:10Z',
      isTaskReady: () => false,
      onReassign: ({ taskId }) => {
        assert.equal(taskId, 'executor');
      },
    });

    assert.equal(result.changed, true);
    const target = result.state.tasks.find((task) => task.id === 'executor');
    assert.equal(target?.status, 'blocked');
    assert.equal(result.state.mailbox?.[0].delivered, true);
  });

  test('question/instruction mailbox emits callbacks without task mutation', async () => {
    const base = {
      tasks: [
        {
          id: 'planner',
          status: 'succeeded' as const,
          role: 'planner' as const,
          name: 'plan',
          attempt: 2,
        },
      ],
      mailbox: [
        {
          id: 'msg-question',
          kind: 'question' as const,
          taskId: 'planner',
          to: 'planner' as const,
          message: 'Can you clarify?',
          createdAt: '2025-02-01T00:00:00Z',
          delivered: false,
        },
        {
          id: 'msg-instruction',
          kind: 'instruction' as const,
          taskId: 'planner',
          to: 'planner' as const,
          message: 'Use strict mode',
          createdAt: '2025-02-01T00:00:00Z',
          delivered: false,
        },
      ],
    };

    let questionTaskId: string | undefined;
    let instructionTaskId: string | undefined;

    const result = await applyMailboxReassign('job', base, {
      now: () => '2025-02-01T00:00:10Z',
      onQuestion: ({ taskId }) => {
        questionTaskId = taskId;
      },
      onInstruction: ({ taskId }) => {
        instructionTaskId = taskId;
      },
    });

    assert.equal(result.changed, false);
    assert.equal(questionTaskId, 'planner');
    assert.equal(instructionTaskId, 'planner');
    assert.equal(result.state.tasks[0].status, 'succeeded');
    assert.equal(result.state.mailbox?.every((entry) => entry.delivered), true);
  });
});
