import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsArray,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { modes, providers, teamRoles, TeamRole } from '../job.types';

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

  @ApiPropertyOptional({
    description: 'Researcher pane command template. Supports {JOB_ID}, {ROLE}, {TASK}, {WORKDIR}.',
  })
  @IsOptional()
  @IsString()
  researcher?: string;

  @ApiPropertyOptional({
    description: 'Designer pane command template. Supports {JOB_ID}, {ROLE}, {TASK}, {WORKDIR}.',
  })
  @IsOptional()
  @IsString()
  designer?: string;

  @ApiPropertyOptional({
    description: 'Developer pane command template. Supports {JOB_ID}, {ROLE}, {TASK}, {WORKDIR}.',
  })
  @IsOptional()
  @IsString()
  developer?: string;
}

class TeamTaskTemplateDto {
  @ApiProperty({ minLength: 2, maxLength: 180, description: 'Task display name.' })
  @IsString()
  @MinLength(2)
  @MaxLength(180)
  name!: string;

  @ApiProperty({ enum: teamRoles })
  @IsEnum(teamRoles)
  role!: TeamRole;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dependencies?: string[];

  @ApiPropertyOptional({ minimum: 1, maximum: 5, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxAttempts?: number;

  @ApiPropertyOptional({ minimum: 60, maximum: 3600, default: 900 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(3600)
  timeoutSeconds?: number;
}

class TeamOptionsDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 10, default: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  maxFixAttempts?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 8, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
  parallelTasks?: number;

  @ApiPropertyOptional({
    type: [TeamTaskTemplateDto],
    description: 'Optional team task templates overriding default planner→research→implement→verify flow.',
  })
  @ValidateIf((value) => value.teamTasks !== undefined)
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TeamTaskTemplateDto)
  teamTasks?: TeamTaskTemplateDto[];

  @ApiPropertyOptional({
    default: false,
    description: 'Enable tmux role-pane visualization for team mode execution.',
  })
  @IsOptional()
  @IsBoolean()
  tmuxVisualization?: boolean;

  @ApiPropertyOptional({
    description: 'Reserved object for future plan/approval extensions.',
  })
  @IsOptional()
  @IsObject()
  extras?: Record<string, unknown>;
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

  @ApiPropertyOptional({ type: TeamOptionsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => TeamOptionsDto)
  team?: TeamOptionsDto;
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
