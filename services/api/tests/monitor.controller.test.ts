import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { MonitorController } from '../src/monitor/monitor.controller';

class RecordingJobsService {
  public lastLimit: number | undefined;

  async getMonitorOverview(limit?: number) {
    this.lastLimit = limit;
    return {
      generatedAt: '2026-02-21T00:00:00.000Z',
      jobs: {
        total: 2,
        queued: 1,
        running: 1,
        waiting_approval: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
        active: 2,
      },
      activeJobs: [],
      activeAgents: [],
      tokens: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        jobsWithUsage: 1,
        jobsWithoutUsage: 1,
      },
    };
  }
}

let controller: MonitorController;
let service: RecordingJobsService;

beforeEach(() => {
  service = new RecordingJobsService();
  controller = new (MonitorController as unknown as new (...args: never[]) => MonitorController)(service as never);
});

describe('MonitorController', () => {
  test('getOverview forwards query limit to service', async () => {
    const response = await controller.getOverview({ limit: 123 });

    assert.equal(response.jobs.active, 2);
    assert.equal(response.tokens.totalTokens, 15);
    assert.equal(service.lastLimit, 123);
  });
});
