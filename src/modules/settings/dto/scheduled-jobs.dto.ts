import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { NoClientFields } from '../../../common/security/client-field.decorator';

/** One background job, as Settings → Scheduled jobs shows it (0167). */
@NoClientFields('a background job timing and its last run; no client data')
export class ScheduledJobDto {
  @ApiProperty({ example: 'mt5.syncAccounts' }) key: string;
  @ApiProperty({ enum: ['mt5', 'commission', 'money', 'system'] }) group: string;
  @ApiProperty({
    enum: ['crm', 'bridge'],
    description: '`bridge`: the MT5 bridge runs it and picks up a change within a minute.',
  })
  runsOn: string;
  @ApiProperty({ example: 600 }) intervalSeconds: number;
  @ApiProperty({ example: 600 }) defaultSeconds: number;
  @ApiProperty({ example: 60 }) minSeconds: number;
  @ApiProperty({ example: 86400 }) maxSeconds: number;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    enum: ['commission'],
    description:
      '`commission`: one interval for accruing and paying commission, which is also how long ' +
      'a commission is held before it is paid (the Trading settings value).',
  })
  sharedInterval: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastStartedAt: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastFinishedAt: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) lastDurationMs: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) lastError: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastErrorAt: string | null;
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'For a bridge job: when the bridge last read its interval.',
  })
  externalReadAt: string | null;
  @ApiProperty({ description: 'Started and not yet finished.' }) running: boolean;
}

@NoClientFields('a list of background job timings; no client data')
export class ScheduledJobListDto {
  @ApiProperty({ type: [ScheduledJobDto] }) items: ScheduledJobDto[];
}

export class UpdateScheduledJobDto {
  @ApiProperty({ example: 600, description: 'Seconds between runs, within the job’s bounds.' })
  @IsInt()
  @Min(10)
  @Max(2_678_400)
  intervalSeconds: number;
}
