import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { QueueService } from '../src/queue/queue.service';

function tempStateRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'omx-api-queue-'));
}

describe('QueueService file-mode', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = tempStateRoot();
    process.env.OMX_STATE_ROOT = stateRoot;
    process.env.REDIS_URL = '';
  });

  afterEach(() => {
    delete process.env.OMX_STATE_ROOT;
    delete process.env.REDIS_URL;
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test('creates pending queue file when missing', async () => {
    const queue = new QueueService();
    const jobId = 'job-file-1';
    await queue.enqueueJob(jobId);

    const pendingPath = path.join(stateRoot, '.queue', 'pending', `${jobId}.json`);
    assert.equal(existsSync(pendingPath), true);

    const payloadRaw = await fs.readFile(pendingPath, 'utf8');
    const payload = JSON.parse(payloadRaw);
    assert.equal(payload.jobId, jobId);
    assert.equal(typeof payload.id, 'string');
    assert.equal(new Date(payload.createdAt).toString() !== 'Invalid Date', true);
  });

  test('does not overwrite existing pending queue file', async () => {
    const queue = new QueueService();
    const jobId = 'job-file-2';
    await queue.enqueueJob(jobId);

    const pendingPath = path.join(stateRoot, '.queue', 'pending', `${jobId}.json`);
    const first = await fs.readFile(pendingPath, 'utf8');

    await queue.enqueueJob(jobId);
    const second = await fs.readFile(pendingPath, 'utf8');
    assert.equal(first, second);
  });

  test('skips enqueue when processing file exists', async () => {
    const processingPath = path.join(stateRoot, '.queue', 'processing', 'job-file-3.json');
    await fs.mkdir(path.dirname(processingPath), { recursive: true });
    await fs.writeFile(processingPath, JSON.stringify({ id: 'existing', jobId: 'job-file-3', createdAt: new Date().toISOString() }));

    const queue = new QueueService();
    await queue.enqueueJob('job-file-3');

    const pendingPath = path.join(stateRoot, '.queue', 'pending', 'job-file-3.json');
    assert.equal(existsSync(pendingPath), false);
  });

  test('falls back to repository state root when env override is missing', async () => {
    const previousRoot = process.env.OMX_STATE_ROOT;
    delete process.env.OMX_STATE_ROOT;
    const previousRedis = process.env.REDIS_URL;

    try {
      process.env.REDIS_URL = '';
      const queue = new QueueService();
      await queue.enqueueJob('job-file-4');

      let current = process.cwd();
      for (let depth = 0; depth < 8; depth += 1) {
        const candidate = path.join(current, '.omx', 'state', 'jobs');
        if (existsSync(candidate)) {
          break;
        }
        const parent = path.dirname(current);
        if (parent === current) {
          current = process.cwd();
          break;
        }
        current = parent;
      }

      if (!existsSync(path.join(current, '.omx', 'state', 'jobs'))) {
        current = process.cwd();
      }

      const defaultRoot = path.join(current, '.omx', 'state', 'jobs', '.queue', 'pending', 'job-file-4.json');
      assert.equal(existsSync(defaultRoot), true);
    } finally {
      const fallbackRoot = path.join(process.cwd(), '.omx', 'state', 'jobs');
      rmSync(fallbackRoot, { recursive: true, force: true });
      if (previousRoot === undefined) {
        delete process.env.OMX_STATE_ROOT;
      } else {
        process.env.OMX_STATE_ROOT = previousRoot;
      }
      if (previousRedis === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedis;
      }
    }
  });

  test('onApplicationShutdown does nothing when redis is not configured', async () => {
    const queue = new QueueService();
    await queue.onApplicationShutdown();
    assert.ok(true);
  });

  test('onApplicationShutdown closes queue service when queue is present', async () => {
    const queue = new QueueService();
    let closed = false;
    (queue as unknown as { queue: { close: () => Promise<void> } | null }).queue = {
      close: async () => {
        closed = true;
      },
    };

    await queue.onApplicationShutdown();
    assert.equal(closed, true);
  });

  test('enqueueJob delegates to queue.add when queue mode is enabled', async () => {
    const queue = new QueueService();
    let called = false;

    (queue as unknown as { useRedisQueue: boolean }).useRedisQueue = true;
    (queue as unknown as { queue: { add: (...args: unknown[]) => Promise<unknown> } | null }).queue = {
      add: async () => {
        called = true;
        return {} as never;
      },
    } as never;

    await queue.enqueueJob('job-file-redis');
    assert.equal(called, true);
  });

});
