import assert from 'node:assert/strict';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { PATH_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

import { JobsController } from '../src/jobs/jobs.controller';

class RecordingService {
  createJob = async (dto: { jobId?: string }) => ({
    id: dto.jobId ?? 'job-123',
    status: 'queued',
  });

  getJob = async (jobId: string) => ({ id: jobId, task: 'sample task' });

  getTeamState = async (jobId: string) => ({ jobId, status: 'queued', metrics: { total: 1, queued: 1 } });

  getTeamMailbox = async (jobId: string) => [
    {
      id: 'm1',
      kind: 'reassign',
      taskId: 'team-planner',
      message: 'retry planner',
      to: 'planner',
      delivered: false,
      createdAt: '2026-02-20T00:00:00.000Z',
    },
    { id: 'm2', kind: 'notice', message: 'note', delivered: false, createdAt: '2026-02-20T00:01:00.000Z' },
  ];

  sendTeamMailboxMessage = async (jobId: string, message: Record<string, unknown>) => ({
    jobId,
    ...message,
    id: 'generated',
    delivered: false,
    deliveredAt: null,
  });

  applyTaskAction = async (jobId: string, taskId: string, action: string) => ({
    id: jobId,
    taskId,
    status: action,
  });

  applyAction = async (jobId: string, action: string) => ({ id: jobId, status: action });
  listRecentEvents = async () => [
    {
      id: 'evt-1',
      type: 'queued',
      message: 'queued',
    },
  ];
}

let controller: JobsController;
let service: RecordingService;

beforeEach(() => {
  service = new RecordingService();
  controller = new (JobsController as unknown as new (...args: never[]) => JobsController)(service as never);
});

afterEach(() => {
  service = new RecordingService();
  controller = new (JobsController as unknown as new (...args: never[]) => JobsController)(service as never);
});

describe('JobsController', () => {
  test('supports both jobs and runs base paths', () => {
    const paths = Reflect.getMetadata(PATH_METADATA, JobsController);
    assert.equal(Array.isArray(paths), true);
    assert.equal(paths.includes('jobs'), true);
    assert.equal(paths.includes('runs'), true);
  });

  test('create calls service and returns id/status', async () => {
    const created = await controller.create({ jobId: 'c1' } as any);
    assert.equal(created.jobId, 'c1');
    assert.equal(created.status, 'queued');
  });

  test('get forwards to service result', async () => {
    const job = await controller.get('job-2');
    assert.equal(job.id, 'job-2');
    assert.equal(job.task, 'sample task');
  });

  test('getTeamState forwards to service result', async () => {
    const state = await controller.getTeamState('job-3');
    assert.equal(state.jobId, 'job-3');
    assert.equal(state.status, 'queued');
  });

  test('getTeamMailbox forwards to service result', async () => {
    const mailbox = (await controller.getTeamMailbox('job-mailbox')) as Array<{ kind: string }>;
    assert.equal(mailbox.length, 2);
    assert.equal(mailbox[0].kind, 'reassign');
    assert.equal(mailbox[1].kind, 'notice');
  });

  test('action validates supported action values', async () => {
    const result = await controller.action('job-4', 'approve');
    assert.equal(result.id, 'job-4');
    assert.equal(result.status, 'approve');

    try {
      await controller.action('job-4', 'invalid' as never);
      assert.fail('Invalid action should reject');
    } catch (error) {
      const response = error as { response?: { message?: string | string[] } };
      if (Array.isArray(response.response?.message)) {
        assert.equal(response.response.message.includes('Unsupported action: invalid'), true);
      } else {
        assert.equal(response.response?.message, 'Unsupported action: invalid');
      }
    }
  });

  test('taskAction validates and forwards', async () => {
    const result = (await controller.taskAction('job-4', 'team-planner', 'approve') as unknown) as {
      id: string;
      taskId: string;
      status: string;
    };
    assert.equal(result.id, 'job-4');
    assert.equal(result.taskId, 'team-planner');
    assert.equal(result.status, 'approve');

    try {
      await controller.taskAction('job-4', 'team-planner', 'invalid' as never);
      assert.fail('Invalid task action should reject');
    } catch (error) {
      const response = error as { response?: { message?: string | string[] } };
      if (Array.isArray(response.response?.message)) {
        assert.equal(response.response.message.includes('Unsupported task action: invalid'), true);
      } else {
        assert.equal(response.response?.message, 'Unsupported task action: invalid');
      }
    }
  });

  test('stream emits job events', async () => {
    const event = await firstValueFrom(controller.stream('job-5'));
    const payload = event.data as { id: string; type?: string; message?: string };
    assert.equal(event.type, 'queued');
    assert.equal(payload.id, 'evt-1');
  });

  test('sendTeamMailboxMessage forwards to service with payload', async () => {
    const response = (await controller.sendTeamMailboxMessage('job-6', {
      kind: 'notice',
      message: 'please note',
      to: 'planner',
      taskId: 'team-planner',
    })) as { jobId: string; kind: string; to: string; message: string };

    assert.equal(response.jobId, 'job-6');
    assert.equal(response.kind, 'notice');
    assert.equal(response.to, 'planner');
    assert.equal(response.message, 'please note');
  });
});
