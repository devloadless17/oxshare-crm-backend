import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// Request DTOs for API-key management.
//
// Permission keys are validated against config/permissions.json by
// AdminRbacService.assertGrantable, not here: the set is data, and a decorator
// cannot see it. That same call is what stops a key becoming an escalation
// device — an admin cannot mint a key holding permissions they do not hold
// themselves. See api-keys.service.ts.

export class CreateApiKeyDto {
  @ApiProperty({
    example: 'Nightly reporting job',
    description: 'What this key is for. Shown in the key list.',
  })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    type: [String],
    /*
     * ⚠️ `users.view` — the key in this example did not exist.
     *
     * The catalogue names it `clients.view`. A caller copying the published
     * example straight out of Swagger got `Unknown permission key(s):
     * users.view.` from `assertKnownKeys`, which reads as a broken endpoint
     * rather than a wrong sample. An example is documentation that people
     * execute, so a wrong one is worse than none.
     */
    example: ['clients.view', 'withdrawals.view'],
    description:
      'Permission keys from config/permissions.json. An admin may only grant permissions they ' +
      'themselves hold. At least one is required — a key with none can authenticate but do ' +
      'nothing. There is no wildcard: migration 0044 removed `*` along with the master tier, ' +
      'and keys are compared exactly.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  permissions: string[];

  @ApiPropertyOptional({
    example: '2027-01-01T00:00:00.000Z',
    description:
      'ISO 8601. Omit or send null for a key that never expires — stated rather than defaulted, ' +
      'because a key that silently stops working at 3am is worse than one somebody chose to ' +
      'make permanent.',
  })
  @IsISO8601()
  @IsOptional()
  expiresAt?: string | null;
}
