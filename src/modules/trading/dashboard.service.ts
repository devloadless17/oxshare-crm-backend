import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { positions, tradingAccounts, transactions, users } from '../../database/schema';
import { WalletService } from '../wallet/wallet.service';
import { TradingService } from './trading.service';
import type { DashboardDto } from './dto/dashboard.dto';

/** How many recent transactions the landing page shows. */
const RECENT_TRANSACTION_LIMIT = 8;

/** How many open positions the landing page shows before "view all". */
const OPEN_POSITION_LIMIT = 10;

/**
 * The client's landing page, assembled in one read.
 *
 * ## Why this service exists rather than six frontend requests
 *
 * The panels are read together in a single glance. A balance from one instant
 * beside a transaction list from another is a screen that quietly contradicts
 * itself, and six independent requests give the portal six loading states and
 * six ways to half-fail — leaving the client to work out which part of the page
 * they can trust.
 *
 * ## Every number is counted, never derived
 *
 * The dashboard this replaces carried two HARDCODED zeros — "0 trading accounts"
 * and "0 pending transactions" — with no endpoint behind either. A client
 * holding three accounts read "0". That is the same failure as the wallet
 * showing `$0.00` to somebody holding $700, and it is why the rule here is: if a
 * figure cannot be counted from a table, it does not go on this screen.
 *
 * `openPositions` is the interesting case. It returns empty for everyone,
 * because nothing writes to `positions` until an MT5 bridge exists — but the
 * QUERY IS REAL, so "no open positions" is an answer the database gave rather
 * than one the portal assumed. That distinction is exactly what the two bugs
 * above were.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly wallets: WalletService,
    private readonly trading: TradingService,
  ) {}

  /**
   * Everything the landing page renders.
   *
   * Issued as ONE `Promise.all`: none of these reads depends on another's
   * result, and they are all indexed lookups scoped to a single user. Awaiting
   * them in sequence would make the client's first screen six round-trips deep
   * for no benefit.
   */
  /*
   * NO `Promise<DashboardDto>` annotation, and that is deliberate rather than an
   * oversight.
   *
   * `WalletDto.currency` and `TransactionDto.currency` are declared as the union
   * `'USD' | 'USDT'`, while the COLUMN is a varchar foreign key into the
   * operator-managed `currencies` table — `WalletService.Currency` is a bare
   * `string` and its comment explains why: a union cannot express a set the
   * database owns at runtime, and pretending otherwise means every new currency
   * is a code change.
   *
   * So annotating here would force a cast that lies about the narrower type
   * being true. The DTOs still drive Swagger through `@ApiOkResponse` on the
   * controller, which is what the portal generates from; this is the same shape
   * `WalletController` and `PaymentsController` already have, neither of which
   * annotates its handlers either.
   */
  async forUser(userId: string) {
    const [wallets, recentTransactions, tradingAccountRows, openPositions, stats] =
      await Promise.all([
        this.wallets.listWallets(userId),
        this.recentTransactions(userId),
        this.trading.listMine(userId),
        this.trading.listPositions(userId, { status: 'open', limit: OPEN_POSITION_LIMIT }),
        this.statsFor(userId),
      ]);

    return {
      wallets,
      recentTransactions,
      tradingAccounts: tradingAccountRows,
      openPositions,
      stats,
    };
  }

  /**
   * The client's most recent money movements, newest first.
   *
   * Capped rather than paginated: this is a PREVIEW, and the full history has
   * its own screen with real filters. A cursor here would imply the dashboard is
   * somewhere you browse from, which it is not.
   *
   * Scoped by `userId` from the session — never a parameter a caller supplies
   * (R-4.4). It is the only thing standing between this and one client reading
   * another's transactions.
   */
  private async recentTransactions(userId: string) {
    return this.db
      .select({
        id: transactions.id,
        userId: transactions.userId,
        walletId: transactions.walletId,
        direction: transactions.direction,
        amount: transactions.amount,
        currency: transactions.currency,
        state: transactions.state,
        provider: transactions.provider,
        providerRef: transactions.providerRef,
        destination: transactions.destination,
        rejectionReason: transactions.rejectionReason,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .orderBy(desc(transactions.createdAt))
      .limit(RECENT_TRANSACTION_LIMIT);
  }

  /**
   * The five counts, each from its own table.
   *
   * `count()` in the DATABASE rather than fetching rows and reading `.length`:
   * the transaction and position histories grow without bound, and counting them
   * client-side would move every row across the wire to produce one integer.
   */
  private async statsFor(userId: string): Promise<DashboardDto['stats']> {
    const [accountRows, liveRows, openPositionRows, pendingRows, referredRows] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(tradingAccounts)
        .where(eq(tradingAccounts.userId, userId)),
      this.db
        .select({ value: count() })
        .from(tradingAccounts)
        .where(and(eq(tradingAccounts.userId, userId), eq(tradingAccounts.environment, 'live'))),
      this.db
        .select({ value: count() })
        .from(positions)
        .where(and(eq(positions.userId, userId), eq(positions.status, 'open'))),
      /*
       * `pending` only — not `approved`. The distinction is who is being waited
       * on: a pending transaction is one WE have not acted on, which is the
       * thing worth surfacing to a client. An approved one is already moving.
       */
      this.db
        .select({ value: count() })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.state, 'pending'))),
      /*
       * Zero for a client who is not a partner, which is correct rather than a
       * missing value: they have introduced nobody. The partner SCREEN is where
       * this number means something, and it is gated there.
       */
      this.db.select({ value: count() }).from(users).where(eq(users.referredByIbUserId, userId)),
    ]);

    return {
      totalAccounts: accountRows[0]?.value ?? 0,
      liveAccounts: liveRows[0]?.value ?? 0,
      openPositions: openPositionRows[0]?.value ?? 0,
      pendingTransactions: pendingRows[0]?.value ?? 0,
      referredClients: referredRows[0]?.value ?? 0,
    };
  }
}
