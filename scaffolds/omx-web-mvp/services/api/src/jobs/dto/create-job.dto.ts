import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { modes, providers } from '../job.types';

class AgentCommandsDto {
  @ApiPropertyOptional({
    description: 'Planner pane command template. Supports {JOB_ID}, {ROLE}, {TASK}, {WORKDIR}.',
  })
  @IsOptional()
  @IsString()
  planner?: string;

  @ApiPropertyOptional({
    description: 'Executor pane command template. Supports {JOB_ID}, {ROLE}, {TASK}, {WORKDIR}.',
  })
  @IsOptional()
  @IsString()
  executor?: string;

  @ApiPropertyOptional({
    description: 'Verifier pane command template. Supports {JOB_ID}, {ROLE}, {TASK}, {WORKDIR}.',
  })
  @IsOptional()
  @IsString()
  verifier?: string;
}

class JobOptionsDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 16, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(16)
  workers?: number;

  @ApiPropertyOptional({ minimum: 5, maximum: 480, default: 60 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(480)
  maxMinutes?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requireApproval?: boolean;

  @ApiPropertyOptional({
    default: true,
    description: 'Keep tmux session after completion for inspection.',
  })
  @IsOptional()
  @IsBoolean()
  keepTmuxSession?: boolean;

  @ApiPropertyOptional({ type: AgentCommandsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AgentCommandsDto)
  agentCommands?: AgentCommandsDto;
}

export class CreateJobDto {
  @ApiProperty({ enum: providers })
  @IsEnum(providers)
  provider!: (typeof providers)[number];

  @ApiProperty({ enum: modes })
  @IsEnum(modes)
  mode!: (typeof modes)[number];

  @ApiProperty({ example: 'git@github.com:org/project.git' })
  @IsString()
  @MinLength(3)
  @MaxLength(512)
  repo!: string;

  @ApiProperty({ example: 'main' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  ref!: string;

  @ApiProperty({ example: 'Refactor billing module and add tests' })
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  task!: string;

  @ApiPropertyOptional({ type: JobOptionsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => JobOptionsDto)
  options?: JobOptionsDto;
}
