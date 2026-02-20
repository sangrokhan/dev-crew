#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';

const children = [];
let shuttingDown = false;

function spawnProcess(name, args) {
  const child = spawn('npm', args, {
    env: {
      ...process.env,
      OMX_STATE_ROOT: process.env.OMX_STATE_ROOT ?? path.resolve(process.cwd(), '.omx', 'state', 'jobs'),
    },
    stdio: 'inherit',
  });

  children.push({ name, child });

  child.on('exit', (code) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`[dev-local] ${name} exited with code ${code}`);

    for (const proc of children) {
      if (proc.child.pid !== child.pid && !proc.child.killed) {
        proc.child.kill('SIGTERM');
      }
    }

    process.exitCode = code ?? 0;
  });

  child.on('error', (error) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`[dev-local] failed to start ${name}:`, error);
    for (const proc of children) {
      proc.child.kill('SIGTERM');
    }
    process.exitCode = 1;
  });
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[dev-local] ${signal} received, stopping all processes...`);
  for (const proc of children) {
    if (!proc.child.killed) {
      proc.child.kill(signal);
    }
  }
  // wait a bit for graceful stop
  setTimeout(() => {
    for (const proc of children) {
      if (!proc.child.killed) {
        proc.child.kill('SIGKILL');
      }
    }
  }, 2000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

spawnProcess('api', ['run', 'dev:api']);
spawnProcess('worker', ['run', 'dev:worker']);

process.on('exit', () => {
  for (const proc of children) {
    if (!proc.child.killed) {
      proc.child.kill('SIGTERM');
    }
  }
});
