import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parsePlannerOutput, validatePlannerOutput } from '../src/team/planner-schema';

describe('planner schema validator', () => {
  test('accepts valid planner output', () => {
    const result = parsePlannerOutput({
      plan_summary: 'feature implementation',
      tasks: [
        {
          id: 'team-planner',
          subject: 'Define work',
          role: 'planner',
          maxAttempts: 1,
        },
        {
          id: 'team-executor',
          subject: 'Implement changes',
          role: 'executor',
          depends_on: ['team-planner'],
        },
      ],
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.planSummary, 'feature implementation');
    assert.equal(result.value.tasks.length, 2);
    assert.equal(result.value.tasks[1].dependencies.length, 1);
  });

  test('accepts camelCase planSummary and dependsOn', () => {
    const result = parsePlannerOutput({
      planSummary: 'feature implementation',
      tasks: [
        {
          id: 'team-planner',
          name: 'Define work',
          role: 'planner',
          maxAttempts: 1,
        },
        {
          id: 'team-executor',
          subject: 'Implement changes',
          role: 'executor',
          dependsOn: ['team-planner'],
          timeoutSeconds: 1800,
        },
      ],
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.planSummary, 'feature implementation');
    assert.equal(result.value.tasks.length, 2);
    assert.equal(result.value.tasks[1].dependencies.length, 1);
    assert.equal(result.value.tasks[1].timeoutSeconds, 1800);
  });

  test('reports missing plan summary', () => {
    const errors = validatePlannerOutput({
      tasks: [{ subject: 'x', role: 'planner' }],
    });
    assert.equal(errors.length > 0, true);
    assert.equal(
      errors.some((item) => item.path === 'plan_summary'),
      true,
    );
  });

  test('invalid role and cycle are detected', () => {
    const result = parsePlannerOutput({
      plan_summary: 'buggy plan',
      tasks: [
        {
          id: 'a',
          role: 'planner',
          description: 'A',
          depends_on: ['b'],
        },
        {
          id: 'b',
          role: 'executor',
          description: 'B',
          depends_on: ['a'],
        },
        {
          id: 'c',
          role: 'wrong',
          description: 'bad role',
        },
      ],
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.errors.length >= 2, true);
    assert.equal(result.errors.some((item) => item.path === 'tasks[2].role'), true);
    assert.equal(result.errors.some((item) => item.path === 'tasks'), true);
  });
});
