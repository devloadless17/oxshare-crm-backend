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

  /**
   * The second bound (0106), and the one the catalogue cannot state about
   * itself: a programme knows what IT pays, only this knows what a CHAIN of
   * them costs on a single trade.
   *
   * A STRING, like every rate this system carries. It multiplies the broker's
   * revenue, and §6 keeps anything that touches an amount out of a float —
   * `@ApiProperty({ type: 'string' })` so the generated frontend type agrees.
   */
  @ApiProperty({
    type: 'string',
    example: '100.0000',
    description:
      'The most one trade may pay out in total, as a % of the broker’s revenue on it — every ' +
      'commission leg plus the client’s rebate. Defaults to 100, which refuses only a chain ' +
      'costing more than the trade earned. A chain over the ceiling is REFUSED and retried, ' +
      'never silently scaled down.',
  })
  ibMaxTotalPayoutPct: string;

  @ApiProperty({
    type: 'string',
    example: '50.00000000',
    description:
      'The most ONE TRADE may pay out per standard lot, across every per-lot leg including the ' +
      'client rebate. The unit-error backstop for per-lot terms — the percentage ceiling beside ' +
      'it cannot bound them, because a per-lot payout is not a share of revenue. Refuses rather ' +
      'than scales: the deal defers and pays in full once the terms are corrected.',
  })
  ibMaxPayoutPerLot: string;

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
  @ApiPropertyOptional({ type: String, nullable: true })
  updatedByName: string | null;
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

  /**
   * The total payout ceiling, as a decimal percentage string (0106).
   *
   * A STRING and validated by REGEX, not `@IsNumber()`. It reaches the money
   * path and is multiplied by the broker's revenue, so §6.1 keeps it out of a
   * float — and a numeric validator would accept `1e2` and `0x64` on the way
   * in, which `parseInt` then reads as 1.
   *
   * `> 0`, not `>= 0`: a ceiling of zero refuses every chain on the platform,
   * which is a way to stop paying every partner by typing a number into a form.
   * Turning terms off is what a programme's `enabled` flag is for, and it says
   * so on the screen.
   *
   * REQUIRED, like every other field here — this is a PUT, so the whole form
   * travels together and an omitted value is a malformed request rather than an
   * unchanged setting.
   *
   * The decorator checks FORMAT only. The RANGE is checked in
   * `SettingsService.setTrading`, which is where this codebase puts a rule that
   * needs a `DomainError` with a code — and `@Min`/`@Max` cannot read a string
   * anyway without coercing it, which §6.1 forbids on the money path.
   */
  @ApiProperty({ type: 'string', example: '100.0000' })
  @Matches(/^\d+(\.\d+)?$/, {
    message: 'ibMaxTotalPayoutPct must be a decimal number, for example "70" or "62.5000"',
  })
  ibMaxTotalPayoutPct: string;

  @ApiProperty({
    type: 'string',
    example: '50.00000000',
    description:
      'The most one trade may pay out per standard lot. A unit-error guard rather than a ' +
      'commercial limit — the industry runs at a few dollars to low double digits a lot, so a ' +
      'sane value sits far above any real rate card and refuses only a mistyped one.',
  })
  @Matches(/^\d+(\.\d+)?$/, {
    message: 'ibMaxPayoutPerLot must be a decimal number, for example "50" or "12.50000000"',
  })
  ibMaxPayoutPerLot: string;
}
