import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const JOB_QUEUE_NAME = 'jobs';

@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly connection: IORedis;
  private readonly queue: Queue;

  constructor() {
    const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(JOB_QUEUE_NAME, { connection: this.connection });
  }

  enqueueJob(jobId: string): Promise<void> {
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

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
