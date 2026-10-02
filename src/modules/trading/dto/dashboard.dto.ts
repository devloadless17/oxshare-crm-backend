import { ApiProperty } from '@nestjs/swagger';
import { WalletDto } from '../../wallet/dto/wallet-response.dto';
// `TransactionDto` lives in withdrawal.dto.ts — it is the shared shape for every
// row in `transactions`, deposits included, and has never had a file of its own.
import { TransactionDto } from '../../payments/dto/withdrawal.dto';
import { TradingAccountDto } from './trading-account.dto';

/**
 * Counts a client's landing page states from, in one place.
 *
 * Every figure here is a COUNT of rows that exist, never a derived or projected
 * one. The dashboard this replaces carried two hardcoded zeros — "0 trading
 * accounts" and "0 pending transactions" — with no endpoint behind either, and
 * the comment above them admitted it. A client holding three accounts read "0".
 *
 * So the rule for anything added here: if it cannot be counted from a table, it
 * does not belong on this DTO.
 */
export class DashboardStatsDto {
  @ApiProperty({ description: 'Trading accounts held, live and demo together.' })
  totalAccounts: number;

  @ApiProperty({ description: 'Live accounts only — the ones trading real money.' })
  liveAccounts: number;

  @ApiProperty({ description: 'Transactions awaiting review — the client is waiting on us.' })
  pendingTransactions: number;

  @ApiProperty({ description: 'Clients this partner introduced. Zero when not a partner.' })
  referredClients: number;
}

/**
 * The client's landing page, in ONE request.
 *
 * ## Why one endpoint rather than six
 *
 * These panels are read together in a single glance, and a balance from one
 * instant beside a transaction list from another is a screen that quietly
 * contradicts itself. One response also means one `AsyncBoundary` and one error
 * state in the portal, rather than six panels failing independently and leaving
 * the client to work out which half of the page is trustworthy.
 *
 * ## Every field is a real read
 *
 * The screen this serves was three-quarters empty because the honest answer at
 * the time was "we do not have this". Each field below is now backed by a table:
 * wallets, transactions, trading accounts and IB attribution.
 *
 * Open positions are NOT here. They are live MT5 figures, read from the bridge
 * per account (`GET /trading/accounts/:id/positions`); the never-written
 * `positions` table this once counted always answered zero, and 0182 dropped it.
 */
export class DashboardDto {
  @ApiProperty({
    type: [WalletDto],
    description: 'Every wallet the client actually holds. A missing currency is NOT a zero.',
  })
  wallets: WalletDto[];

  @ApiProperty({
    type: [TransactionDto],
    description: 'The most recent money movements, newest first. Capped for one screen.',
  })
  recentTransactions: TransactionDto[];

  @ApiProperty({
    type: [TradingAccountDto],
    description: 'Trading accounts, live before demo.',
  })
  tradingAccounts: TradingAccountDto[];

  @ApiProperty({ type: DashboardStatsDto })
  stats: DashboardStatsDto;
}
