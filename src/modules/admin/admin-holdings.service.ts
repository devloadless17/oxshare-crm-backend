import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { tradingAccounts, users, wallets } from '../../database/schema';
import {
  clientScopePredicate,
  UNRESTRICTED,
  type ClientScope,
} from '../../common/security/client-scope';
import {
  buildCursorPage,
  decodeCursor,
  pageSize,
  type CursorPosition,
} from '../../common/pagination';
import { sortKey, sortOrder, type SortOrder } from '../../common/sorting';
import { assertActorCan } from '../../common/security/actor';
import { enumQuery } from '../../common/query-params';
import { tradingAccountStatusEnum, tradingEnvironmentEnum } from '../../database/schema';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/**
 * The two client-HOLDINGS lists: every wallet, and every trading account.
 *
 * ── Why these live in a service rather than in `store/` ─────────────────────
 *
 * Both projections carry a monetary column, and the §6 rule is that a balance
 * crosses the API boundary as the STRING the database produced. Normalising it
 * means `money()`, which lives in `modules/wallet/money.ts` — and `store/**` may
 * not import from `modules/**` (eslint `no-restricted-imports`, the layering
 * rule). So a store would have had to either re-implement decimal handling or
 * hand raw rows up for somebody else to normalise, and "somebody else" is
 * exactly how a balance ends up through `Number()` once.
 *
 * `TransactionsService.listForAdmin` sets the precedent for the same reason:
 * the withdrawal queue is a joined, scoped, sorted money list owned by a
 * service, not by `store/`.
 *
 * ── The property this file exists to guarantee ──────────────────────────────
 *
 * Wallets and trading accounts are CLIENT-OWNED rows, so both queries put
 * `clientScopePredicate` in the WHERE clause, on `wallets.user_id` and
 * `trading_accounts.user_id`. Never a post-fetch filter — see
 * `common/security/client-scope.ts` for why that is the whole design. A scoped
 * admin's out-of-scope row never enters the result set, so it also cannot enter
 * the `total`, the cursor, or the CSV export.
 *
 * ── Balances are never coerced ──────────────────────────────────────────────
 *
 * `balance` and `on_hold` are `NUMERIC(28,8)`; node-postgres hands them over as
 * strings and they stay strings the whole way out. Nothing here calls `Number`,
 * `parseFloat` or `Intl.NumberFormat` — `Number('12345678901234567.89012345')`
 * is already wrong before any formatting starts (ARCHITECTURE §6.1).
 */

/**
 * The columns the wallet list may be ordered by — R-2.5's closed allowlist.
 *
 * `balance` sorts on the NUMERIC column IN SQL, at full precision. The two
 * obvious shortcuts are both wrong in the same way `WITHDRAWAL_SORT_COLUMNS`
 * records: `ORDER BY balance::float8` collapses values differing beyond 2^53
 * into equal keys, and sorting the fetched page in JavaScript sorts the 25 rows
 * in hand rather than the filtered set. Postgres compares `numeric` exactly, so
 * the bare column is both the correct comparison and the indexable one.
 *
 * The joined client columns cost no extra join — `users` is already INNER
 * JOINed for the owner each row is displayed with. `userFirstName` rather than a
 * concatenated full name, because the index is on the column and a
 * `first || ' ' || last` expression would need its own expression index.
 *
 * Every key here is backed by a `(col DESC, id DESC)` composite in migration
 * 0038, and `test/admin-sort-indexes.spec.ts` asserts the PLANS — so adding a
 * key without an index fails a spec rather than making a screen quietly slow.
 */
export const WALLET_SORT_COLUMNS = {
  createdAt: wallets.createdAt,
  balance: wallets.balance,
  currency: wallets.currency,
  userEmail: users.email,
  userFirstName: users.firstName,
} as const;

export type WalletSortKey = keyof typeof WALLET_SORT_COLUMNS;

/** Newest wallet first, matching every other admin list's default. */
export const DEFAULT_WALLET_SORT: WalletSortKey = 'createdAt';

/**
 * The columns the trading-account list may be ordered by — R-2.5.
 *
 * `balance` is here for the same reason and with the same caveat as the wallet
 * list's, and `trading_accounts.balance` carries the schema's own warning: the
 * CRM owns that number only until the MT5 bridge lands. Sorting by it is
 * sorting by what this database believes, which is the honest thing a CRM
 * screen can offer today.
 *
 * `login` is NULLABLE — an account has no MT5 login until one is assigned — so
 * the query pins `NULLS LAST` in both directions and migration 0038's index
 * declares the same. Without that, "lowest login first" would lead with every
 * account that has no login at all.
 */
export const TRADING_ACCOUNT_SORT_COLUMNS = {
  createdAt: tradingAccounts.createdAt,
  balance: tradingAccounts.balance,
  login: tradingAccounts.login,
  currency: tradingAccounts.currency,
  status: tradingAccounts.status,
  environment: tradingAccounts.environment,
  userEmail: users.email,
  userFirstName: users.firstName,
} as const;

export type TradingAccountSortKey = keyof typeof TRADING_ACCOUNT_SORT_COLUMNS;

export const DEFAULT_TRADING_ACCOUNT_SORT: TradingAccountSortKey = 'createdAt';

/** The one sort key whose column is nullable, so the query must pin its nulls. */
const NULLABLE_TRADING_ACCOUNT_SORT: TradingAccountSortKey = 'login';

/**
 * How a cursor value is cast back to its column's own type for the keyset seek.
 *
 * `::timestamptz` on an email address is a runtime error at the database, from a
 * value that looked fine in the URL — so the cast follows the sort key rather
 * than always being one thing. `balance` casts to `::numeric`, never to a float:
 * the cursor carries the exact decimal string the row held, and `::numeric` is
 * what compares it at full precision against a `NUMERIC(28,8)` column.
 */
function seekTerms(
  sortColumn: SQLWrapper,
  kind: 'timestamp' | 'numeric' | 'text',
  cursor: CursorPosition,
  idColumn: SQLWrapper,
  direction: SortOrder,
): SQL {
  const comparator = direction === 'asc' ? sql`>` : sql`<`;
  const cast =
    kind === 'timestamp'
      ? sql`${cursor.value}::timestamptz`
      : kind === 'numeric'
        ? sql`${cursor.value}::numeric`
        : sql`${cursor.value}::text`;
  // Enum and varchar columns compare as text; Postgres knows an enum's text
  // representation, so `::text` casts cleanly for both.
  const seekColumn = kind === 'text' ? sql`${sortColumn}::text` : sql`${sortColumn}`;

  return sql`(${seekColumn}, ${idColumn}) ${comparator} (${cast}, ${cursor.id}::uuid)`;
}

@Injectable()
export class AdminHoldingsService {
  /**
   * The db is injected rather than fetched from the module-level singleton, for
   * the reason `TransactionsService` records: a declared dependency can be seen,
   * and reaching for a global from inside a method that reads balances cannot.
   */
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  // ── Wallets ───────────────────────────────────────────────────────────────

  /**
   * Every client wallet, filtered, scoped, sorted and paged in SQL.
   *
   * `assertActorCan` runs HERE as well as in the guard (R-4.3). This method
   * decides WHICH ROWS the caller gets from the actor's scope, so it is making
   * an authorization decision rather than merely receiving one — and a queued
   * report calling it has no guard at all.
   */
  async listWallets(
    query: {
      userId?: string;
      currency?: string;
      page?: string;
      limit?: string;
      cursor?: string;
      withTotal?: string;
      sort?: string;
      order?: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'withdrawals.view', 'list client wallets');

    /*
     * The sort is validated BEFORE the cursor is decoded, and the order matters.
     * `decodeCursor` refuses a cursor minted under a different ordering and needs
     * the current sort key to say which; decoding first would produce "this
     * cursor is for createdAt but you asked for undefined" — true and useless.
     */
    const sort = sortKey(query.sort, WALLET_SORT_COLUMNS, DEFAULT_WALLET_SORT, 'wallets');
    const order = sortOrder(query.order);
    const cursor = query.cursor ? decodeCursor(query.cursor, sort) : undefined;

    return this.walletPage({
      userId: query.userId,
      currency: query.currency,
      page: Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1),
      limit: pageSize(query.limit),
      cursor,
      withTotal: query.withTotal !== 'false',
      sort,
      order,
      // The whole point. Row-level visibility, in the WHERE clause.
      scope: actor.clientScope,
    });
  }

  private walletConditions(filter: {
    userId?: string;
    currency?: string;
    scope?: ClientScope;
  }): SQL[] {
    const conditions: SQL[] = [];
    if (filter.userId) conditions.push(eq(wallets.userId, filter.userId));
    /*
     * `currency` is an exact match on the wallet's own code rather than an enum
     * check: `currencies` is an operator-managed TABLE, not a Postgres enum, so
     * there is no `.enumValues` to validate against and an unknown code is
     * legitimately an empty list rather than a 400. That is different from
     * `environment` below, which IS an enum and so gets R-2.5 treatment.
     */
    if (filter.currency) conditions.push(eq(wallets.currency, filter.currency));

    // In the WHERE clause, never a post-fetch comparison. An out-of-scope wallet
    // never enters the result set, so it cannot enter the total or the cursor.
    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, wallets.userId);
    if (scoped) conditions.push(scoped);

    return conditions;
  }

  private async walletPage(filter: {
    userId?: string;
    currency?: string;
    page: number;
    limit: number;
    cursor?: CursorPosition;
    withTotal: boolean;
    sort: WalletSortKey;
    order: SortOrder;
    scope?: ClientScope;
  }) {
    const db = this.db;
    const sortColumn: SQLWrapper = WALLET_SORT_COLUMNS[filter.sort];
    const conditions = this.walletConditions(filter);

    if (filter.cursor) {
      const kind =
        filter.sort === 'createdAt' ? 'timestamp' : filter.sort === 'balance' ? 'numeric' : 'text';
      conditions.push(seekTerms(sortColumn, kind, filter.cursor, wallets.id, filter.order));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const usingCursor = Boolean(filter.cursor) || filter.page <= 1;
    // Both keys in the SAME direction — a b-tree reads backwards only when every
    // column of the ORDER BY agrees, which is the shape migration 0038 creates.
    const orderBy = filter.order === 'asc' ? asc : desc;

    const rows = await db
      .select({
        id: wallets.id,
        // Selected as the strings the columns hold. No cast, no aggregate, no
        // arithmetic — §6.1.
        balance: wallets.balance,
        onHold: wallets.onHold,
        currency: wallets.currency,
        createdAt: wallets.createdAt,
        updatedAt: wallets.updatedAt,
        userId: wallets.userId,
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
      })
      .from(wallets)
      .innerJoin(users, eq(wallets.userId, users.id))
      .where(where)
      .orderBy(orderBy(sortColumn), orderBy(wallets.id))
      // One extra row answers "is there a next page" with no second query.
      .limit(filter.limit + 1)
      .offset(usingCursor ? 0 : (filter.page - 1) * filter.limit);

    let total: number | undefined;
    if (filter.withTotal) {
      const [countRow] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(wallets)
        .innerJoin(users, eq(wallets.userId, users.id))
        .where(where);
      total = countRow.value;
    }

    /*
     * `buildCursorPage` mints the cursor by reading `row[sort]`, so the row it
     * is handed must carry the sort key under THAT NAME. The projection renames
     * the joined client columns to `userEmail`/`userFirstName`, which are the
     * allowlist's keys already — so the rows go in as they are, and the API
     * shaping happens afterwards.
     */
    const paged = buildCursorPage(rows, filter.limit, total, filter.sort);

    return {
      items: paged.items.map((r) => ({
        id: r.id,
        /*
         * The STRING the database produced, unmodified.
         *
         * Deliberately NOT run through `money()`. That would be correct — it
         * re-serialises through decimal.js at 8 places, which is what the column
         * already holds — but it is also a conversion this path does not need,
         * and every conversion on a money path is a place a future edit can
         * introduce a float. `NUMERIC(28,8)` arrives from node-postgres already
         * at scale 8, so passing it through is byte-identical AND has no seam.
         */
        balance: r.balance,
        onHold: r.onHold,
        currency: r.currency,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        user: {
          id: r.userId,
          email: r.userEmail,
          firstName: r.userFirstName,
          lastName: r.userLastName,
        },
      })),
      nextCursor: paged.nextCursor,
      total: total ?? 0,
      page: filter.page,
      limit: filter.limit,
    };
  }

  /**
   * One batch of wallets for a CSV export — the same filters and the SAME scope
   * as the list, without the page-size ceiling.
   *
   * A separate method rather than a flag on the list, for the reason
   * `TransactionsService.listForExport` records: the list clamps its limit
   * through `pageSize()` (100), which is right for a screen and wrong for a file
   * promising every matching row. What is NOT duplicated is the part that
   * matters — the scope predicate is built by the same `clientScopePredicate`
   * call against the same `wallets.user_id` column, in the WHERE clause, so an
   * export cannot see a row the list would have hidden.
   *
   * Offset paging rather than a keyset seek, deliberately: the ordering is total
   * (`created_at DESC, id DESC`) and the export is read to completion in one
   * request, so a concurrent insert can only add a row at the head this pass has
   * already gone by.
   */
  async walletExportBatch(
    query: { userId?: string; currency?: string },
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
  ) {
    assertActorCan(actor, 'withdrawals.view', 'export client wallets');

    const conditions = this.walletConditions({ ...query, scope: actor.clientScope });
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return (
      this.db
        .select({
          id: wallets.id,
          balance: wallets.balance,
          onHold: wallets.onHold,
          currency: wallets.currency,
          createdAt: wallets.createdAt,
          updatedAt: wallets.updatedAt,
          userId: wallets.userId,
          userEmail: users.email,
          userFirstName: users.firstName,
          userLastName: users.lastName,
        })
        .from(wallets)
        .innerJoin(users, eq(wallets.userId, users.id))
        .where(where)
        // Matching the list's default ordering, so an export and the screen list
        // the same rows in the same order.
        .orderBy(desc(wallets.createdAt), desc(wallets.id))
        .limit(limit)
        .offset(offset)
    );
  }

  // ── Trading accounts ──────────────────────────────────────────────────────

  async listTradingAccounts(
    query: {
      userId?: string;
      environment?: string;
      status?: string;
      page?: string;
      limit?: string;
      cursor?: string;
      withTotal?: string;
      sort?: string;
      order?: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'users.view', 'list client trading accounts');

    const sort = sortKey(
      query.sort,
      TRADING_ACCOUNT_SORT_COLUMNS,
      DEFAULT_TRADING_ACCOUNT_SORT,
      'trading accounts',
    );
    const order = sortOrder(query.order);
    const cursor = query.cursor ? decodeCursor(query.cursor, sort) : undefined;

    return this.tradingAccountPage({
      userId: query.userId,
      // Checked against the schema's own enum, never cast. `?environment=nonsense`
      // compared against a Postgres enum column surfaces as a 500 carrying a
      // database error; R-2.5 wants a 400 naming what IS allowed.
      environment: enumQuery(query.environment, tradingEnvironmentEnum.enumValues, 'environment'),
      status: enumQuery(query.status, tradingAccountStatusEnum.enumValues, 'status'),
      page: Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1),
      limit: pageSize(query.limit),
      cursor,
      withTotal: query.withTotal !== 'false',
      sort,
      order,
      scope: actor.clientScope,
    });
  }

  private tradingAccountConditions(filter: {
    userId?: string;
    environment?: string;
    status?: string;
    scope?: ClientScope;
  }): SQL[] {
    const conditions: SQL[] = [];
    if (filter.userId) conditions.push(eq(tradingAccounts.userId, filter.userId));
    if (filter.environment) {
      conditions.push(eq(tradingAccounts.environment, filter.environment as 'live'));
    }
    if (filter.status) {
      conditions.push(eq(tradingAccounts.status, filter.status as 'active'));
    }

    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, tradingAccounts.userId);
    if (scoped) conditions.push(scoped);

    return conditions;
  }

  private async tradingAccountPage(filter: {
    userId?: string;
    environment?: string;
    status?: string;
    page: number;
    limit: number;
    cursor?: CursorPosition;
    withTotal: boolean;
    sort: TradingAccountSortKey;
    order: SortOrder;
    scope?: ClientScope;
  }) {
    const db = this.db;
    const sortColumn: SQLWrapper = TRADING_ACCOUNT_SORT_COLUMNS[filter.sort];
    const conditions = this.tradingAccountConditions(filter);

    if (filter.cursor) {
      const kind =
        filter.sort === 'createdAt' ? 'timestamp' : filter.sort === 'balance' ? 'numeric' : 'text';
      conditions.push(seekTerms(sortColumn, kind, filter.cursor, tradingAccounts.id, filter.order));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const usingCursor = Boolean(filter.cursor) || filter.page <= 1;
    const orderBy = filter.order === 'asc' ? asc : desc;

    /*
     * `login` is the one nullable sort column, so its null placement is PINNED
     * rather than left to Postgres — which defaults to NULLS LAST for ASC and
     * NULLS FIRST for DESC. Without this, flipping the direction silently moves
     * every unassigned account from one end of the list to the other, and
     * "lowest login first" leads with rows that have no login at all.
     */
    const nullsLast = filter.sort === NULLABLE_TRADING_ACCOUNT_SORT;
    const primary = nullsLast ? sql`${orderBy(sortColumn)} NULLS LAST` : orderBy(sortColumn);

    const rows = await db
      .select({
        id: tradingAccounts.id,
        login: tradingAccounts.login,
        mt5Group: tradingAccounts.mt5Group,
        environment: tradingAccounts.environment,
        currency: tradingAccounts.currency,
        // A string, straight from NUMERIC(28,8) — see the wallet projection.
        balance: tradingAccounts.balance,
        tier: tradingAccounts.tier,
        leverage: tradingAccounts.leverage,
        status: tradingAccounts.status,
        createdAt: tradingAccounts.createdAt,
        updatedAt: tradingAccounts.updatedAt,
        userId: tradingAccounts.userId,
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
      })
      .from(tradingAccounts)
      .innerJoin(users, eq(tradingAccounts.userId, users.id))
      .where(where)
      .orderBy(primary, orderBy(tradingAccounts.id))
      .limit(filter.limit + 1)
      .offset(usingCursor ? 0 : (filter.page - 1) * filter.limit);

    let total: number | undefined;
    if (filter.withTotal) {
      const [countRow] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(tradingAccounts)
        .innerJoin(users, eq(tradingAccounts.userId, users.id))
        .where(where);
      total = countRow.value;
    }

    const paged = buildCursorPage(rows, filter.limit, total, filter.sort);

    return {
      items: paged.items.map((r) => ({
        id: r.id,
        login: r.login,
        mt5Group: r.mt5Group,
        environment: r.environment,
        currency: r.currency,
        balance: r.balance,
        tier: r.tier,
        leverage: r.leverage,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        user: {
          id: r.userId,
          email: r.userEmail,
          firstName: r.userFirstName,
          lastName: r.userLastName,
        },
      })),
      nextCursor: paged.nextCursor,
      total: total ?? 0,
      page: filter.page,
      limit: filter.limit,
    };
  }

  /** One batch of trading accounts for a CSV export — see `walletExportBatch`. */
  async tradingAccountExportBatch(
    query: { userId?: string; environment?: string; status?: string },
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
  ) {
    assertActorCan(actor, 'users.view', 'export client trading accounts');

    const conditions = this.tradingAccountConditions({ ...query, scope: actor.clientScope });
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select({
        id: tradingAccounts.id,
        login: tradingAccounts.login,
        mt5Group: tradingAccounts.mt5Group,
        environment: tradingAccounts.environment,
        currency: tradingAccounts.currency,
        balance: tradingAccounts.balance,
        tier: tradingAccounts.tier,
        leverage: tradingAccounts.leverage,
        status: tradingAccounts.status,
        createdAt: tradingAccounts.createdAt,
        updatedAt: tradingAccounts.updatedAt,
        userId: tradingAccounts.userId,
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
      })
      .from(tradingAccounts)
      .innerJoin(users, eq(tradingAccounts.userId, users.id))
      .where(where)
      .orderBy(desc(tradingAccounts.createdAt), desc(tradingAccounts.id))
      .limit(limit)
      .offset(offset);
  }
}
