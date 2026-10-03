import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { positions, tradingAccounts, transactions, users } from '../../database/schema';
import { WalletService } from '../wallet/wallet.service';
import { TradingService } from './trading.service';
import type { DashboardDto } from './dto/dashboard.dto';
import { RejectionReasonsStore } from '../../store/rejection-reasons.store';
import { withReasonArabicRows } from '../payments/reason-arabic-rows';

/** The union's own column names, before they are mapped for the DTO. */
interface RecentRow {
  id: string;
  user_id: string;
  wallet_id: string;
  direction: 'deposit' | 'withdrawal';
  amount: string;
  currency: string;
  state: 'pending' | 'approved' | 'success' | 'failure' | 'rejected';
  provider: string;
  provider_ref: string | null;
  destination: string | null;
  rejection_reason: string | null;
  rejection_reason_ar: string | null;
  created_at: Date;
  kind: 'payment' | 'transfer';
}

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
    /* A refused movement's reason in Arabic (0179) — `rejectionReasonAr`. */
    private readonly reasons: RejectionReasonsStore,
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
  async forUser(userId: number) {
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
  /*
   * ── TRANSFERS BELONG IN RECENT ACTIVITY TOO ──────────────────────────────
   *
   * This read the transactions table alone, so a client who had just moved money
   * between their wallet and a trading account saw nothing here — the most
   * recent thing they had done was the one thing the panel would not show.
   * Recent activity that omits a whole class of movement is worse than none: it
   * looks complete.
   *
   * Unioned in SQL rather than fetched separately and merged, for the reason
   * TransactionsService.listForUser gives at length: "the five newest" across
   * two lists is not the five newest of either, so merging after the LIMIT
   * silently drops rows. The limit has to apply to the combined set.
   *
   * The mapping is the same one the list endpoint uses — direction stated from
   * the wallet's side, transfer states mapped onto transaction states — and it
   * is deliberately identical. Two screens describing one movement differently
   * is how a client concludes the numbers are wrong.
   */
  private async recentTransactions(userId: number) {
    const rows = await this.db.execute(sql`
      WITH combined AS (
        SELECT
          t.id, t.user_id, t.wallet_id, t.direction::text AS direction, t.amount, t.currency,
          t.state::text AS state, t.provider, t.provider_ref, t.destination,
          t.rejection_reason, t.rejection_reason_ar, t.created_at, 'payment'::text AS kind
        FROM transactions t
        WHERE t.user_id = ${userId}

        UNION ALL

        SELECT
          tr.id, tr.user_id, tr.wallet_id,
          CASE WHEN tr.direction = 'account_to_wallet' THEN 'deposit' ELSE 'withdrawal' END,
          tr.amount, tr.currency,
          CASE tr.state
            WHEN 'settled' THEN 'success'
            WHEN 'failed'  THEN 'failure'
            ELSE 'pending'
          END,
          'transfer'::varchar, NULL::varchar, NULL::text,
          tr.failure_reason, tr.failure_reason_ar, tr.created_at, 'transfer'::text
        FROM transfers tr
        WHERE tr.user_id = ${userId}
      )
      SELECT * FROM combined
      ORDER BY created_at DESC, id DESC
      LIMIT ${RECENT_TRANSACTION_LIMIT}
    `);

    const recent = (rows.rows as unknown as RecentRow[]).map((row) => ({
      id: row.id,
      userId: row.user_id,
      walletId: row.wallet_id,
      direction: row.direction,
      amount: row.amount,
      currency: row.currency,
      state: row.state,
      provider: row.provider,
      providerRef: row.provider_ref,
      destination: row.destination,
      rejectionReason: row.rejection_reason,
      rejectionReasonAr: row.rejection_reason_ar,
      createdAt: row.created_at,
      kind: row.kind,
    }));
    // `rejectionReasonAr` (0179): stored, else the catalogue's — as the history list.
    return withReasonArabicRows(recent, this.reasons);
  }

  /**
   * The five counts, each from its own table.
   *
   * `count()` in the DATABASE rather than fetching rows and reading `.length`:
   * the transaction and position histories grow without bound, and counting them
   * client-side would move every row across the wire to produce one integer.
   */
  private async statsFor(userId: number): Promise<DashboardDto['stats']> {
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
