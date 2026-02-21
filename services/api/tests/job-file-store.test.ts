import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { JobFileStore } from '../src/jobs/storage/job-store';

type CreateInput = {
  provider: 'codex' | 'claude' | 'gemini';
  mode: 'autopilot' | 'team' | 'ralph' | 'ultrawork' | 'pipeline';
  repo: string;
  ref: string;
  task: string;
};

function tempStateRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'omx-api-store-'));
}

describe('api JobFileStore', () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = tempStateRoot();
    process.env.OMX_STATE_ROOT = stateRoot;
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  test('creates and reads jobs with defaults', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'codex',
        mode: 'team',
        repo: '',
        ref: '',
        task: 'normalize defaults',
      } as CreateInput as never,
      'none',
    );

    const found = await store.findJobById(created.id);
    assert.equal(Boolean(found), true);
    assert.equal(found?.repo, 'unknown');
    assert.equal(found?.ref, 'main');
    assert.equal(found?.status, 'queued');
    assert.equal(found?.approvalState, 'none');
  });

  test('updates existing job and rejects missing job id', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'gemini',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'job update',
      } as CreateInput as never,
      'none',
    );

    const updated = await store.updateJob(created.id, {
      status: 'running',
      output: { artifacts: ['a', 'b'] },
    });
    assert.equal(updated.status, 'running');
    assert.equal(updated.id, created.id);

    await assert.rejects(() => store.updateJob('missing', { status: 'failed' }), /ENOENT|job not found/);
  });

  test('stores and lists events in expected order', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'claude',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'job events',
      } as CreateInput as never,
      'none',
    );

    await store.addEvent(created.id, 'queued', 'job queued');
    await store.addEvent(created.id, 'running', 'job running', { attempt: 1 });
    await store.addEvent(created.id, 'succeeded', 'job succeeded');

    const all = await store.listRecentEvents(created.id);
    const limited = await store.listRecentEvents(created.id, 2);
    assert.equal(all.length, 3);
    assert.equal(limited.length, 2);
    assert.equal(limited[0].type, 'running');
    assert.equal(limited[1].type, 'succeeded');
    assert.equal(limited[1].payload, undefined);
  });

  test('returns empty events when event log is missing', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'gemini',
        mode: 'autopilot',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'no events',
      } as CreateInput as never,
      'none',
    );

    const events = await store.listRecentEvents(created.id);
    assert.equal(events.length, 0);
  });

  test('throws when event log is malformed JSON', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'gemini',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'malformed events',
      } as CreateInput as never,
      'none',
    );

    const eventPath = path.join(stateRoot, created.id, 'events.jsonl');
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.writeFile(eventPath, 'not-json', 'utf8');

    await assert.rejects(() => store.listRecentEvents(created.id), /Unexpected token/);
  });

  test('uses repository state root when env override is absent', async () => {
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
    const exists = existsSync(recordPath);
    assert.equal(exists, true);
    assert.equal((await store.findJobById(created.id))?.id, created.id);

    if (previousRoot === undefined) {
      delete process.env.OMX_STATE_ROOT;
    } else {
      process.env.OMX_STATE_ROOT = previousRoot;
    }
    rmSync(path.join(current, '.omx', 'state', 'jobs', created.id), { recursive: true, force: true });
  });

  test('returns null when record payload is invalid JSON shape', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'codex',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'invalid payload',
      } as CreateInput as never,
      'none',
    );

    const recordPath = path.join(stateRoot, created.id, 'record.json');
    await fs.writeFile(recordPath, '"not-an-object"', 'utf8');

    const missing = await store.findJobById(created.id);
    assert.equal(missing, null);
  });

  test('normalizes invalid status during update', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'codex',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'invalid status',
      } as CreateInput as never,
      'none',
    );

    const recordPath = path.join(stateRoot, created.id, 'record.json');
    await fs.writeFile(
      recordPath,
      JSON.stringify({
        id: created.id,
        provider: 'codex',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'invalid status',
        options: null,
        status: 'bad-status',
        approvalState: 'bad-approval',
        output: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const updated = await store.updateJob(created.id, {});
    assert.equal(updated.status, 'queued');
    assert.equal(updated.approvalState, 'none');
  });

  test('reacquires lock when stale lock file exists', async () => {
    const store = new JobFileStore();
    const created = await store.createJob(
      {
        provider: 'codex',
        mode: 'team',
        repo: 'git@github.com:example/repo.git',
        ref: 'main',
        task: 'stale lock',
      } as CreateInput as never,
      'none',
    );

    const lockPath = path.join(stateRoot, created.id, '.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid: 9999, startedAt: new Date(Date.now() - 60_000).toISOString() }), 'utf8');

    const updated = await store.updateJob(created.id, { status: 'running' });
    assert.equal(updated.status, 'running');
    assert.equal(existsSync(lockPath), false);
  });
});
