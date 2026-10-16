import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const CLIENT_ERROR_APPS = ['portal', 'admin'] as const;
/**
 * Where the frontend caught it: an error screen (`page`, `global`), or the
 * window's own listeners for an error no screen caught (`uncaught`) and a
 * promise nobody handled (`rejection`).
 */
export const CLIENT_ERROR_BOUNDARIES = ['page', 'global', 'uncaught', 'rejection'] as const;

/**
 * What a frontend's error screen sends when it is shown. Every field is capped
 * so one report stays a log line, not a payload; anything longer is refused
 * rather than stored.
 */
export class ClientErrorReportDto {
  @ApiProperty({ enum: CLIENT_ERROR_APPS })
  @IsIn(CLIENT_ERROR_APPS)
  app: (typeof CLIENT_ERROR_APPS)[number];

  @ApiProperty({ enum: CLIENT_ERROR_BOUNDARIES })
  @IsIn(CLIENT_ERROR_BOUNDARIES)
  boundary: (typeof CLIENT_ERROR_BOUNDARIES)[number];

  @ApiProperty({ description: 'The error name, e.g. TypeError or ChunkLoadError.' })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  message: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  stack?: string;

  @ApiPropertyOptional({ description: "Next's digest, present only for a server-rendered error." })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  digest?: string;

  @ApiProperty({ description: 'The page PATH only. The query string is never sent.' })
  @IsString()
  @MaxLength(500)
  path: string;

  @ApiPropertyOptional({ description: 'The build the tab is running (its deployment id).' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  build?: string;

  @ApiPropertyOptional({
    description:
      'When it happened on the device. A report kept on a phone that had no connection is sent on its next page load, so this can be well before the log line.',
  })
  @IsOptional()
  @IsISO8601()
  @MaxLength(40)
  occurredAt?: string;

  @ApiPropertyOptional({
    description: 'Made on the device, once per report, so a report sent twice reads as one.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,64}$/)
  id?: string;
}
