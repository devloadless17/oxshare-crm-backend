import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { OptionalArabicText } from '../../../../common/dto/arabic-text';

// Request DTOs for the withdrawal lifecycle and IB commission programs.
// See the note in ./auth.dto.ts for why these moved out of the controller.
//
// ARCHITECTURE §6.1 is the reason every monetary and percentage field below is
// `@IsNumberString()` and documented as `type: 'string'`. A JS number cannot hold
// NUMERIC(28,8) — `Number('12345678901234567.89')` is already wrong. The example
// values carry the stored 8dp scale so a consumer of the generated types sees
// the real shape rather than guessing at "12.5".

/** The most an Arabic reason may hold — the English sibling's bound. */
const REASON_AR_MAX = 500;

const PROGRAM_MODES = ['commission', 'rebate', 'hybrid'] as const;
const PROGRAM_METHODS = ['spread_share', 'per_lot', 'fixed_per_deal'] as const;

export class WithdrawalRejectDto {
  @ApiPropertyOptional({ description: 'Free-text reason, when not using a configured reasonId.' })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({ description: 'Id of a configured rejection reason.' })
  @IsString()
  @IsOptional()
  reasonId?: string;

  /**
   * The free-text `reason` in Arabic, for a client reading in Arabic (0179).
   * A configured reason brings its own Arabic; this is the reviewer's note.
   */
  @OptionalArabicText(REASON_AR_MAX, 'بيانات المستفيد غير صحيحة')
  reasonAr?: string | null;
}

/**
 * Why a stuck transfer is being released.
 *
 * REQUIRED, and not for tidiness. This operation states that a movement did NOT
 * happen, on evidence the system cannot see — somebody read MT5's own record.
 * The reason is the only place that evidence is written down, it reaches the
 * CLIENT on the failed row, and it is what a later dispute is settled from.
 *
 * Long enough for a real sentence: "checked deal history on 6480824, the 1,000
 * never arrived" is the useful form, and a 500-character bound is generous for
 * it while stopping a paste of a stack trace.
 */
export class AbandonTransferDto {
  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example: 'Checked MT5 deal history for 6480824 — the 1,000 never reached the account.',
    description:
      'What the broker’s record showed. Reaches the client on the failed transfer, and is the ' +
      'audit trail for a decision nothing in this system could make on its own.',
  })
  @IsString()
  @Length(10, 500)
  reason: string;

  /** `reason` in Arabic — the client reads it on the failed transfer (0179). Optional. */
  @OptionalArabicText(REASON_AR_MAX, 'راجعنا سجل الصفقات في MT5 — لم يصل المبلغ إلى الحساب.')
  reasonAr?: string | null;
}

export class ResolveAttentionDto {
  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example:
      'Checked the platform dashboard — the reversal was a duplicate; client credited correctly.',
    description:
      'What the reconciliation found. The audit record of a decision the system could not make ' +
      'on its own — the same weight as releasing a stuck transfer.',
  })
  @IsString()
  @Length(10, 500)
  note: string;
}

/**
 * FINISH A FLAGGED HOSTED DEPOSIT (0173): credit what the provider reported
 * arrived, or close it with no credit. Either way the reason is the audit
 * record of a decision the system could not make on its own.
 */
export class FinishFlaggedDepositDto {
  @ApiProperty({ enum: ['credit', 'close'] })
  @IsIn(['credit', 'close'])
  decision: 'credit' | 'close';

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    example: 'Confirmed on the provider dashboard: 90 USDT arrived on the 100 link.',
  })
  @IsString()
  @Length(1, 500)
  reason: string;
}

/** A person finishes a flagged provider payout (0174). */
export class FinishFlaggedPayoutDto {
  @ApiProperty({ enum: ['paid', 'refund'] })
  @IsIn(['paid', 'refund'])
  decision: 'paid' | 'refund';

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    example: 'The provider force-routed it to our cold wallet; paid the client from it.',
  })
  @IsString()
  @Length(1, 500)
  reason: string;

  @ApiPropertyOptional({
    maxLength: 128,
    description: 'Required to mark it paid: the reference of the payment that reached the client.',
    example: '4839cb944414ae2559c327…',
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  reference?: string;
}

export class SettleWithdrawalDto {
  /**
   * The payment provider's own reference. Backs `UNIQUE(provider, provider_ref)`,
   * which is what makes settlement idempotent in the database rather than by a
   * check-then-insert (§6.3) — so a retried settle cannot pay twice.
   */
  @ApiProperty({ example: 'wise-tx-9f3a1c' })
  @IsString()
  providerRef: string;
}

/**
 * Money an operator puts into a client's wallet by hand.
 *
 * The counterpart to the withdrawal lifecycle above: this is the only way funds
 * can ARRIVE without a payment provider, and until it existed a manual deposit
 * sat `pending` for ever because nothing could confirm it.
 */
export class CreditWalletDto {
  @ApiProperty({ type: 'integer', description: 'The client to credit.' })
  @IsInt()
  @Min(1)
  userId: number;

  /**
   * A positive decimal string, at most eight places — §6.1.
   *
   * `@IsNumberString` and not `@IsNumber`, for the reason at the top of this
   * file: a JS number cannot hold a NUMERIC(28,8) without losing the tail, and
   * this value is credited to somebody's balance verbatim.
   *
   * The PATTERN is what makes it positive. `@IsNumberString` alone accepts
   * `'-500'`, which would turn a credit into a debit through a route that has no
   * refusal path for one — the ledger would post a negative deposit while the
   * client's email announced that funds had been added.
   */
  @ApiProperty({ type: 'string', example: '250.00000000' })
  @IsNumberString()
  @Matches(/^\d{1,20}(\.\d{1,8})?$/, {
    message: 'amount must be a positive decimal string with at most 8 decimal places',
  })
  amount: string;

  @ApiProperty({ example: 'USD', description: 'Must be a currency the platform holds.' })
  @IsString()
  @Length(1, 10)
  currency: string;

  /**
   * WHY, and it is required.
   *
   * An unexplained credit cannot be audited or defended: "why is there an extra
   * $500 on this account" has to be answerable from the record rather than from
   * whoever remembers. It is written to the audit entry AND shown to the client
   * in the mail announcing the credit, so two audiences read it and both need it
   * to stand on its own.
   */
  @ApiProperty({ example: 'Goodwill adjustment for the failed 4 August transfer.', maxLength: 500 })
  @IsString()
  @Length(3, 500)
  reason: string;

  /**
   * `reason` in Arabic (0179): the client's credit email and bell show it to a
   * client reading in Arabic. Optional — without it they read the English.
   */
  @OptionalArabicText(REASON_AR_MAX, 'تسوية تعويضية عن تحويل 4 أغسطس الذي لم يكتمل.')
  reasonAr?: string | null;
}

/**
 * Money an operator takes OUT of a client's wallet by hand (7 Oct 2026) — it
 * leaves the platform as a completed manual withdrawal. The same fields as a
 * credit, for the same reasons.
 */
export class DebitWalletDto extends CreditWalletDto {}

/**
 * Money an operator puts onto a client's TRADING ACCOUNT by hand.
 *
 * ## No `currency`, unlike `CreditWalletDto` above
 *
 * The account is denominated in one, and the wallet leg has to match it —
 * transfers do not convert (there is no FX rate source anywhere in this
 * system). Taking a currency from the caller would let a request name an
 * account in one and a wallet in another, and the only two ways to resolve that
 * are inventing a rate or moving the number across unchanged and calling
 * 100 USD "100 USDT". So the account decides, and the caller cannot disagree.
 *
 * ## No `userId` either
 *
 * The account id implies its owner. Accepting both would let them disagree, and
 * the reconciliation for "funded the right account for the wrong client" is a
 * conversation rather than an edit.
 */
export class FundTradingAccountDto {
  /**
   * A positive decimal string, at most eight places — §6.1, and the same
   * pattern `CreditWalletDto` applies for the same reason: `@IsNumberString`
   * alone accepts `'-500'`, which would turn a deposit into a debit through a
   * route with no refusal path for one.
   */
  @ApiProperty({ type: 'string', example: '250.00000000' })
  @IsNumberString()
  @Matches(/^\d{1,20}(\.\d{1,8})?$/, {
    message: 'amount must be a positive decimal string with at most 8 decimal places',
  })
  amount: string;

  /**
   * WHY, and it is required — the same rule as a wallet credit.
   *
   * This mints balance from nothing before moving it on, so "why is there an
   * extra $500 on this account" has to be answerable from the record six months
   * later. It goes on the audit entry and into the client's credit email.
   */
  @ApiProperty({ example: 'Funding the 4 August wire that arrived off-rail.', maxLength: 500 })
  @IsString()
  @Length(3, 500)
  reason: string;

  /** `reason` in Arabic (0179) — it reaches a deposit's credit email and bell. Optional. */
  @OptionalArabicText(REASON_AR_MAX, 'تمويل الحوالة الواردة في 4 أغسطس.')
  reasonAr?: string | null;

  /**
   * WHICH WAY, and the amount above stays unsigned.
   *
   * The same rule the removed `Mt5BalanceDto` applied, for the same reason: an amount and
   * a direction that can disagree is a withdrawal that becomes a deposit,
   * silently, in the one place that is least recoverable. The sign is derived
   * from this field, once, in the service.
   *
   * `deposit` credits the wallet and transfers to the account; `withdraw`
   * transfers off the account into the wallet. It is NOT a payout — no money
   * leaves the platform on either one.
   */
  @ApiProperty({ enum: ['deposit', 'withdraw'], example: 'deposit' })
  @IsIn(['deposit', 'withdraw'])
  direction: 'deposit' | 'withdraw';

  /**
   * Where the money comes from or goes to (owner, 7 Oct 2026). Deposit:
   * `system` (default) is new money, credited to the wallet and moved on;
   * `wallet` moves money the client already holds. Withdraw: `wallet`
   * (default) lands it in the wallet; `system` then takes it off the platform
   * as a completed manual withdrawal (`wallets.debit`).
   */
  @ApiPropertyOptional({ enum: ['system', 'wallet'], example: 'system' })
  @IsOptional()
  @IsIn(['system', 'wallet'])
  source?: 'system' | 'wallet';
}

/**
 * Open a wallet for a client in a currency they do not hold one in.
 *
 * No amount: this creates an empty container. Funding it is `CreditWalletDto`
 * above, behind a different permission, precisely so the two are separate
 * decisions.
 */
export class OpenWalletDto {
  @ApiProperty({ type: 'integer' })
  @IsInt()
  @Min(1)
  userId: number;

  @ApiProperty({
    example: 'USD',
    description: 'Must be a currency the platform holds and has enabled.',
  })
  @IsString()
  @Length(1, 10)
  currency: string;
}

export class ProgramDto {
  @ApiProperty({ example: 'Standard IB' })
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Display order in the plan list.' })
  @IsInt()
  @IsOptional()
  position?: number;

  @ApiProperty({ enum: PROGRAM_MODES })
  @IsIn(PROGRAM_MODES)
  mode: (typeof PROGRAM_MODES)[number];

  @ApiProperty({ enum: PROGRAM_METHODS })
  @IsIn(PROGRAM_METHODS)
  method: (typeof PROGRAM_METHODS)[number];

  @ApiProperty({
    type: 'string',
    example: '12.50000000',
    description: 'Money/percent as a decimal string (§6.1) — never a number.',
  })
  @IsNumberString()
  commissionValue: string;

  @ApiPropertyOptional({ type: 'string', example: '2.00000000' })
  @IsNumberString()
  @IsOptional()
  rebateValue?: string;

  @ApiProperty({
    type: 'string',
    example: '70.00000000',
    description: 'Level-1 IB share, percent as a decimal string.',
  })
  @IsNumberString()
  l1Share: string;

  @ApiProperty({
    type: 'string',
    example: '30.00000000',
    description: 'Level-2 IB share. Resolution stops at L2 — there is no L3.',
  })
  @IsNumberString()
  l2Share: string;

  @ApiPropertyOptional({
    description: 'Hours an accrual is held before it can be confirmed.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  settlementWindowHours?: number;

  @ApiPropertyOptional({ description: 'Pay the rebate on position close rather than on open.' })
  @IsBoolean()
  @IsOptional()
  rebateOnClose?: boolean;

  @ApiPropertyOptional({ description: 'Offer this plan to IBs for self-selection.' })
  @IsBoolean()
  @IsOptional()
  selectable?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  active?: boolean;
}

export class ProgramActiveDto {
  @ApiProperty()
  @IsBoolean()
  active: boolean;
}

/**
 * Refusing an offline deposit.
 *
 * The same two optional fields as `WithdrawalRejectDto`, as its own class so the
 * API documentation does not show a withdrawal type on a deposit route. The
 * "at least one of them" rule lives in the service, exactly as it does for
 * withdrawals — it is a rule about the pair, which class-validator cannot state
 * on either field alone.
 */
export class DepositRejectDto {
  @ApiPropertyOptional({
    description: 'Free-text note, used alone or appended to the configured reason.',
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({
    description: 'A configured rejection reason from the `deposit` context.',
  })
  @IsUUID()
  @IsOptional()
  reasonId?: string;

  /** The free-text `reason` in Arabic, for a client reading in Arabic (0179). */
  @OptionalArabicText(REASON_AR_MAX, 'لم يصل المبلغ بعد إلى حسابنا')
  reasonAr?: string | null;
}
