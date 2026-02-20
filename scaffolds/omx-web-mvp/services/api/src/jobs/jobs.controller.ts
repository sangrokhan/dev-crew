import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { MessageEvent } from '@nestjs/common';
import { Observable, filter, from, interval, map, mergeMap, startWith } from 'rxjs';
import { CreateJobDto } from './dto/create-job.dto';
import { actions, JobAction } from './job.types';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post()
  @ApiOperation({ summary: 'Create orchestration job' })
  @ApiCreatedResponse({ description: 'Created job' })
  async create(@Body() dto: CreateJobDto) {
    const created = await this.jobsService.createJob(dto);
    return {
      jobId: created.id,
      status: created.status,
    };
  }

  @Get(':jobId')
  @ApiOperation({ summary: 'Get job detail' })
  @ApiOkResponse({ description: 'Job details' })
  get(@Param('jobId') jobId: string) {
    return this.jobsService.getJob(jobId);
  }

  @Post(':jobId/actions/:action')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply approve/reject/cancel action' })
  @ApiParam({ name: 'action', enum: actions })
  action(@Param('jobId') jobId: string, @Param('action') action: string) {
    if (!actions.includes(action as JobAction)) {
      throw new BadRequestException(`Unsupported action: ${action}`);
    }

    return this.jobsService.applyAction(jobId, action as JobAction);
  }

  @Sse(':jobId/events')
  @ApiOperation({ summary: 'SSE stream for job events' })
  stream(@Param('jobId') jobId: string): Observable<MessageEvent> {
    const seen = new Set<string>();

    return interval(1000).pipe(
      startWith(0),
      mergeMap(() => from(this.jobsService.listRecentEvents(jobId, 200))),
      mergeMap((events) => from(events)),
      filter((event) => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        return true;
      }),
      map((event) => ({
        type: event.type,
        data: event,
      })),
    );
  }
}
