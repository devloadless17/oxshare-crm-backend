import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotClientField, NoClientFields } from '../../../common/security/client-field.decorator';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/* ── SMTP ─────────────────────────────────────────────────────────────────── */

/**
 * The mail configuration as the API reports it.
 *
 * THERE IS NO PASSWORD FIELD, and there must never be one. Whoever controls this
 * relay receives every password-reset and admin-invite link this system sends,
 * which is a full path to an administrator account on a system that approves
 * withdrawals — so the stored value does not leave the server, not even to the
 * master admin who set it.
 *
 * `passwordSet` carries the only part of it the screen needs: whether there is
 * one. That is what lets the form say "leave blank to keep the current password"
 * truthfully instead of showing a fake row of dots that an operator might
 * reasonably believe they can edit.
 */
export class SmtpSettingsDto {
  @NotClientField('a system or configuration value with no client attribute on it at all')
  @ApiProperty({ example: 'smtp.postmarkapp.com' })
  host: string;

  @NotClientField('a system or configuration value with no client attribute on it at all')
  @ApiProperty({ example: 587 })
  port: number;

  @NotClientField('a system or configuration value with no client attribute on it at all')
  @ApiPropertyOptional({ type: String, nullable: true, example: 'apikey' })
  username: string | null;

  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({
    example: true,
    description: 'Whether a password is stored. The password itself is never returned.',
  })
  passwordSet: boolean;

  @NotClientField(
    'the address the PLATFORM sends mail FROM - an SMTP configuration value, not a client attribute',
  )
  @ApiProperty({ example: '"OxShare" <no-reply@oxshare.com>' })
  fromAddress: string;

  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({
    example: false,
    description: 'Implicit TLS on connect (SMTPS). False means STARTTLS.',
  })
  secure: boolean;

  @ApiProperty({
    enum: ['database', 'environment'],
    description:
      'Which configuration is actually in force. "environment" means nothing has been saved ' +
      'here yet and the server is using its boot configuration.',
  })
  @NotClientField(
    'where the setting came from - stored row or environment; a provenance flag, not a person',
  )
  source: 'database' | 'environment';

  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  updatedAt: string | null;
  /**
   * WHO last saved this, resolved from `updated_by`.
   *
   * Every save records the administrator and no screen showed it, so "when did
   * the commission basis / the leverage ladder / the SMTP host change, and who
   * changed it" was answerable only by reading the audit log — for settings
   * that decide what partners are paid and whether mail leaves the building.
   * Null when nothing has been saved here yet, or when the administrator has
   * since been deleted.
   */
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  @ApiPropertyOptional({ type: String, nullable: true })
  updatedByName: string | null;
}

export class UpdateSmtpSettingsDto {
  @ApiProperty({ example: 'smtp.postmarkapp.com', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  host: string;

  @ApiProperty({ example: 587, minimum: 1, maximum: 65535 })
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Null for a relay that takes no credentials.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string | null;

  /**
   * Omit or send null to KEEP the stored password; send a string to replace it;
   * send an empty string to remove it.
   *
   * Three states rather than two, because all three are things an operator
   * actually does, and collapsing "I am not touching this" into "clear it" is
   * how editing a port silently breaks authentication.
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Omit or null keeps the stored password. A string replaces it. An empty string removes it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  password?: string | null;

  /**
   * The `From:` header, verbatim.
   *
   * NOT `@IsEmail`: the field is deliberately the full RFC-5322 form with a
   * display name (`"OxShare" <no-reply@oxshare.com>`), which `@IsEmail` rejects.
   *
   * It is, however, the one value in this system that becomes a mail HEADER
   * with operator-supplied content, and a header ends at a newline. A CR or LF
   * here is how a single `From:` becomes `From:` plus a `Bcc:` of someone
   * else's choosing — header injection, the oldest trick against a mail form.
   * nodemailer encodes address headers and would very likely stop it anyway;
   * this refuses it one layer earlier, where the rule can be read.
   */
  @ApiProperty({ example: '"OxShare" <no-reply@oxshare.com>', maxLength: 320 })
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  @Matches(/^[^\r\n]+$/, {
    message: 'The from address may not contain line breaks.',
  })
  fromAddress: string;

  @ApiProperty({ example: false })
  @IsBoolean()
  secure: boolean;
}

/** What a test send reports back. */
@NoClientFields(
  'operator configuration - platform settings, with the one address on it stated separately',
)
export class SmtpTestResultDto {
  @ApiProperty({ example: 'admin@oxshare.com', description: 'Always the acting admin.' })
  sentTo: string;

  @ApiProperty({
    enum: ['database', 'environment'],
    description: 'Which configuration delivered the message.',
  })
  source: 'database' | 'environment';
}

/*
 * ── NO TRADING SETTINGS DTOs ANY MORE (owner, 7 Oct 2026) ──────────────────
 *
 * `TradingSettingsDto` / `UpdateTradingSettingsDto` backed the Settings →
 * Trading tab. Its two fields went: the demo ceiling was removed outright
 * (0205), and the commission cadence is edited from Scheduled jobs, which
 * writes it through `SettingsService.setCommissionInterval`. With nothing left
 * to save, the tab, its two routes and these DTOs went together.
 */
