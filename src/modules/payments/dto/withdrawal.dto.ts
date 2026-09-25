import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { transactionStateEnum } from '../../../database/schema';
import { IsNotEmpty, IsNumberString, IsString } from 'class-validator';

// Request + response DTOs for the client-facing payments surface.
// Moved out of payments.controller.ts so the shapes reach /api/docs-json and the
// portal can generate types instead of hand-writing them.

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

/*
 * `RequestWithdrawalOtpDto` and `WithdrawalOtpResponseDto` are GONE with the
 * withdrawal confirmation code — see the note in `payments.controller.ts`.
 * Nothing issues or verifies one, so the shapes described an endpoint that no
 * longer exists.
 */

export class RequestWithdrawalDto {
  /**
   * Money arrives as a STRING and stays one (§6.1) — `@IsNumberString`, never
   * `@IsNumber`, so it is never parsed into a float on the way in.
   */
  @ApiProperty({ type: 'string', example: '300.00000000' })
  @IsNumberString()
  amount: string;

  /*
   * A CODE, validated by the service against the catalogue — the same argument
   * `withdrawalMethodKey` above makes, for the same reason.
   *
   * This was `@IsIn(['USD','USDT'])`, which refused a withdrawal in any currency
   * the operator had added since: EUR, GBP, AED and TRY were all enabled and all
   * unspendable. `CurrenciesService.assertUsable` refuses an unknown code AND a
   * disabled one, against what is actually on offer — a stronger check than a
   * closed list here could make, and one that cannot go stale.
   */
  @ApiProperty({
    description: 'A currency CODE from `GET /currencies`. Validated against the catalogue.',
    example: 'USD',
  })
  @IsString()
  currency: string;

  @ApiProperty({ description: DESTINATION_DESCRIPTION })
  @IsString()
  @IsNotEmpty()
  destination: string;

  @ApiProperty({ description: METHOD_KEY_DESCRIPTION, example: 'whish' })
  @IsString()
  @IsNotEmpty()
  methodKey: string;

  /*
   * The `otp` field is GONE. Nothing verifies a confirmation code any more, so
   * accepting one would be a field the API reads and ignores — and with
   * `whitelist` on the global ValidationPipe, a portal still sending it would
   * have it stripped rather than honoured, which is the confusing half of
   * leaving it in.
   */
}

@NoClientFields(
  'a withdrawal request shape addressed by ids; the desk row that names a person is marked separately',
)
export class TransactionDto {
  @ApiProperty() id: string;
  @ApiProperty() userId: string;
  @ApiProperty() walletId: string;
  @ApiProperty({ enum: DIRECTIONS }) direction: (typeof DIRECTIONS)[number];

  @ApiProperty({ type: 'string', example: '300.00000000', description: 'Decimal string (§6.1).' })
  amount: string;

  @ApiProperty({ description: 'A currency code.', example: 'USD' }) currency: string;
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
   * What to CALL the rail on screen — 'Whish Money', 'Bank transfer'.
   *
   * Resolved server-side so a client and an operator read the same words, and so
   * a renamed method is renamed everywhere at once.
   *
   * ## It covers BOTH directions, and `methodKey` above does not
   *
   * A deposit's name comes from `payment_methods` via `methodKey`; a
   * withdrawal's comes from `withdrawal_payment_methods` via
   * `withdrawal_method_key`, which is a different column into a different table
   * and is NOT exposed on this DTO. So `methodName` is populated on rows where
   * `methodKey` is null, and reading "null wherever `methodKey` is null" — as
   * this comment used to say — is how a screen ends up rendering an empty
   * method on every withdrawal.
   *
   * One field rather than two because the client is asking one question: how
   * did this money move. Null remains for a MANUAL ADMIN CREDIT, which went
   * through no rail at all — `provider` reads `manual_admin` there, and it is
   * the only value a screen should need to recognise by name.
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

  @ApiPropertyOptional({
    description:
      "The payment platform's OWN id for this movement — what Rival shows as its reference, " +
      'and the identifier its team can look up directly. Null for anything that never went ' +
      'through a rail (a manual desk credit) and for a row whose create is still in flight.',
    type: String,
    nullable: true,
  })
  /*
   * ── Why this is on the API at all ──────────────────────────────────────────
   *
   * It was stored from the first day of the Rival integration and exposed
   * NOWHERE: the poller read it, the gateway wrote it, and no response carried
   * it. So the identifier the payment platform can actually key on was
   * invisible to the people who raise tickets about payments — an operator
   * chasing "where is this client's deposit" had our reference and Rival had
   * theirs, and closing that gap meant asking an engineer to run SQL.
   *
   * Both directions of the link now exist in the open:
   *   ours   → `providerRef`        (Rival stores it under a UNIQUE index on
   *                                  (company_id, idempotency_key))
   *   theirs → `rivalExternalId`    (this field)
   *
   * Quote both in a ticket and neither side has to guess which row is meant.
   */
  rivalExternalId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true }) destination?: string | null;
  /*
   * The client's own RECEIPT for an offline deposit — the bare stored filename.
   *
   * On the list so a client can see which image they sent, without a second
   * request per row. It is a NAME, not a URL: the URL is built by the app
   * (`uploads/deposit-proofs/<file>`), and the bytes are still served only
   * through the authenticated route that checks ownership and audits the read.
   * Null on every other movement.
   */
  @ApiPropertyOptional({ type: String, nullable: true }) proofFilename?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) rejectionReason?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reviewedBy?: string | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) reviewedAt?: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) settledAt?: Date | null;
  @ApiProperty() createdAt: Date;

  /**
   * What KIND of movement this is — and the field a screen branches on.
   *
   * A client's history holds deposits, withdrawals, wallet ⇄ trading-account
   * transfers AND a partner's commission transfers. The first two are rows in
   * `transactions`; a transfer is a row in `transfers`, because it has two legs
   * and a bridge confirmation that a payment does not; a commission transfer is
   * a row in `ib_wallet_transfers`. The list endpoint unions all three, because
   * they are one history to the person reading it.
   *
   * ## Do not infer this from the other fields
   *
   * A transfer has no method and no destination — but neither does a manual
   * admin credit, so "methodKey is null" does not identify one. This field does.
   *
   * ## `direction` on either transfer is stated from the WALLET's side
   *
   * `account_to_wallet` brings money into the wallet and therefore reads as
   * `deposit`; `wallet_to_account` reads as `withdrawal`. A `commission_transfer`
   * is always `deposit`, because it credits the main wallet — the commission
   * wallet's matching debit is not a second row here, since that wallet never
   * appears in `GET /wallet` and a withdrawal from an invisible wallet reads as
   * money leaving nowhere. Both legs are still in `/wallet/ledger`.
   *
   * That keeps one meaning for the word across every row in the list. A screen
   * must still not PRINT "Deposit" for a transfer — that is what this field is
   * for, and printing it for a commission transfer would tell a partner their
   * earnings arrived from outside the platform.
   *
   * ## An OPEN set — never switch on it exhaustively without a fallback
   *
   * `commission_transfer` was added after `payment` and `transfer` shipped, and
   * a screen that treated the earlier two as the whole world rendered the new
   * one as a blank row rather than as something unfamiliar.
   */
  /*
   * `rebate` is listed because the CLIENT list returns it (the rebate arm in
   * `movementsCte`); it was missing here, so the generated type told the portal
   * a rebate row could not exist and the screen named it a "Deposit".
   */
  @ApiProperty({
    enum: ['payment', 'transfer', 'commission_transfer', 'rebate'],
    description: 'Branch on this, never on the absence of a payment field.',
  })
  kind: 'payment' | 'transfer' | 'commission_transfer' | 'rebate';

  /**
   * The trading account a TRANSFER moved money to or from. Null on a payment.
   *
   * Distinct from `destinationTradingAccountId`, which is a DEPOSIT routed
   * straight to an account. Both can appear on different rows of one list, and
   * they answer different questions.
   */
  @ApiPropertyOptional({ type: String, nullable: true })
  tradingAccountId?: string | null;
}
