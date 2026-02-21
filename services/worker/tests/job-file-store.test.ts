import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { JobFileStore } from '../src/storage/job-file-store';

type CreateInput = {
  provider: 'codex' | 'claude' | 'gemini';
  mode: 'autopilot' | 'team' | 'ralph' | 'ultrawork' | 'pipeline';
  repo: string;
  ref: string;
  task: string;
};

function tempStateRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'omx-worker-store-'));
}

describe('worker JobFileStore', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = tempStateRoot();
    process.env.OMX_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test('creates and reads job records', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'codex',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'worker job',
      } as CreateInput as never,
      'none',
    );

    const found = await store.findJobById(created.id);
    assert.ok(found);
    assert.equal(found?.id, created.id);
    assert.equal(found?.status, 'queued');
    assert.equal(found?.approvalState, 'none');
    assert.equal(found?.repo, 'git@github.com:example/repo.git');
  });

  test('updates existing job and rejects missing job', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'gemini',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'worker update',
      } as CreateInput as never,
      'none',
    );

    const updated = await store.updateJob(created.id, {
      status: 'running',
      error: 'temporary issue',
      finishedAt: undefined,
    });
    assert.equal(updated.status, 'running');
    assert.equal(updated.error, 'temporary issue');

    await assert.rejects(() => store.updateJob('missing', { status: 'failed' }), /ENOENT/);
  });

  test('stores and lists events in chronological order', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'claude',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'worker events',
      } as CreateInput as never,
      'none',
    );

    await store.addEvent(created.id, 'queued', 'job queued');
    await store.addEvent(created.id, 'running', 'job running');

    const events = await store.listRecentEvents(created.id);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'queued');
    assert.equal(events[1].type, 'running');
    assert.equal(events[1].message, 'job running');
  });

  test('lists events as empty when log file does not exist', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'gemini',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'no events file',
      } as CreateInput as never,
      'none',
    );

    const events = await store.listRecentEvents(created.id);
    assert.equal(events.length, 0);
  });

  test('creates job using discovered repository state root when env override is absent', async () => {
    const previousRoot = process.env.OMX_STATE_ROOT;
    delete process.env.OMX_STATE_ROOT;

    let current = process.cwd();
    for (let depth = 0; depth < 8; depth += 1) {
      const hasApi = existsSync(path.join(current, 'services', 'api', 'package.json'));
      const hasWorker = existsSync(path.join(current, 'services', 'worker', 'package.json'));
      if (hasApi || hasWorker) {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'codex',
        mode: 'pipeline',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'default root job',
      } as CreateInput as never,
      'none',
    );

    const recordPath = path.join(current, '.omx', 'state', 'jobs', created.id, 'record.json');
    assert.equal(created.id.length > 0, true);
    assert.equal((await store.findJobById(created.id))?.id, created.id);
    assert.equal(existsSync(recordPath), true);

    if (previousRoot === undefined) {
      delete process.env.OMX_STATE_ROOT;
    } else {
      process.env.OMX_STATE_ROOT = previousRoot;
    }
    rmSync(path.join(current, '.omx', 'state', 'jobs', created.id), { recursive: true, force: true });
  });
});
