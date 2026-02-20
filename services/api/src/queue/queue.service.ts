import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';

export const JOB_QUEUE_NAME = 'jobs';

@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly queue: Queue | null;
  private readonly useRedisQueue: boolean;
  private readonly queueRoot: string;
  private readonly pendingQueueDir: string;
  private readonly processingQueueDir: string;

  constructor() {
    const redisUrl = process.env.REDIS_URL;

    this.queue = redisUrl ? this.createRedisQueue(redisUrl) : null;
    this.useRedisQueue = Boolean(redisUrl);

    this.queueRoot = path.join(resolveStateRoot(), '.queue');
    this.pendingQueueDir = path.join(this.queueRoot, 'pending');
    this.processingQueueDir = path.join(this.queueRoot, 'processing');
  }

  enqueueJob(jobId: string): Promise<void> {
    if (this.useRedisQueue) {
      if (!this.queue) {
        throw new Error('Queue is not initialized');
      }

      return this.queue
        .add(
          JOB_QUEUE_NAME,
          { jobId },
          {
            jobId,
            removeOnComplete: 100,
            removeOnFail: 500,
          },
        )
        .then(() => undefined);
    }

    return this.enqueueJobToFile(jobId);
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.queue) {
      return;
    }
    await this.queue.close();
  }

  private createRedisQueue(redisUrl: string): Queue {
    const parsed = new URL(redisUrl);
    return new Queue(JOB_QUEUE_NAME, {
      connection: {
        host: parsed.hostname,
        port: Number(parsed.port || 6379),
        username: parsed.username || undefined,
        password: parsed.password || undefined,
        maxRetriesPerRequest: null,
      },
    });
  }

  private async enqueueJobToFile(jobId: string): Promise<void> {
    await fs.mkdir(this.pendingQueueDir, { recursive: true });
    await fs.mkdir(this.processingQueueDir, { recursive: true });

    const pendingPath = path.join(this.pendingQueueDir, `${jobId}.json`);
    const processingPath = path.join(this.processingQueueDir, `${jobId}.json`);

    if (await exists(pendingPath) || await exists(processingPath)) {
      return;
    }

    const payload = {
      id: randomUUID(),
      jobId,
      createdAt: new Date().toISOString(),
    };

    await fs.writeFile(pendingPath, JSON.stringify(payload), 'utf8');
  }
}

function resolveStateRoot() {
  const explicit = process.env.OMX_STATE_ROOT;
  if (explicit) {
    return path.resolve(explicit);
  }

  let current = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, '.omx', 'state', 'jobs');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return path.join(process.cwd(), '.omx', 'state', 'jobs');
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
