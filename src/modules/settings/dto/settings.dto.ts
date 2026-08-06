import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/* ── General ──────────────────────────────────────────────────────────────── */

export class GeneralSettingsDto {
  @ApiProperty({ example: 'OxShare', description: 'Shown in the portal header.' })
  brandName: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Where clients are told to write. Null when unset.',
    example: 'support@oxshare.com',
  })
  supportEmail: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Help centre or ticket portal. Null when unset.',
    example: 'https://help.oxshare.com',
  })
  supportUrl: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Shown to clients during planned downtime. Null shows nothing.',
  })
  maintenanceNotice: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  updatedAt: string | null;
}

export class UpdateGeneralSettingsDto {
  @ApiProperty({ example: 'OxShare', minLength: 1, maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  brandName: string;

  /*
   * Nullable rather than merely optional, and the distinction is the contract:
   * `null` CLEARS the value and an absent key would be ambiguous with it. Same
   * reasoning as the empty-string-clears rule on platform links — an operator
   * removing a support address should not have to find a separate control.
   */
  @ApiPropertyOptional({ type: String, nullable: true, example: 'support@oxshare.com' })
  @IsOptional()
  @IsEmail({}, { message: 'supportEmail must be a valid email address, or null to clear it.' })
  @MaxLength(320)
  supportEmail?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'https://help.oxshare.com' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  supportUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  maintenanceNotice?: string | null;
}

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
  @ApiProperty({ example: 'smtp.postmarkapp.com' })
  host: string;

  @ApiProperty({ example: 587 })
  port: number;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'apikey' })
  username: string | null;

  @ApiProperty({
    example: true,
    description: 'Whether a password is stored. The password itself is never returned.',
  })
  passwordSet: boolean;

  @ApiProperty({ example: '"OxShare" <no-reply@oxshare.com>' })
  fromAddress: string;

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
  source: 'database' | 'environment';

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  updatedAt: string | null;
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

  @ApiProperty({ example: '"OxShare" <no-reply@oxshare.com>', maxLength: 320 })
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  fromAddress: string;

  @ApiProperty({ example: false })
  @IsBoolean()
  secure: boolean;
}

/** What a test send reports back. */
export class SmtpTestResultDto {
  @ApiProperty({ example: 'admin@oxshare.com', description: 'Always the acting admin.' })
  sentTo: string;

  @ApiProperty({
    enum: ['database', 'environment'],
    description: 'Which configuration delivered the message.',
  })
  source: 'database' | 'environment';
}
