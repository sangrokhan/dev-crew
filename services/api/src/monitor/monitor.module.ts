import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { MonitorController } from './monitor.controller';

@Module({
  imports: [JobsModule],
  controllers: [MonitorController],
})
export class MonitorModule {}

