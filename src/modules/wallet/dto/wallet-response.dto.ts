import { ApiProperty } from '@nestjs/swagger';

// Response DTOs for the client-facing wallet endpoints.
//
// These exist because `WalletController` carried no @ApiOkResponse, so
// `operations['WalletController_myWallets']` generated as `content?: never` and
// the client portal had nothing to alias. It hand-wrote the shapes instead — and
// got `GET /wallet/ledger` wrong, declaring a bare array where the endpoint
// actually returns the paginated envelope below. That is the drift these DTOs
// remove (API-CONTRACTS Part C).
//
// Every monetary field is `type: 'string'` on purpose (ARCHITECTURE §6.1):
// NUMERIC(28,8) does not survive a JS number, so money crosses this boundary as a
// decimal string and the generated TypeScript must say `string`.

/*
 * ── `currency` IS A CODE, NOT AN ENUM ────────────────────────────────────────
 *
 * This declared `enum: ['USD', 'USDT']`, which reintroduced the very thing the
 * schema deliberately removed: currencies were a `pgEnum` once, and that made
 * "what money can this platform hold" a deploy. They are a TABLE now — see the
 * note on `currencies` in schema.ts — and an operator adds one from the admin
 * screen.
 *
 * The cost was not theoretical. The portal aliased the generated union as
 * `WalletCurrency`, its wallet carousel typed its entries by it, and a client
 * holding six wallets could only ever be shown two — the dashboard counted six
 * from the same endpoint, so the two screens disagreed about the same client.
 *
 * A plain string, described by where the valid values come from. The foreign
 * key on `wallets.currency` is what actually constrains it, and
 * `CurrenciesService.assertUsable` is what refuses an unknown or disabled one
 * on every write path.
 */
export class WalletDto {
  @ApiProperty() id: string;
  @ApiProperty() userId: string;
  @ApiProperty({
    description:
      'A currency CODE from `GET /currencies`, not a fixed set — currencies are operator data.',
    example: 'USD',
  })
  currency: string;

  /**
   * WHAT this wallet is for — `main` or `commission`.
   *
   * ## `GET /wallet` only ever returns `main`, so why send it at all
   *
   * Because this DTO is ALSO what `GET /ib/overview` returns commission wallets
   * as, and a screen holding both lists must not have to remember which array
   * it took a card from. The field travels with the wallet rather than with the
   * request that fetched it, so a card rendered from either list can label
   * itself and cannot be mislabelled by being passed to the wrong component.
   *
   * A client who is not a partner sees only `main` and can ignore this.
   */
  @ApiProperty({
    enum: ['main', 'commission'],
    description:
      "`GET /wallet` returns `main` only — a commission wallet is a partner's earnings and " +
      'appears solely on GET /ib/overview. It cannot be deposited to, withdrawn from, or moved ' +
      'to a trading account; POST /ib/wallet/transfer moves it into the main wallet first.',
  })
  kind: 'main' | 'commission';

  @ApiProperty({ type: 'string', example: '700.00000000', description: 'Decimal string (§6.1).' })
  balance: string;

  @ApiProperty({
    type: 'string',
    example: '0.00000000',
    description: 'Reserved against pending withdrawals.',
  })
  onHold: string;

  @ApiProperty({
    type: 'string',
    example: '700.00000000',
    description: 'balance − onHold, computed server-side so both sides agree.',
  })
  available: string;

  @ApiProperty() createdAt: Date;
}

/**
 * A single append-only ledger row.
 *
 * Defined here, in the module that owns the ledger, and re-exported by
 * modules/admin/dto/responses.dto.ts for the ADM-13 admin view — admin already
 * depends on wallet (WalletModule, WalletService), so this is the correct
 * direction. It was briefly declared in both places, which is a silent schema
 * collision: Swagger keys by class name and one definition overwrites the other.
 */
export class LedgerEntryDto {
  @ApiProperty() id: string;
  @ApiProperty() walletId: string;
  @ApiProperty() userId: string;
  @ApiProperty({ description: 'Signed monetary value as a string' })
  amount: string;
  @ApiProperty({ description: 'Running balance after this entry, as a string' })
  balanceAfter: string;
  @ApiProperty({
    enum: ['deposit', 'withdrawal', 'commission', 'rebate', 'payout', 'adjustment'],
  })
  entryType: string;
  @ApiProperty() referenceType: string;
  @ApiProperty() referenceId: string;
  @ApiProperty({ description: 'A currency code — see WalletDto.', example: 'USD' })
  currency: string;
  @ApiProperty() createdAt: Date;
}

/**
 * `GET /wallet/ledger` and `GET /admin/ledger` are paginated, unlike
 * `GET /wallet` which returns a bare array. The portal hand-wrote the client
 * ledger call as returning a bare array, which this makes impossible.
 */
export class LedgerListResponseDto {
  @ApiProperty({ type: [LedgerEntryDto] }) items: LedgerEntryDto[];
  /**
   * Pass back as `?cursor=` for the next page; `null` on the last (R-2.4).
   *
   * The ledger is append-only and never stops growing, so it reaches the depth
   * where OFFSET hurts before any other list — and it is the one used FOR
   * reconciliation, where a silently skipped entry means balancing against the
   * wrong set of rows.
   */
  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;

  @ApiProperty({ description: 'Total matching entries, ignoring pagination.' }) total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}
