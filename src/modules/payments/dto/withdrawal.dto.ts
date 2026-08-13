import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { transactionStateEnum } from '../../../database/schema';
import { IsIn, IsNotEmpty, IsNumberString, IsOptional, IsString, Matches } from 'class-validator';

// Request + response DTOs for the client-facing payments surface.
// Moved out of payments.controller.ts so the shapes reach /api/docs-json and the
// portal can generate types instead of hand-writing them.

const CURRENCIES = ['USD', 'USDT'] as const;
const DIRECTIONS = ['deposit', 'withdrawal'] as const;

/**
 * The payout rail, as a KEY rather than an enum — migration 0062.
 *
 * This was `@IsIn(['whish', 'usdt'])`. The rails are data now
 * (`withdrawal_payment_methods`), so a closed union here would mean adding a
 * payout method required a deploy, and — worse — that the DTO and the table
 * could disagree about what exists. The service checks the key against the
 * table and refuses anything absent or disabled, which is a stronger check than
 * this layer could make: it validates against what is actually on offer rather
 * than against what the code was compiled knowing about.
 *
 * So the validation here is deliberately only "a non-empty string". The
 * authority is `TransactionsService.requestWithdrawal`.
 */
const METHOD_KEY_DESCRIPTION =
  'A `withdrawal_payment_methods.key` from GET /payments/withdrawal-methods. ' +
  'Rejected if unknown or disabled.';

const DESTINATION_DESCRIPTION =
  'Where the money goes, in the form the chosen method requires. For Whish Money this is the ' +
  "recipient's phone number, validated against Whish's own rules at request time.";

/**
 * DERIVED from the column, not restated.
 *
 * This was written out by hand and said `'failed'` where the database enum says
 * `'failure'` — so the generated type promised both frontends a state the API
 * can never send, and hid the one it does. A portal rendering a `failure` row
 * fell through its own state map to the raw enum value, which is what a client
 * saw when a withdrawal failed at the provider.
 *
 * Nothing rejected the spelling: Swagger emits whatever the array holds and the
 * column is only compared at runtime. Reading `enumValues` means the next state
 * added to the schema reaches both frontends without anybody remembering this
 * file exists.
 */
const STATES = transactionStateEnum.enumValues;

/**
 * The withdrawal a confirmation code is being requested FOR — FR-CORE-08.
 *
 * The same four money fields as the withdrawal itself, because the code is bound
 * to all of them: `withdrawal-otp.service.ts` hashes them into the Redis key, so
 * a code issued against this payload cannot authorise a withdrawal that differs
 * in any of them. That is what stops a code obtained for a small transfer to the
 * client's own account being spent on a large one to somebody else's.
 */
/**
 * One payout rail, as the portal's method picker needs it.
 *
 * Three fields and no more. There is no `enabled` because the endpoint returns
 * only enabled rails — sending a flag the client must then filter on is how a
 * disabled method ends up rendered by the one screen that forgot to check.
 */
export class WithdrawalMethodDto {
  @ApiProperty({ example: 'whish', description: 'Send this back as `methodKey`.' })
  key: string;

  @ApiProperty({ example: 'Whish Money', description: "The operator's own name for the rail." })
  name: string;

  /**
   * Explicitly `type: String, nullable: true` — reflection cannot see through a
   * union, and an unannotated `string | null` generates `Record<string, never>`
   * in the portal's types, making the field unreadable. The same trap
   * `TransactionDto` documents at length.
   *
   * Null is normal: the portal renders a generic wallet mark for a rail with no
   * artwork, so a method is never blocked on a logo.
   */
  @ApiPropertyOptional({ type: String, nullable: true })
  logoUrl?: string | null;
}

export class RequestWithdrawalOtpDto {
  @ApiProperty({ type: 'string', example: '300.00000000' })
  @IsNumberString()
  amount: string;

  @ApiProperty({ enum: CURRENCIES })
  @IsIn(CURRENCIES)
  currency: (typeof CURRENCIES)[number];

  @ApiProperty({ description: DESTINATION_DESCRIPTION })
  @IsString()
  @IsNotEmpty()
  destination: string;

  @ApiProperty({ description: METHOD_KEY_DESCRIPTION, example: 'whish' })
  @IsString()
  @IsNotEmpty()
  methodKey: string;
}

export class RequestWithdrawalDto {
  /**
   * Money arrives as a STRING and stays one (§6.1) — `@IsNumberString`, never
   * `@IsNumber`, so it is never parsed into a float on the way in.
   */
  @ApiProperty({ type: 'string', example: '300.00000000' })
  @IsNumberString()
  amount: string;

  @ApiProperty({ enum: CURRENCIES })
  @IsIn(CURRENCIES)
  currency: (typeof CURRENCIES)[number];

  @ApiProperty({ description: DESTINATION_DESCRIPTION })
  @IsString()
  @IsNotEmpty()
  destination: string;

  @ApiProperty({ description: METHOD_KEY_DESCRIPTION, example: 'whish' })
  @IsString()
  @IsNotEmpty()
  methodKey: string;

  /**
   * The six-digit code from the confirmation email (FR-CORE-08).
   *
   * OPTIONAL in the DTO and REQUIRED by the handler when the control is on. It
   * has to be optional here because the operator can switch the OTP off
   * (security_settings), and a `@IsNotEmpty()` would then refuse every
   * withdrawal for a control that is not in force. The handler decides, so there
   * is exactly one place that knows whether a code is needed.
   */
  @ApiPropertyOptional({
    description: 'Six-digit confirmation code. Required while the withdrawal OTP control is on.',
    example: '482913',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'The confirmation code is six digits.' })
  otp?: string;
}

/**
 * The answer to "send me a code for this withdrawal".
 *
 * `required` is a BOOLEAN rather than something the caller infers from the
 * message, because the operator can switch the OTP control off and the portal
 * has to know which of two things just happened. Reading it out of prose would
 * make a copy edit break the withdrawal flow.
 */
export class WithdrawalOtpResponseDto {
  @ApiProperty({ example: 'A confirmation code has been sent to your email address.' })
  message: string;

  @ApiProperty({
    description:
      'False when the operator has the withdrawal-OTP control switched off; the withdrawal may ' +
      'then be submitted without a code.',
  })
  required: boolean;
}

export class TransactionDto {
  @ApiProperty() id: string;
  @ApiProperty() userId: string;
  @ApiProperty() walletId: string;
  @ApiProperty({ enum: DIRECTIONS }) direction: (typeof DIRECTIONS)[number];

  @ApiProperty({ type: 'string', example: '300.00000000', description: 'Decimal string (§6.1).' })
  amount: string;

  @ApiProperty({ enum: CURRENCIES }) currency: (typeof CURRENCIES)[number];
  @ApiProperty({ enum: STATES }) state: (typeof STATES)[number];

  /**
   * Who or what moved the money — `whish`, `manual_bank_transfer`,
   * `manual_admin`.
   *
   * ## ⚠️ A plain string, and the enum it used to declare was WRONG
   *
   * This said `enum: PROVIDERS`, which is `['whish', 'usdt']`. The column has
   * never held only those: a manual deposit is written as `manual_<methodKey>`
   * (see `requestDeposit`), so the generated type promised both frontends a
   * two-value union while the API sent them `manual_bank_transfer`. A screen
   * that switched on it fell through every case.
   *
   * It is not re-narrowed to a longer list, because the set is OPEN: it grows
   * with every payment method an operator adds, which is data rather than code.
   * `methodKey` below is the field to branch on.
   */
  @ApiPropertyOptional({
    type: String,
    description: 'Open set — never switch on this exhaustively.',
  })
  provider?: string;

  /**
   * The payment method this went through, or null.
   *
   * Null for a withdrawal, and null for a MANUAL ADMIN CREDIT — money an
   * operator placed directly, which went through no method at all. `provider`
   * reads `manual_admin` in that case, and it is the only value a screen should
   * need to recognise by name.
   */
  @ApiPropertyOptional({ type: String, nullable: true })
  methodKey?: string | null;

  /**
   * What to CALL that method on screen — 'Whish Money', 'Bank transfer'.
   *
   * Resolved server-side from `payment_methods.name` so a client and an operator
   * read the same words, and so a renamed method is renamed everywhere at once.
   * Null wherever `methodKey` is null.
   *
   * Deliberately NOT a translated label. It is the operator's own name for their
   * own method — a brand, which does not translate — and inventing an English
   * label here would put copy in the API that the frontends cannot localise.
   * "Manual credit" and the like are the frontends' strings, keyed off
   * `provider === 'manual_admin'`.
   */
  @ApiPropertyOptional({ type: String, nullable: true })
  methodName?: string | null;

  @ApiPropertyOptional({
    description:
      "The provider's own reference. Backs UNIQUE(provider, provider_ref), which is what makes settlement idempotent in the database (§6.3).",
    type: String,
    nullable: true,
  })
  /*
   * Every nullable field below states `type` EXPLICITLY.
   *
   * `@ApiPropertyOptional()` alone reflects the TypeScript type, and reflection
   * cannot see through a union — `string | null` arrives as `Object`, Swagger
   * emits an empty schema, and openapi-typescript generates
   * `Record<string, never>`. The frontend then cannot read the field at all: the
   * portal's transactions screen failed to compile on `tx.rejectionReason`,
   * which is how this was found.
   *
   * `nullable: true` rather than just optional, because these genuinely arrive
   * as null — a pending withdrawal has no providerRef and no settledAt — and a
   * consumer that treats absent and null the same will eventually meet one of
   * them it did not expect.
   */
  providerRef?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true }) destination?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) rejectionReason?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reviewedBy?: string | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) reviewedAt?: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) settledAt?: Date | null;
  @ApiProperty() createdAt: Date;
}
