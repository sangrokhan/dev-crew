import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { extractLatestParsedObject, resolveCliBinary, resolveCliCommandTemplate, runCodexCommand } from '../src/team/codex-runner';
import { type Provider } from '../src/storage/job-types';

describe('codex runner wrapper', () => {
  test('resolves command mode to shell for shell-like commands', () => {
    const mode = resolveCliCommandTemplate('npm test -- --watch', 'codex', { JOB_CODEX_CLI_BIN: 'codex' } as NodeJS.ProcessEnv);
    assert.equal(mode, 'shell');
  });

  test('prefers provider specific cli env', () => {
    const command = resolveCliBinary('codex', { JOB_CODEX_CLI_BIN: 'agent-a' } as never);
    assert.equal(command, 'agent-a');
  });

  test('extracts latest json line from multiline payload', () => {
    const parsed = extractLatestParsedObject('line one\n{"status":"running"}\n{"status":"done","ok":true}');
    assert.deepEqual(parsed, { status: 'done', ok: true });
  });

  test('extracts json from fenced block output', () => {
    const parsed = extractLatestParsedObject('log output\n```json\n{"status":"running"}\n```\ntrail');
    assert.equal(parsed?.status, 'running');
  });

  test('extracts latest object even when mixed with embedded braces', () => {
    const payload = [
      'note {"level":"trace","msg":"starting"}',
      '{"status":"interim","message":"{should not be parsed as delimiter}"}',
      '```',
      '{"status":"final","attempt":2}',
    ].join('\n');
    const parsed = extractLatestParsedObject(payload);
    assert.equal(parsed?.status, 'final');
    assert.equal(parsed?.attempt, 2);
  });

  test('ignores non-object json fragments and keeps valid latest object', () => {
    const parsed = extractLatestParsedObject('noise\n[{"kind":"ignore"},{"kind":"also"}]\n{"kind":"accepted","ok":true}');
    assert.equal(parsed?.kind, 'accepted');
    assert.equal(parsed?.ok, true);
  });

  test('builds command in shell and cli exec modes', () => {
    const calls: Array<{ binary: string; args: string[] }> = [];
    const fakeRunner = (binary: string, args: string[]) => {
      calls.push({ binary, args });
      return {
        status: 0,
        stdout: args.join(' '),
        stderr: '',
      };
    };

    const shellResult = runCodexCommand(
      'codex' as Provider,
      'echo hello',
      '/tmp',
      1000,
      {
        commandRunner: fakeRunner,
        env: { JOB_CODEX_CLI_BIN: 'codex' } as NodeJS.ProcessEnv,
      },
    );

  const directResult = runCodexCommand(
      'codex' as Provider,
      'codex --version',
      '/tmp',
      1000,
      {
        commandRunner: fakeRunner,
        env: { JOB_CODEX_CLI_BIN: 'codex' } as NodeJS.ProcessEnv,
      },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].binary, 'sh');
  assert.equal(calls[0].args[0], '-lc');
  assert.equal(calls[1].binary, 'codex');
  assert.equal(directResult.status, 0);
});
});
