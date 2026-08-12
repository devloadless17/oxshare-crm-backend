import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The Rival connection as the API reports it.
 *
 * NO API KEY FIELD AND NO WEBHOOK KEY FIELD, and there must never be either.
 * The API key can create payouts against the company's balance at Rival; the
 * webhook key authenticates the money-event stream. `apiKeySet` and
 * `webhookKeyFingerprint` carry the only parts a screen needs: whether one
 * exists, and which one.
 */
export class RivalSettingsDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://portal.rivalpayments.com/v1',
    description: 'Rival API base, including the /v1 prefix. Null when unconfigured.',
  })
  baseUrl: string | null;

  @ApiProperty({ description: 'Whether an API key is stored. The key itself is never returned.' })
  apiKeySet: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '3fa1b2c4',
    description:
      'sha256[:8] of the webhook key — identifies WHICH key without carrying it. Null until ' +
      'one is generated.',
  })
  webhookKeyFingerprint: string | null;

  @ApiProperty({ description: 'Whether deposits and payouts route through Rival.' })
  enabled: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'When the last VERIFIED webhook arrived — the pipe-liveness signal. Null when none ever has.',
  })
  lastEventAt: string | null;

  @ApiProperty({
    enum: ['database', 'environment', 'unconfigured'],
    description:
      '"environment" until the first save; the values shown are then the boot configuration ' +
      'rather than a blank form.',
  })
  source: 'database' | 'environment' | 'unconfigured';

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://api.oxshare.com/v1/payments/rival/webhook',
    description:
      'The URL to paste into Rival (dashboard → CRM config). Built from API_PUBLIC_URL; null ' +
      'when that is unset.',
  })
  webhookEndpoint: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  updatedAt: string | null;
}

export class UpdateRivalSettingsDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://portal.rivalpayments.com/v1',
    description: 'https:// required (http://localhost allowed for development). Null clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  baseUrl?: string | null;

  /*
   * Three-state, exactly like the SMTP password: omit or null keeps the stored
   * key, an empty string removes it, a string replaces it. The middle state is
   * why this is not `@IsString()` alone — an operator toggling `enabled` must
   * not wipe a working credential.
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Omit or null to keep the stored key, a string to replace it, an empty string to remove ' +
      'it. Encrypted at rest and never read back.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  apiKey?: string | null;

  @ApiProperty({ description: 'Whether deposits and payouts route through Rival.' })
  @IsBoolean()
  enabled: boolean;
}

/**
 * The ONE response that ever carries the webhook key. It is minted
 * server-side, shown here, and not retrievable afterwards — only its
 * fingerprint survives.
 */
export class RivalWebhookKeyDto {
  @ApiProperty({
    description:
      'The freshly minted key, in plaintext, exactly once. Paste it into Rival (dashboard → ' +
      'CRM config) together with the endpoint below.',
  })
  webhookKey: string;

  @ApiProperty({ example: '3fa1b2c4', description: 'sha256[:8], for later identification.' })
  fingerprint: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://api.oxshare.com/v1/payments/rival/webhook',
  })
  endpoint: string | null;
}

class RivalCrmConfigView {
  @ApiPropertyOptional({ type: String, nullable: true })
  apiUrl: string | null;

  @ApiProperty()
  hasApiKey: boolean;

  @ApiProperty()
  enabled: boolean;
}

/**
 * The test-connection result: our key worked, and this is what Rival believes
 * our webhook configuration to be — rendered beside what we minted, so a
 * mismatch between the two sides is visible on one screen.
 */
export class RivalTestResultDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty({ type: RivalCrmConfigView })
  rivalCrmConfig: RivalCrmConfigView;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The webhook URL Rival SHOULD be configured with (from API_PUBLIC_URL).',
  })
  expectedApiUrl: string | null;
}
