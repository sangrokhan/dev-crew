import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { type Provider } from '../storage/job-types';

export interface CodexRunOutput {
  status: number;
  stdout: string;
  stderr: string;
  parsed?: Record<string, unknown>;
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunCodexCommandOptions {
  timeoutMs?: number;
  commandRunner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  binary: string,
  args: string[],
  options?: {
    cwd?: string;
    allowFailure?: boolean;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
) => CommandResult;

const SHELL_COMMAND_PREFIXES = new Set([
  'bash',
  'echo',
  'git',
  'node',
  'npm',
  'python',
  'python3',
  'sh',
  'tmux',
  'yarn',
  'bun',
  'pnpm',
  'npx',
]);

const DEFAULT_CLI_BINARIES: Record<Provider, string> = {
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini',
};

function commandResultOrThrow(
  binary: string,
  args: string[],
  options?: {
    cwd?: string;
    allowFailure?: boolean;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
): CommandResult {
  const result = spawnSync(binary, args, {
    cwd: options?.cwd,
    env: options?.env,
    encoding: 'utf8',
    timeout: options?.timeout,
  });

  if (result.error) {
    throw result.error;
  }

  const status = result.status ?? 1;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (!options?.allowFailure && status !== 0) {
    throw new Error(`${binary} ${args.join(' ')} failed (${status}): ${stderr || stdout}`);
  }

  return { status, stdout, stderr };
}

export function resolveCliBinary(provider: Provider, env: NodeJS.ProcessEnv = process.env): string {
  const providerBinary = env[`JOB_${provider.toUpperCase()}_CLI_BIN`];
  if (providerBinary?.trim()) {
    return providerBinary.trim();
  }

  const genericBinary = env.JOB_CLI_BIN;
  if (genericBinary?.trim()) {
    return genericBinary.trim();
  }

  return DEFAULT_CLI_BINARIES[provider] ?? 'codex';
}

export function resolveCliCommandTemplate(command: string, provider: Provider, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return '';
  }

  const token = trimmed.split(/\s+/)[0] ?? '';
  const binary = resolveCliBinary(provider, env);
  const commandBase = token.endsWith(`/${path.basename(binary)}`) ? path.basename(binary) : token;
  if (SHELL_COMMAND_PREFIXES.has(commandBase)) {
    return 'shell';
  }

  if (token === binary || token === path.basename(binary) || token.endsWith(`/${path.basename(binary)}`)) {
    return binary;
  }

  return '';
}

export function extractLatestParsedObject(payload: string): Record<string, unknown> | undefined {
  const candidates: string[] = [];
  const fullPayload = payload.trim();
  const codeFenceRegex = /```(?:json)?\n([\s\S]*?)```/gi;

  for (const match of fullPayload.matchAll(codeFenceRegex)) {
    if (match[1]) {
      const block = match[1].trim();
      if (block) {
        candidates.push(block);
      }
    }
  }

  const scanForJsonObjects = (input: string): string[] => {
    const found: string[] = [];
    let inString = false;
    let escaped = false;
    let depth = 0;
    let start = -1;

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if ((char === '{' || char === '[') && depth === 0) {
        start = index;
      }

      if (start !== -1 && (char === '{' || char === '[')) {
        depth += 1;
        continue;
      }

      if (start !== -1 && (char === '}' || char === ']')) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          found.push(input.slice(start, index + 1));
          start = -1;
        }
      }
    }

    return found;
  };

  for (const candidate of scanForJsonObjects(fullPayload)) {
    candidates.push(candidate.trim());
  }

  for (const line of fullPayload
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)) {
    candidates.push(line);
  }

  let latest: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        latest = parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  return latest;
}

export function runCodexCommand(
  provider: Provider,
  command: string,
  workdir: string,
  timeoutMs = 120000,
  options: RunCodexCommandOptions = {},
): CodexRunOutput {
  const trimmed = command.trim();
  const binary = resolveCliBinary(provider, options.env);
  const directMode = resolveCliCommandTemplate(trimmed, provider, options.env);
  const useShell = directMode === 'shell';
  const runner = options.commandRunner ?? commandResultOrThrow;
  const result = useShell
    ? runner('sh', ['-lc', trimmed], {
        cwd: workdir,
        allowFailure: true,
        timeout: timeoutMs,
        env: options.env,
      })
    : runner(
        binary,
        ['exec', '--json', '--full-auto', '--skip-git-repo-check', '--cd', workdir, trimmed],
        {
          cwd: workdir,
          env: options.env,
          allowFailure: true,
          timeout: timeoutMs,
        },
      );

  const payload = `${result.stdout}\n${result.stderr}`;

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed: extractLatestParsedObject(payload),
  };
}
