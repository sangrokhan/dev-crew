import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class MonitorOverviewQueryDto {
  @ApiPropertyOptional({
    description: 'Maximum number of most recent jobs included in aggregation.',
    minimum: 1,
    maximum: 2000,
    default: 200,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number;
}

