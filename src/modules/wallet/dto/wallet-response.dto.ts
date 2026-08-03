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

const CURRENCIES = ['USD', 'USDT'] as const;

export class WalletDto {
  @ApiProperty() id: string;
  @ApiProperty() userId: string;
  @ApiProperty({ enum: CURRENCIES }) currency: (typeof CURRENCIES)[number];

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
  @ApiProperty({ enum: ['USD', 'USDT'] }) currency: string;
  @ApiProperty() createdAt: Date;
}

/**
 * `GET /wallet/ledger` and `GET /admin/ledger` are paginated, unlike
 * `GET /wallet` which returns a bare array. The portal hand-wrote the client
 * ledger call as returning a bare array, which this makes impossible.
 */
export class LedgerListResponseDto {
  @ApiProperty({ type: [LedgerEntryDto] }) items: LedgerEntryDto[];
  @ApiProperty({ description: 'Total matching entries, ignoring pagination.' }) total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}
