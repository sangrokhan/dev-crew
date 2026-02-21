import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JobsService, MonitorOverview } from '../jobs/jobs.service';
import { MonitorOverviewQueryDto } from './dto/monitor-overview-query.dto';

@ApiTags('monitor')
@Controller('monitor')
export class MonitorController {
  constructor(private readonly jobsService: JobsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get global monitoring overview for jobs/agents/tokens' })
  @ApiOkResponse({ description: 'Monitoring overview payload' })
  getOverview(@Query() query: MonitorOverviewQueryDto): Promise<MonitorOverview> {
    return this.jobsService.getMonitorOverview(query.limit);
  }
}

