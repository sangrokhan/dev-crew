import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { JobsModule } from './jobs/jobs.module';
import { MonitorModule } from './monitor/monitor.module';

@Module({
  imports: [JobsModule, MonitorModule],
  controllers: [HealthController],
})
export class AppModule {}
