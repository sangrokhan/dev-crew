import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JobFileStore } from './storage/job-store';

@Module({
  imports: [QueueModule],
  controllers: [JobsController],
  providers: [JobsService, JobFileStore],
  exports: [JobsService],
})
export class JobsModule {}
