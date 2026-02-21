import assert from 'node:assert/strict';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { JobsController } from '../src/jobs/jobs.controller';

class RecordingService {
  createJob = async (dto: { jobId?: string }) => ({
    id: dto.jobId ?? 'job-123',
    status: 'queued',
  });

  getJob = async (jobId: string) => ({ id: jobId, task: 'sample task' });

  getTeamState = async (jobId: string) => ({ jobId, status: 'queued', metrics: { total: 1, queued: 1 } });

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

  test('stream emits job events', async () => {
    const event = await firstValueFrom(controller.stream('job-5'));
    const payload = event.data as { id: string; type?: string; message?: string };
    assert.equal(event.type, 'queued');
    assert.equal(payload.id, 'evt-1');
  });
});
