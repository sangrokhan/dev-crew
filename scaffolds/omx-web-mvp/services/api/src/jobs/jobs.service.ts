import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { ApprovalState, JobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { CreateJobDto } from './dto/create-job.dto';
import { JobAction } from './job.types';

const TERMINAL_STATUSES: JobStatus[] = [JobStatus.succeeded, JobStatus.failed, JobStatus.canceled];

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async createJob(dto: CreateJobDto) {
    const approvalState = dto.options?.requireApproval ? ApprovalState.required : ApprovalState.none;

    const created = await this.prisma.job.create({
      data: {
        provider: dto.provider,
        mode: dto.mode,
        repo: dto.repo,
        ref: dto.ref,
        task: dto.task,
        options: (dto.options ?? {}) as Prisma.InputJsonValue,
        status: JobStatus.queued,
        approvalState,
      },
    });

    await this.addEvent(created.id, 'queued', 'Job queued');
    await this.queue.enqueueJob(created.id);

    return created;
  }

  async getJob(jobId: string) {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job not found: ${jobId}`);
    return job;
  }

  async listRecentEvents(jobId: string, take = 100) {
    await this.getJob(jobId);
    return this.prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
    });
  }

  async applyAction(jobId: string, action: JobAction) {
    const current = await this.getJob(jobId);

    if (action === 'cancel') {
      if (TERMINAL_STATUSES.includes(current.status)) {
        throw new ConflictException('Job is already in a terminal state');
      }

      const updated = await this.prisma.job.update({
        where: { id: jobId },
        data: {
          status: JobStatus.canceled,
          finishedAt: new Date(),
        },
      });
      await this.addEvent(jobId, 'canceled', 'Job canceled by user');
      return updated;
    }

    if (current.status !== JobStatus.waiting_approval || current.approvalState !== ApprovalState.required) {
      throw new ConflictException('Job is not waiting for approval');
    }

    if (action === 'approve') {
      const updated = await this.prisma.job.update({
        where: { id: jobId },
        data: {
          approvalState: ApprovalState.approved,
          status: JobStatus.queued,
          error: null,
        },
      });
      await this.addEvent(jobId, 'approval', 'Approval granted, re-queued');
      await this.queue.enqueueJob(jobId);
      return updated;
    }

    const updated = await this.prisma.job.update({
      where: { id: jobId },
      data: {
        approvalState: ApprovalState.rejected,
        status: JobStatus.failed,
        error: 'Rejected by approver',
        finishedAt: new Date(),
      },
    });
    await this.addEvent(jobId, 'approval', 'Approval rejected');
    return updated;
  }

  async addEvent(jobId: string, type: string, message: string, payload?: Prisma.InputJsonValue) {
    return this.prisma.jobEvent.create({
      data: {
        jobId,
        type,
        message,
        payload,
      },
    });
  }
}
