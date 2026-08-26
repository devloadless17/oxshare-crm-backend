import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

/* ── Trading ──────────────────────────────────────────────────────────────── */

export class TradingSettingsDto {
  /*
   * `leverages` was here. The ladder is its own resource now — `GET
   * /admin/leverages` — because a rung needs to be withdrawn without touching
   * the accounts opened on it, and a list on this response had nowhere to say
   * so. See migration 0067.
   */
  @ApiProperty({ example: 5, description: 'Live accounts one client may open themselves.' })
  maxLiveAccounts: number;

  @ApiProperty({ example: 5, description: 'Demo accounts one client may open themselves.' })
  maxDemoAccounts: number;

  @ApiProperty({
    example: '1000000.00000000',
    description: 'Largest opening balance a demo account may be given. A decimal string.',
  })
  maxDemoDeposit: string;

  /*
   * The IB block is GONE from this response (0104): the settlement window, the
   * accrual start, the revenue basis and the broker cap.
   *
   * Commission is configured on the Commission Programmes page. A control on
   * the Trading settings screen that also changes what every partner earns is a
   * second place to look when a payout surprises somebody — the same "two
   * places" problem 0102 removed from the catalogue itself.
   *
   * The window and the accrual start read `IB_COMMISSION_HOLD_HOURS` and
   * `IB_ACCRUAL_START` from the environment, which is where both began.
   *
   * ONE IB number is here (0105), and it is a different kind of thing: it
   * BOUNDS what the Commission Programmes page will accept rather than deciding
   * what anybody is paid.
   */
  @ApiProperty({
    example: 2,
    minimum: 1,
    maximum: 10,
    description:
      'How many levels a commission programme’s ladder may reach. Defaults to 2 — the committed ' +
      'two-level structure (Feature List Rev 9, IB-17). Bounds what may be SAVED: lowering it ' +
      'leaves existing programmes paying exactly what they paid before.',
  })
  ibMaxLevels: number;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' })
  updatedAt: string | null;
}

export class UpdateTradingSettingsDto {
  /**
   * The ladder as the operator types it: `50,100,200,500`.
   *
   * A STRING rather than `number[]`, because this is a text box and the round
   * trip should return what they typed. The service parses it and rejects a
   * malformed one with a message naming the offending value — a silently
   * dropped entry would remove a leverage from the offer with no trace.
   */
  /*
   * ZERO IS ALLOWED and means "no new ones of this kind". It is not the same as
   * switching self-service off, which is done by offering no groups: this stops
   * new accounts while leaving existing ones tradeable.
   *
   * The ceiling is 100 rather than unbounded — an uncapped demo endpoint is a
   * free account generator on the broker's own server, and "unlimited" is the
   * value somebody picks when they have not thought about that.
   */
  @ApiProperty({ example: 5, minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  maxLiveAccounts: number;

  @ApiProperty({ example: 5, minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  maxDemoAccounts: number;

  /** A decimal string, never a number — §6. */
  @ApiProperty({ example: '1000000.00', description: 'Positive decimal string.' })
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'maxDemoDeposit must be a positive decimal with up to 2 places',
  })
  maxDemoDeposit: string;

  /**
   * The ladder ceiling — how many levels a commission programme may reach.
   *
   * REQUIRED, like every other field on this form: it is a PUT, so the whole
   * form travels together and an omitted value is a malformed request rather
   * than an unchanged setting.
   *
   * 1 to 10. The upper bound is the DATABASE's — `ib_program_tiers_depth_range`
   * and `ib_accruals_depth_range` both stop there — so a higher ceiling would
   * let an operator configure a ladder whose deepest level fails at INSERT, on
   * the money path, taking every earner on that trade down with it.
   *
   * No zero, unlike the account caps beside it. There, 0 means "stop opening
   * new ones" and is a state somebody may want; here it would make every
   * commission-paying programme unsaveable, which is not a decision anybody is
   * trying to express.
   */
  @ApiProperty({ example: 2, minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  ibMaxLevels: number;
}
