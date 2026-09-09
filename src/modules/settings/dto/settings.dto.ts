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

/* ── Trading ──────────────────────────────────────────────────────────────── */

@NoClientFields(
  'operator configuration - platform settings, with the one address on it stated separately',
)
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
   * `ibMaxLevels` is GONE from this response (0113) — see the write DTO below.
   * The column survives as the record of what a deployment had configured, and
   * a number a screen can read but not change is one somebody eventually asks
   * why they cannot edit.
   */

  /**
   * How often commission is paid, in seconds — maturation and payout period.
   */
  @ApiProperty({
    example: 3600,
    minimum: 60,
    description:
      'Seconds between commission payouts, and how long an accrual matures first. 60 credits a ' +
      'partner about a minute after the trade closes.',
  })
  ibCommissionIntervalSeconds: number;

  /*
   * ── THE TWO PAYOUT CEILINGS ARE NOT REPORTED HERE (0112) ─────────────────
   *
   * `ib_max_total_payout_pct` and `ib_max_payout_per_lot` are still stored and
   * still enforced on every accrual — they are the unit-error backstop that
   * stops a rate meaning 70x rather than 70% accruing seventy times the
   * revenue. What went is the CONTROL, on an explicit instruction.
   *
   * They are dropped from the RESPONSE as well as the request, because a
   * number a screen can read and not change is a number somebody eventually
   * asks why they cannot edit.
   */

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

  /*
   * ── `ibMaxLevels` IS NOT ON THIS FORM ANY MORE (0113) ────────────────────
   *
   * It capped how deep the ladder could go, so adding a third rung meant first
   * raising a number on a different screen. The IB Levels page is the only
   * thing that decides depth now — add a rung and it pays.
   *
   * The column is kept as the record of what was configured and nothing writes
   * it, which is why it is absent here rather than sent as a constant: a PUT
   * that never mentions a column leaves it alone.
   */

  /**
   * How often commission is paid, in SECONDS — the maturation delay and the
   * payout period at once.
   *
   * ⚠️ A SHORT INTERVAL REMOVES A SAFETY MARGIN. The 24-hour hold this
   * replaces existed so a bad deposit is caught by the desk's daily rhythm
   * BEFORE the commission on it is spendable. At 60s a partner is credited
   * before anybody could review the trade behind it, and a reversal then has to
   * claw back a balance they may already have moved.
   *
   * Floored at 60 rather than 1 for a mechanical reason, not a commercial one:
   * below a minute the payout run has not finished draining before its next
   * tick, and stacked runs contend for the same rows. No upper bound — a broker
   * paying monthly is a decision, not a fault.
   */
  @ApiProperty({
    example: 3600,
    minimum: 60,
    description:
      'Seconds between commission payouts, and how long an accrual matures before it is payable. ' +
      'One number for both: either alone leaves the other as the real delay. 60 = a partner is ' +
      'credited about a minute after the trade closes.',
  })
  @IsInt()
  @Min(60)
  ibCommissionIntervalSeconds: number;

  /*
   * ── THE TWO PAYOUT CEILINGS ARE NOT ON THIS FORM (0112) ──────────────────
   *
   * `ibMaxTotalPayoutPct` and `ibMaxPayoutPerLot` were fields here until they
   * were removed from the settings screen on an explicit instruction. Both are
   * still STORED and still ENFORCED: they are the ceiling `checkPlausible`
   * reads on every accrual, and without them a rate meaning 70x rather than
   * 70% would accrue seventy times the revenue before anything objected.
   *
   * Their absence from a PUT therefore leaves the stored values alone — which
   * is the behaviour a removed field must have on a full-replace endpoint, and
   * why the service omits the columns rather than writing a constant into
   * them. The defaults are 100% and $50 a lot, both far above any real rate
   * card, so a deployment that never set them is bounded anyway.
   */
}
