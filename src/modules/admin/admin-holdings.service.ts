import { type DateRange, withinRange } from '../../common/date-range';
import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
  lte,
} from 'drizzle-orm';
import {
  clientIdByPortalId,
  clientIdentitySearch,
  escapeLike,
  parsePortalId,
} from '../../store/users.store';
import { currentFieldMask } from '../../common/logging/request-context';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import {
  mt5Deals,
  paymentMethods,
  tradingAccounts,
  tradingProductGroups,
  transactions,
  users,
  wallets,
  withdrawalPaymentMethods,
} from '../../database/schema';
/*
 * Shared with `TradingService` on purpose. The client and the operator must read
 * the same product off the same account — a mismatch surfaces mid-dispute, with
 * both screens open.
 */
import {
  PRODUCT_BY_GROUP,
  PRODUCT_BY_ID,
  PRODUCT_GROUP_JOIN_ON,
  PRODUCT_NAME,
} from '../../common/account-product';
import {
  clientScopePredicate,
  UNRESTRICTED,
  type ClientScope,
} from '../../common/security/client-scope';
import {
  buildCursorPage,
  cappedTotal,
  decodeCursor,
  pageSize,
  keysetSeek,
  TOTAL_CAP,
  twoWayPaging,
  walkOrder,
  wrapPage,
  type CappedTotal,
  type CursorPosition,
  type CursorValueShape,
  type PageDirection,
} from '../../common/pagination';
import { sortKey, sortOrder, type SortOrder } from '../../common/sorting';
import { assertActorCan } from '../../common/security/actor';
import { maskedFieldsFor } from '../../common/security/field-mask';
import { enumQuery } from '../../common/query-params';
import { tradingAccountStatusEnum, tradingEnvironmentEnum } from '../../database/schema';
import type { AuthenticatedAdmin } from './guards/admin.guard';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import { CLOSING_ENTRIES, ENTRY_IN, TRADE_ACTIONS, dealSide } from '../trading/mt5/deal-codes';

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
 * number is the CRM's mirror of MT5, kept by the bridge. Sorting by it is
 * sorting by the last figure the bridge reported, which is the honest thing a
 * CRM screen can offer without a live read per row.
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

/**
 * A wallet number, exactly as `wallets_wallet_number_format` defines it.
 *
 * Twelve characters from an alphabet with i, l, o and u removed so nothing can
 * be misread as a digit. Kept in step with the CHECK constraint BY HAND — there
 * is no way to derive one from the other — and `admin-holdings-search.spec.ts`
 * asserts a generated number matches this, so a change to the constraint that
 * is not made here turns that red rather than silently routing every number to
 * the name search.
 */
const WALLET_NUMBER = /^[0-9a-hjkmnp-tv-z]{12}$/i;

/**
 * An MT5 login: all digits, and compared as a STRING.
 *
 * Bounded at both ends so a long digit string cannot be mistaken for one, and
 * so a single digit does not route a plausible name fragment away from the
 * person search.
 */
const MT5_LOGIN = /^\d{3,20}$/;

/**
 * What the trading-account search box matches — exported so the planner test
 * (`search-at-scale.spec.ts`) measures THIS predicate rather than a copy of it.
 *
 * The same one-box-two-things rule as the wallet search, with the MT5 LOGIN as
 * this screen's identifier — see `walletConditions` for why it is routed by
 * shape rather than OR-ed across the join.
 *
 * A login is all digits and a name is not, so the shape decides. Leading zeros
 * are significant to the bridge, which is why `login` is a string and is
 * compared as one: `00012345` and `12345` are different accounts, and parsing
 * the term as a number would silently merge them.
 *
 * ## A number is also a Portal ID
 *
 * Both identifiers are digits, and an operator holding "1000245" cannot know
 * which one it is — so a number matches EITHER: the account with that login,
 * and every account of the client with that Portal ID. Still one table: the
 * Portal ID branch compares `trading_accounts.user_id` to the owner resolved by
 * `clientIdByPortalId`, so the OR is between two of this table's own indexes
 * (`trading_accounts_login_uq`, `trading_accounts_user_idx`) and Postgres can
 * BitmapOr them — the join the rule above forbids never enters it.
 */
export function tradingAccountSearch(term: string): SQL {
  if (!MT5_LOGIN.test(term)) {
    /*
     * An account no client owns yet (0166) is found by MT5's HOLDER name or
     * email — what the operator is matching it on. Only while neither is hidden
     * from the reader: a fragment matched against a hidden column reveals it a
     * keystroke at a time (the rule `clientIdentitySearch` states).
     */
    const mask = currentFieldMask();
    const holderHidden =
      mask.includes('client.email') ||
      mask.includes('client.firstName') ||
      mask.includes('client.lastName');
    if (holderHidden) return clientIdentitySearch(term);
    const fragment = `%${escapeLike(term)}%`;
    return or(
      clientIdentitySearch(term),
      sql`(coalesce(${tradingAccounts.mt5HolderEmail}, '') || ' ' || coalesce(${tradingAccounts.mt5HolderName}, '')) ILIKE ${fragment}`,
    ) as SQL;
  }
  const portalId = parsePortalId(term);
  if (portalId === undefined) return eq(tradingAccounts.login, term);
  return sql`(${tradingAccounts.login} = ${term} OR ${tradingAccounts.userId} = ${clientIdByPortalId(portalId)})`;
}

export const DEFAULT_TRADING_ACCOUNT_SORT: TradingAccountSortKey = 'createdAt';

/** `?client=` on the trading-account list and export: owned, or found on MT5 unowned (0166). */
export const TRADING_ACCOUNT_CLIENT_FILTERS = ['assigned', 'unassigned'] as const;

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
/**
 * The CAST a holdings seek will apply to a cursor value, by sort key.
 *
 * Extracted because it is now needed twice — once to build the seek, once to
 * validate the cursor on the way in — and two copies of a cast decision is how
 * a seek and its validator come to disagree. `createdAt` is a timestamp,
 * `balance` is numeric, everything else compares as text.
 */
function seekKindFor(sort: string): 'timestamp' | 'numeric' | 'text' {
  return sort === 'createdAt' ? 'timestamp' : sort === 'balance' ? 'numeric' : 'text';
}

/** `seekTerms`' vocabulary, in the one `decodeCursor` speaks. */
const CURSOR_SHAPE: Record<'timestamp' | 'numeric' | 'text', CursorValueShape> = {
  timestamp: 'timestamptz',
  numeric: 'numeric',
  text: 'text',
};

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
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    /**
     * The by-id gate for the two per-client DRILL-DOWNS below.
     *
     * The list surfaces on this service need none: they are scoped in the WHERE
     * clause and return the rows the reader may see. A drill-down names ONE
     * client in its path, and for those the scoped query alone answers 200 with
     * an empty list — which says "this client has no positions" to somebody who
     * is simply not allowed to know. Every other by-id client route in this
     * codebase answers 404.
     */
    private readonly visibility: ClientVisibilityService,
  ) {}

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
      userId?: number;
      currency?: string;
      q?: string;
      page?: string;
      limit?: string;
      cursor?: string;
      /** `prev` / `last` walk backward — `pageDirection`. */
      dir?: string;
      withTotal?: string;
      sort?: string;
      order?: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'wallets.view', 'list client wallets');

    /*
     * The sort is validated BEFORE the cursor is decoded, and the order matters.
     * `decodeCursor` refuses a cursor minted under a different ordering and needs
     * the current sort key to say which; decoding first would produce "this
     * cursor is for createdAt but you asked for undefined" — true and useless.
     */
    const sort = sortKey(query.sort, WALLET_SORT_COLUMNS, DEFAULT_WALLET_SORT, 'wallets');
    const order = sortOrder(query.order);
    /*
     * The cursor's VALUE is shape-checked against the cast this list will apply.
     *
     * Without it `?sort=balance&cursor=<tampered>` reached `::numeric` and
     * answered 500 with a Postgres cast error. `transactions.service.ts`
     * validated both halves in its own seek; every other keyset list inherited
     * nothing, which is why the check now lives in the shared decoder and the
     * caller only has to name its cast.
     */
    const cursor = query.cursor
      ? decodeCursor(query.cursor, sort, CURSOR_SHAPE[seekKindFor(sort)])
      : undefined;

    /*
     * RBAC-03, applied HERE rather than inside `walletPage` because the mask is the
     * actor's and the page helper is deliberately actor-free — it decides rows,
     * not fields.
     *
     * These rows carry the client under `user`, the same shape the withdrawal
     * desk uses, and this screen served the email address a role was configured
     * to hide: `applyMask` is opt-in and nothing on this path ever called it.
     * The catalog carried no `wallet.` prefix either, so the call alone would
     * have been a silent no-op — the aliases went in beside it.
     *
     * Found by `test/mask-coverage.spec.ts`, which is what that census is for:
     * two sibling surfaces masked, this one not, and no behavioural test in the
     * repo asserting anything about it.
     */
    const page = await this.walletPage({
      userId: query.userId,
      currency: query.currency,
      q: query.q,
      page: Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1),
      limit: pageSize(query.limit),
      cursor,
      paging: twoWayPaging(query),
      withTotal: query.withTotal !== 'false',
      sort,
      order,
      // The whole point. Row-level visibility, in the WHERE clause.
      scope: actor.clientScope,
    });
    return {
      ...page,
      items: page.items,
      maskedFields: maskedFieldsFor('wallet', actor.fieldMask),
    };
  }

  private walletConditions(filter: {
    userId?: number;
    currency?: string;
    q?: string;
    scope?: ClientScope;
  }): SQL[] {
    const conditions: SQL[] = [];
    if (filter.userId) conditions.push(eq(wallets.userId, filter.userId));
    /*
     * SEARCH BY THE THING THE SCREEN SHOWS.
     *
     * This list offered exactly one client filter — `userId`, a uuid — while
     * every row displays a NAME and an EMAIL and no id at all. So an operator
     * looking straight at a client could not filter to them: they had to leave
     * for `/clients`, copy the id, and come back. A filter you can only use by
     * visiting another screen first is not a filter, and the placeholder said
     * "Paste a client ID" out loud.
     *
     * ⚠️ THE EXPRESSION IS CHARACTER-FOR-CHARACTER THE ONE `users.store.ts`
     * SEARCHES ON, and that is not stylistic. A leading wildcard cannot use a
     * b-tree, so this is served by the pg_trgm GIN index — which Postgres uses
     * ONLY when the query expression matches what the index was built on. Write
     * it as three ILIKEs, or reorder the concatenation, and it silently becomes
     * a sequential scan over every wallet on every keystroke: the "unindexed
     * filters" failure ARCHITECTURE §5 names, at ~219,000 clients.
     */
    if (filter.q?.trim()) {
      const term = filter.q.trim();
      /*
       * ── ONE BOX, TWO KINDS OF THING, ROUTED BY SHAPE ──────────────────────
       *
       * This screen displays TWO identifiers per row — the owner, in words, and
       * the WALLET NUMBER — and an operator must be able to search for either.
       * The number is what arrives in a support ticket; the name is what the
       * reader has in front of them. A box that matched only one of them is the
       * same defect that started this: an identifier on screen you cannot
       * filter by.
       *
       * ⚠️ ROUTED BY SHAPE RATHER THAN OR-ed, and that is a performance
       * decision, not a style one. The two identifiers live in DIFFERENT TABLES
       * — `users` and `wallets` — and Postgres cannot BitmapOr across a join. An
       * `OR` spanning both would therefore defeat the index on BOTH branches and
       * hash-join every client on every keystroke, which is precisely the
       * failure `test/search-at-scale.spec.ts` exists to catch.
       *
       * A wallet number is twelve characters from a fixed alphabet
       * (`wallets_wallet_number_format`, which excludes i/l/o/u so nothing reads
       * as a digit), so the shape is unambiguous: nothing a person is called
       * matches it. The term is routed to ONE single-table predicate, and both
       * branches are served by an index — `wallets_wallet_number_uq` here, the
       * pg_trgm expression index there.
       *
       * EXACT, not a substring. A partial of a twelve-character random
       * identifier is ambiguous with a name by construction, and a trigram index
       * over it would be answering a question nobody asks: these numbers are
       * pasted from a ticket or a statement, never typed from memory.
       */
      if (WALLET_NUMBER.test(term)) {
        conditions.push(eq(wallets.walletNumber, term.toLowerCase()));
      } else {
        conditions.push(clientIdentitySearch(term));
      }
    }
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
    userId?: number;
    q?: string;
    currency?: string;
    page: number;
    limit: number;
    cursor?: CursorPosition;
    paging?: PageDirection;
    withTotal: boolean;
    sort: WalletSortKey;
    order: SortOrder;
    scope?: ClientScope;
  }) {
    const db = this.db;
    const sortColumn: SQLWrapper = WALLET_SORT_COLUMNS[filter.sort];
    const conditions = this.walletConditions(filter);
    // The order the QUERY walks: the list's own, reversed for Previous / Last.
    const walk = walkOrder(filter.order, filter.paging);
    // The total counts the FILTERED list, never "what follows the cursor".
    const countWhere = conditions.length > 0 ? and(...conditions) : undefined;

    if (filter.cursor) {
      const kind = seekKindFor(filter.sort);
      conditions.push(seekTerms(sortColumn, kind, filter.cursor, wallets.id, walk));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const usingCursor = Boolean(filter.cursor) || filter.page <= 1;
    // Both keys in the SAME direction — a b-tree reads backwards only when every
    // column of the ORDER BY agrees, which is the shape migration 0038 creates.
    const orderBy = walk === 'asc' ? asc : desc;

    const rows = await db
      .select({
        // The raw sort value for the cursor — see `buildCursorPage`. Stripped
        // before the row becomes a response.
        cursorValue: sql<string>`${sortColumn}::text`,
        id: wallets.id,
        walletNumber: wallets.walletNumber,
        // Generated by the database from `currency` and `kind`, so the console
        // reads the same name the portal does rather than composing its own.
        name: wallets.name,
        // Selected as the strings the columns hold. No cast, no aggregate, no
        // arithmetic — §6.1.
        balance: wallets.balance,
        onHold: wallets.onHold,
        currency: wallets.currency,
        // See WalletRowDto.kind — without it a partner shows as two identical
        // same-currency rows and an operator cannot tell which to act on.
        kind: wallets.kind,
        createdAt: wallets.createdAt,
        updatedAt: wallets.updatedAt,
        userId: wallets.userId,
        userPortalId: users.id,
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

    // Counted up to TOTAL_CAP + 1 rows (`cappedTotal`).
    let total: CappedTotal | undefined;
    if (filter.withTotal) {
      const [countRow] = await db.select({ value: sql<number>`count(*)::int` }).from(
        db
          .select({ one: sql`1` })
          .from(wallets)
          .innerJoin(users, eq(wallets.userId, users.id))
          .where(countWhere)
          .limit(TOTAL_CAP + 1)
          .as('counted'),
      );
      total = cappedTotal(countRow.value);
    }

    /*
     * `buildCursorPage` mints the cursor by reading `row[sort]`, so the row it
     * is handed must carry the sort key under THAT NAME. The projection renames
     * the joined client columns to `userEmail`/`userFirstName`, which are the
     * allowlist's keys already — so the rows go in as they are, and the API
     * shaping happens afterwards.
     */
    const paged = buildCursorPage(
      rows,
      filter.limit,
      total,
      filter.sort,
      filter.paging ? { ...filter.paging, fromCursor: Boolean(filter.cursor) } : undefined,
    );

    return {
      items: paged.items.map((r) => ({
        id: r.id,
        walletNumber: r.walletNumber,
        name: r.name,
        // `kind` was selected but never mapped, so the response silently
        // omitted a field WalletRowDto declares — a partner's two same-currency
        // rows were indistinguishable. Fixed alongside walletNumber.
        kind: r.kind,
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
          portalId: r.userPortalId,
          email: r.userEmail,
          firstName: r.userFirstName,
          lastName: r.userLastName,
        },
      })),
      nextCursor: paged.nextCursor,
      prevCursor: paged.prevCursor,
      total: total?.total ?? 0,
      totalCapped: total?.totalCapped ?? false,
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
   * Offset paging rather than a keyset seek, and a SNAPSHOT BOUND is what makes
   * that safe.
   *
   * ⚠️ This used to claim the bound was unnecessary: "a concurrent insert can
   * only add a row at the head this pass has already gone by." Backwards. The
   * ordering is `created_at DESC`, so a new row sorts FIRST and pushes every
   * later row down one — `OFFSET 1000` then points at what was row 999, and the
   * boundary row is written to the file twice.
   *
   * `createdAt <= startedAt` removes the possibility instead of reasoning about
   * it. Same instant on every batch of a run, the way
   * `AdminExportService.transactionBatch` already threads one.
   */
  async walletExportBatch(
    query: { userId?: number; currency?: string },
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
    /** The export run's snapshot instant — the SAME value on every batch. */
    startedAt: Date,
  ) {
    assertActorCan(actor, 'wallets.view', 'export client wallets');

    const conditions = this.walletConditions({ ...query, scope: actor.clientScope });
    // The snapshot bound: rows created after the run began never enter the
    // set, so the offsets cannot shift underneath it.
    conditions.push(lte(wallets.createdAt, startedAt));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return (
      this.db
        .select({
          id: wallets.id,
          walletNumber: wallets.walletNumber,
          name: wallets.name,
          balance: wallets.balance,
          onHold: wallets.onHold,
          currency: wallets.currency,
          kind: wallets.kind,
          createdAt: wallets.createdAt,
          updatedAt: wallets.updatedAt,
          userId: wallets.userId,
          userPortalId: users.id,
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

  /**
   * One client's trading accounts, for the ADM-01 profile card.
   *
   * ## Why this is not `listTradingAccounts` with a userId
   *
   * That one is the directory: paged, sorted, counted, and shaped for a table
   * of every client's accounts. A profile shows the handful belonging to the
   * client already open, so it wants none of that machinery and no page size to
   * be wrong about — a client with more accounts than a page would otherwise
   * see a truncated list with nothing saying so.
   *
   * ## The scope is applied here too, and it is a no-op on the happy path
   *
   * This said "no client scope here, deliberately", arguing that the caller has
   * already resolved the client through `findForAdmin` with the actor's scope,
   * so re-applying it could only produce an empty accounts card for a client the
   * reader was allowed to open.
   *
   * That outcome requires the two checks to DISAGREE, and for a client the
   * reader legitimately opened they agree — the predicate tests the same
   * `userId` against the same territory. So the feared failure could not happen,
   * and what the argument actually bought was a method that is safe only while
   * every caller remembers to pre-check. It has one caller today. The audit
   * flagged it as "safe by caller convention", which is a description of a
   * method waiting for its second caller.
   *
   * Applying it costs nothing on the path that exists and fails closed on the
   * one that does not exist yet.
   */
  async accountsForProfile(userId: number, scope: ClientScope) {
    const scoped = clientScopePredicate(scope, tradingAccounts.userId);
    const owner = eq(tradingAccounts.userId, userId);
    return (
      this.db
        .select({
          id: tradingAccounts.id,
          mt5Login: tradingAccounts.login,
          mt5Group: tradingAccounts.mt5Group,
          environment: tradingAccounts.environment,
          leverage: tradingAccounts.leverage,
          createdAt: tradingAccounts.createdAt,
        })
        .from(tradingAccounts)
        .where(scoped ? and(owner, scoped) : owner)
        // Live before demo, newest first within each: the accounts that hold real
        // money are what an operator opened this card to see.
        .orderBy(asc(tradingAccounts.environment), desc(tradingAccounts.createdAt))
    );
  }

  async listTradingAccounts(
    query: {
      userId?: number;
      referredBy?: number;
      environment?: string;
      status?: string;
      client?: string;
      q?: string;
      page?: string;
      limit?: string;
      cursor?: string;
      /** `prev` / `last` walk backward — `pageDirection`. */
      dir?: string;
      withTotal?: string;
      sort?: string;
      order?: string;
      opened?: DateRange;
    },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'trading.view', 'list client trading accounts');

    const sort = sortKey(
      query.sort,
      TRADING_ACCOUNT_SORT_COLUMNS,
      DEFAULT_TRADING_ACCOUNT_SORT,
      'trading accounts',
    );
    const order = sortOrder(query.order);
    /*
     * The cursor's VALUE is shape-checked against the cast this list will apply.
     *
     * Without it `?sort=balance&cursor=<tampered>` reached `::numeric` and
     * answered 500 with a Postgres cast error. `transactions.service.ts`
     * validated both halves in its own seek; every other keyset list inherited
     * nothing, which is why the check now lives in the shared decoder and the
     * caller only has to name its cast.
     */
    const cursor = query.cursor
      ? decodeCursor(query.cursor, sort, CURSOR_SHAPE[seekKindFor(sort)])
      : undefined;

    /*
     * RBAC-03, applied HERE rather than inside `tradingAccountPage` because the mask is the
     * actor's and the page helper is deliberately actor-free — it decides rows,
     * not fields.
     *
     * These rows carry the client under `user`, the same shape the withdrawal
     * desk uses, and this screen served the email address a role was configured
     * to hide: `applyMask` is opt-in and nothing on this path ever called it.
     * The catalog carried no `tradingAccount.` prefix either, so the call alone would
     * have been a silent no-op — the aliases went in beside it.
     *
     * Found by `test/mask-coverage.spec.ts`, which is what that census is for:
     * two sibling surfaces masked, this one not, and no behavioural test in the
     * repo asserting anything about it.
     */
    const page = await this.tradingAccountPage({
      userId: query.userId,
      referredBy: query.referredBy,
      q: query.q,
      // Checked against the schema's own enum, never cast. `?environment=nonsense`
      // compared against a Postgres enum column surfaces as a 500 carrying a
      // database error; R-2.5 wants a 400 naming what IS allowed.
      environment: enumQuery(query.environment, tradingEnvironmentEnum.enumValues, 'environment'),
      status: enumQuery(query.status, tradingAccountStatusEnum.enumValues, 'status'),
      client: enumQuery(query.client, TRADING_ACCOUNT_CLIENT_FILTERS, 'client'),
      page: Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1),
      limit: pageSize(query.limit),
      cursor,
      paging: twoWayPaging(query),
      withTotal: query.withTotal !== 'false',
      sort,
      order,
      scope: actor.clientScope,
      opened: query.opened,
    });
    /*
     * MT5's holder is a person: a role that may not read a client's first name,
     * last name or email reads no holder name / email either (the shape marks
     * cover one key per field; a full name spans two).
     */
    const hideName =
      actor.fieldMask.includes('client.firstName') || actor.fieldMask.includes('client.lastName');
    const hideEmail = actor.fieldMask.includes('client.email');
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        mt5Holder: item.mt5Holder && {
          name: hideName ? null : item.mt5Holder.name,
          email: hideEmail ? null : item.mt5Holder.email,
        },
      })),
      maskedFields: maskedFieldsFor('tradingAccount', actor.fieldMask),
    };
  }

  private tradingAccountConditions(filter: {
    userId?: number;
    referredBy?: number;
    environment?: string;
    status?: string;
    client?: string;
    q?: string;
    scope?: ClientScope;
    /** When the account was OPENED — `[from, until)`, `common/date-range.ts`. */
    opened?: DateRange;
  }): SQL[] {
    const conditions: SQL[] = [...withinRange(tradingAccounts.createdAt, filter.opened)];
    /*
     * Accounts the MT5 sync found that no client owns (0166, `user_id` NULL).
     * `unassigned` is the operator's queue of accounts to assign.
     */
    if (filter.client === 'unassigned') conditions.push(isNull(tradingAccounts.userId));
    if (filter.client === 'assigned') conditions.push(isNotNull(tradingAccounts.userId));
    if (filter.userId) conditions.push(eq(tradingAccounts.userId, filter.userId));
    /*
     * The accounts of every client ONE PARTNER introduced — the partner
     * profile's Accounts tab (owner, 26 Sep 2026). The same relation the client
     * list's `referredBy` reads (`users.referred_by_ib_user_id`), and scoped by
     * the predicate below like every other filter: a reader sees the introduced
     * clients' accounts that are in their territory, never the rest.
     */
    if (filter.referredBy) {
      conditions.push(
        inArray(
          tradingAccounts.userId,
          this.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.referredByIbUserId, filter.referredBy)),
        ),
      );
    }
    /*
     * The owner or the account, by what the screen shows — see
     * `tradingAccountSearch`.
     *
     * This desk had the same defect as the wallets one and was missed on the
     * first pass: the column displays a named Owner and the only client filter
     * was a uuid the page never prints.
     */
    if (filter.q?.trim()) conditions.push(tradingAccountSearch(filter.q.trim()));
    if (filter.environment) {
      conditions.push(eq(tradingAccounts.environment, filter.environment as 'live'));
    }
    if (filter.status) {
      conditions.push(eq(tradingAccounts.status, filter.status as 'active'));
    }

    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, tradingAccounts.userId);
    if (scoped) {
      /*
       * An account with NO client is outside every territory: it is shown only
       * to a reader who sees every client. Stated rather than left to the
       * predicate — its intake branch is `NOT EXISTS (a tag on this client)`,
       * which is TRUE for a NULL client and would hand every unowned account
       * on the broker's server to each desk admin who sees new clients.
       */
      conditions.push(isNotNull(tradingAccounts.userId));
      conditions.push(scoped);
    }

    return conditions;
  }

  private async tradingAccountPage(filter: {
    userId?: number;
    referredBy?: number;
    q?: string;
    environment?: string;
    status?: string;
    client?: string;
    page: number;
    limit: number;
    cursor?: CursorPosition;
    paging?: PageDirection;
    withTotal: boolean;
    sort: TradingAccountSortKey;
    order: SortOrder;
    scope?: ClientScope;
    opened?: DateRange;
  }) {
    const db = this.db;
    const sortColumn: SQLWrapper = TRADING_ACCOUNT_SORT_COLUMNS[filter.sort];
    const conditions = this.tradingAccountConditions(filter);
    // The order the QUERY walks: the list's own, reversed for Previous / Last.
    const walk = walkOrder(filter.order, filter.paging);
    // The total counts the FILTERED list, never "what follows the cursor".
    const countWhere = conditions.length > 0 ? and(...conditions) : undefined;

    if (filter.cursor) {
      const kind = seekKindFor(filter.sort);
      conditions.push(seekTerms(sortColumn, kind, filter.cursor, tradingAccounts.id, walk));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const usingCursor = Boolean(filter.cursor) || filter.page <= 1;
    const orderBy = walk === 'asc' ? asc : desc;

    /*
     * `login` is the one nullable sort column, so its null placement is PINNED
     * rather than left to Postgres — which defaults to NULLS LAST for ASC and
     * NULLS FIRST for DESC. Without this, flipping the direction silently moves
     * every unassigned account from one end of the list to the other, and
     * "lowest login first" leads with rows that have no login at all.
     */
    const nullsLast = filter.sort === NULLABLE_TRADING_ACCOUNT_SORT;
    // Walking backward mirrors the list exactly, so its nulls come FIRST.
    const primary = nullsLast
      ? filter.paging?.backward
        ? sql`${orderBy(sortColumn)} NULLS FIRST`
        : sql`${orderBy(sortColumn)} NULLS LAST`
      : orderBy(sortColumn);

    const rows = await db
      .select({
        // The raw sort value for the cursor — see `buildCursorPage`.
        cursorValue: sql<string>`${sortColumn}::text`,
        id: tradingAccounts.id,
        login: tradingAccounts.login,
        mt5Group: tradingAccounts.mt5Group,
        environment: tradingAccounts.environment,
        currency: tradingAccounts.currency,
        // A string, straight from NUMERIC(28,8) — see the wallet projection.
        balance: tradingAccounts.balance,
        /*
         * PRODUCT, where `tier` used to be.
         *
         * `trading_accounts.tier` has no writer and never had one, so this key
         * carried NULL on every row of every response — a field that always
         * reads "unknown" teaches an operator that the data is missing rather
         * than that the field is meaningless.
         *
         * `product` is what `tier` was standing in for, and it is answered from
         * the account's own `product_id` first (0080) so it does not change when
         * somebody edits the catalogue.
         */
        product: PRODUCT_NAME,
        /*
         * The AGE of the balance above, travelling with it deliberately.
         *
         * The list reads a MIRROR now rather than calling MT5 once per row. A
         * mirrored number with no age is indistinguishable from a live one,
         * which is worse than either — so this is part of the same projection
         * rather than something a screen might forget to ask for.
         */
        balanceSyncedAt: tradingAccounts.balanceSyncedAt,
        leverage: tradingAccounts.leverage,
        status: tradingAccounts.status,
        createdAt: tradingAccounts.createdAt,
        updatedAt: tradingAccounts.updatedAt,
        userId: tradingAccounts.userId,
        userPortalId: users.id,
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        mt5HolderName: tradingAccounts.mt5HolderName,
        mt5HolderEmail: tradingAccounts.mt5HolderEmail,
      })
      .from(tradingAccounts)
      // LEFT: an account the MT5 sync found with no client yet is listed too (0166).
      .leftJoin(users, eq(tradingAccounts.userId, users.id))
      // Recorded product first, derived second — see `common/account-product`.
      .leftJoin(PRODUCT_BY_ID, eq(PRODUCT_BY_ID.id, tradingAccounts.productId))
      .leftJoin(tradingProductGroups, PRODUCT_GROUP_JOIN_ON)
      .leftJoin(PRODUCT_BY_GROUP, eq(PRODUCT_BY_GROUP.id, tradingProductGroups.productId))
      .where(where)
      .orderBy(primary, orderBy(tradingAccounts.id))
      .limit(filter.limit + 1)
      .offset(usingCursor ? 0 : (filter.page - 1) * filter.limit);

    // Counted up to TOTAL_CAP + 1 rows (`cappedTotal`).
    let total: CappedTotal | undefined;
    if (filter.withTotal) {
      const [countRow] = await db.select({ value: sql<number>`count(*)::int` }).from(
        db
          .select({ one: sql`1` })
          .from(tradingAccounts)
          .leftJoin(users, eq(tradingAccounts.userId, users.id))
          .where(countWhere)
          .limit(TOTAL_CAP + 1)
          .as('counted'),
      );
      total = cappedTotal(countRow.value);
    }

    const paged = buildCursorPage(
      rows,
      filter.limit,
      total,
      filter.sort,
      filter.paging ? { ...filter.paging, fromCursor: Boolean(filter.cursor) } : undefined,
    );

    return {
      items: paged.items.map((r) => ({
        id: r.id,
        login: r.login,
        mt5Group: r.mt5Group,
        environment: r.environment,
        currency: r.currency,
        balance: r.balance,
        product: r.product,
        balanceSyncedAt: r.balanceSyncedAt,
        leverage: r.leverage,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        // NULL: no client owns it yet — the screen offers "Assign" (0166).
        user:
          r.userId === null || r.userPortalId === null
            ? null
            : {
                id: r.userId,
                portalId: r.userPortalId,
                email: r.userEmail ?? '',
                firstName: r.userFirstName ?? '',
                lastName: r.userLastName ?? '',
              },
        mt5Holder:
          r.mt5HolderName || r.mt5HolderEmail
            ? { name: r.mt5HolderName, email: r.mt5HolderEmail }
            : null,
      })),
      nextCursor: paged.nextCursor,
      prevCursor: paged.prevCursor,
      total: total?.total ?? 0,
      totalCapped: total?.totalCapped ?? false,
      page: filter.page,
      limit: filter.limit,
    };
  }

  /** One batch of trading accounts for a CSV export — see `walletExportBatch`. */
  async tradingAccountExportBatch(
    query: {
      userId?: number;
      environment?: string;
      status?: string;
      client?: string;
      opened?: DateRange;
    },
    actor: AuthenticatedAdmin,
    offset: number,
    limit: number,
    /** The export run's snapshot instant — the SAME value on every batch. */
    startedAt: Date,
  ) {
    assertActorCan(actor, 'trading.view', 'export client trading accounts');

    const conditions = this.tradingAccountConditions({ ...query, scope: actor.clientScope });
    // The snapshot bound: rows created after the run began never enter the
    // set, so the offsets cannot shift underneath it.
    conditions.push(lte(tradingAccounts.createdAt, startedAt));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return (
      this.db
        .select({
          id: tradingAccounts.id,
          login: tradingAccounts.login,
          mt5Group: tradingAccounts.mt5Group,
          environment: tradingAccounts.environment,
          currency: tradingAccounts.currency,
          balance: tradingAccounts.balance,
          /*
           * PRODUCT, where `tier` used to be.
           *
           * `trading_accounts.tier` has no writer and never had one, so this key
           * carried NULL on every row of every response — a field that always
           * reads "unknown" teaches an operator that the data is missing rather
           * than that the field is meaningless.
           *
           * `product` is what `tier` was standing in for, and it is answered from
           * the account's own `product_id` first (0080) so it does not change when
           * somebody edits the catalogue.
           */
          product: PRODUCT_NAME,
          // As above: an exported balance without its age invites somebody to
          // reconcile a spreadsheet against a figure of unknown vintage.
          balanceSyncedAt: tradingAccounts.balanceSyncedAt,
          leverage: tradingAccounts.leverage,
          status: tradingAccounts.status,
          createdAt: tradingAccounts.createdAt,
          updatedAt: tradingAccounts.updatedAt,
          userId: tradingAccounts.userId,
          userPortalId: users.id,
          userEmail: users.email,
          userFirstName: users.firstName,
          userLastName: users.lastName,
          mt5HolderName: tradingAccounts.mt5HolderName,
          mt5HolderEmail: tradingAccounts.mt5HolderEmail,
        })
        .from(tradingAccounts)
        // LEFT, like the list: an account with no client exports with blank owner columns.
        .leftJoin(users, eq(tradingAccounts.userId, users.id))
        // Recorded product first, derived second — see `common/account-product`.
        .leftJoin(PRODUCT_BY_ID, eq(PRODUCT_BY_ID.id, tradingAccounts.productId))
        .leftJoin(tradingProductGroups, PRODUCT_GROUP_JOIN_ON)
        .leftJoin(PRODUCT_BY_GROUP, eq(PRODUCT_BY_GROUP.id, tradingProductGroups.productId))
        .where(where)
        .orderBy(desc(tradingAccounts.createdAt), desc(tradingAccounts.id))
        .limit(limit)
        .offset(offset)
    );
  }

  // ── One client's trading activity ─────────────────────────────────────────

  /**
   * A client's CLOSED positions — the profile's Positions tab, on every client
   * type.
   *
   * ## From the ingested deals, not the `positions` table
   *
   * This read `positions`, which nothing on the live path writes: MT5 delivers
   * DEALS, and the bridge's feed lands them in `mt5_deals`. So the tab showed
   * "No closed positions yet." for clients with hundreds of closed trades. It
   * now reads the same rows the portal's account history and the commission
   * engine read, so all three agree.
   *
   * One row per CLOSING deal — the deal that carries the realised result, the
   * definition `isRealisedTrade` gives and the portal uses. Its opening deal
   * (same login and MT5 position id, `ENTRY_IN`) supplies the open price, the
   * open time and the side; it may be missing when the trade was opened before
   * this CRM ingested anything, and those fields are then null rather than
   * guessed — except the side, which is the reverse of the closing deal's.
   *
   * Open positions are not listed here (owner, 26 Sep 2026): the tab shows
   * closed trades only.
   *
   * ## Commission is the whole trade's
   *
   * MT5 may charge on the opening deal, the closing deal or both, depending on
   * the group's rule. The row carries the SUM of the two, so a $3 charge taken
   * when the trade opened is not lost from the trade that paid it.
   */
  async listClientClosedPositions(filter: {
    userId: number;
    page?: string | number;
    limit?: string | number;
    /** Keyset position from a previous page — `nextCursor` / `prevCursor`. */
    cursor?: string;
    /** `prev` / `last` walk backward — `pageDirection`. */
    dir?: string;
    scope?: ClientScope;
  }) {
    // Visibility first, so an out-of-scope client is a 404 like every sibling.
    await this.visibility.assertVisible(filter.userId, filter.scope ?? UNRESTRICTED);

    const limit = pageSize(filter.limit);
    const rawPage = filter.page === undefined ? undefined : String(filter.page);
    const paging = twoWayPaging({ page: rawPage, cursor: filter.cursor, dir: filter.dir });
    // The legacy offset caller (an older console) still pages by number.
    const page = paging ? 1 : Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1);
    const offset = (page - 1) * limit;
    const cursor = filter.cursor
      ? decodeCursor(filter.cursor, 'closedAt', 'timestamptz')
      : undefined;
    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, tradingAccounts.userId);

    // The client's MT5 accounts — what a deal names (by LOGIN, see `historyMine`).
    const accounts = await this.db
      .select({
        login: tradingAccounts.login,
        currency: tradingAccounts.currency,
        environment: tradingAccounts.environment,
      })
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.userId, filter.userId),
          isNotNull(tradingAccounts.login),
          ...(scoped ? [scoped] : []),
        ),
      );
    const accountOf = new Map(accounts.map((a) => [a.login as string, a]));
    const logins = [...accountOf.keys()];
    if (logins.length === 0) {
      return {
        rows: [],
        total: 0,
        totalCapped: false,
        nextCursor: null,
        prevCursor: null,
        page,
        limit,
      };
    }

    /*
     * ONE INDEX WALK PER LOGIN, merged (9 Oct 2026). A client trades on several
     * MT5 accounts, and no single index orders their deals across all of them —
     * so the page used to sort every closing deal the client ever made. Each
     * login now reads `(login, dealt_at, id)` (0214) newest-first, at most one
     * page's worth, and the handful of streams are merged: a heavy trader with a
     * million deals costs the same as a new one.
     */
    const backward = Boolean(paging?.backward);
    const order = backward ? sql`ASC` : sql`DESC`;
    const seek = cursor
      ? sql`AND (d.dealt_at, d.id) ${backward ? sql`>` : sql`<`} (${cursor.value}::timestamptz, ${cursor.id}::uuid)`
      : sql``;
    const closingOnly = sql`d.action IN (${sql.join(
      TRADE_ACTIONS.map((a) => sql`${a}`),
      sql`, `,
    )}) AND d.entry IN (${sql.join(
      CLOSING_ENTRIES.map((e) => sql`${e}`),
      sql`, `,
    )})`;
    const loginList = sql`ARRAY[${sql.join(
      logins.map((l) => sql`${l}`),
      sql`, `,
    )}]::varchar[]`;

    const [page_, counted] = await Promise.all([
      this.db.execute(sql`
        SELECT p.* FROM unnest(${loginList}) AS l(login)
        CROSS JOIN LATERAL (
          SELECT d.id, d.mt5_deal_id AS ticket, d.mt5_position_id AS position_id, d.login,
                 d.symbol, d.action, d.volume, d.price AS close_price, d.profit,
                 d.commission, d.swap, d.dealt_at AS closed_at,
                 d.dealt_at::text AS cursor_value
          FROM mt5_deals d
          WHERE d.login = l.login AND ${closingOnly} ${seek}
          ORDER BY d.dealt_at ${order}, d.id ${order}
          LIMIT ${offset + limit + 1}
        ) p
        ORDER BY p.closed_at ${order}, p.id ${order}
        LIMIT ${limit + 1} OFFSET ${offset}`),
      // Counted up to TOTAL_CAP + 1 rows (`cappedTotal`), per login and overall.
      this.db.execute(sql`
        SELECT count(*)::int AS value FROM (
          SELECT 1 FROM unnest(${loginList}) AS l(login)
          CROSS JOIN LATERAL (
            SELECT 1 FROM mt5_deals d
            WHERE d.login = l.login AND ${closingOnly}
            LIMIT ${TOTAL_CAP + 1}
          ) one
          LIMIT ${TOTAL_CAP + 1}
        ) counted`),
    ]);

    type DealRow = {
      id: string;
      ticket: string;
      position_id: string | null;
      login: string;
      symbol: string;
      action: number;
      volume: string;
      close_price: string;
      profit: string;
      commission: string;
      swap: string;
      closed_at: string;
      cursor_value: string;
    };
    const total = cappedTotal((counted.rows[0] as { value: number }).value);
    const paged = buildCursorPage(
      (page_.rows as DealRow[]).map((row) => ({
        id: row.id,
        createdAt: row.closed_at,
        closedAt: row.closed_at,
        cursorValue: row.cursor_value,
        row,
      })),
      limit,
      total,
      'closedAt',
      paging ? { ...paging, fromCursor: Boolean(filter.cursor) } : undefined,
    );
    const closing = paged.items.map(({ row }) => {
      const account = accountOf.get(row.login);
      return {
        id: row.id,
        ticket: row.ticket,
        positionId: row.position_id,
        login: row.login,
        symbol: row.symbol,
        action: row.action,
        volume: row.volume,
        closePrice: row.close_price,
        profit: row.profit,
        commission: row.commission,
        swap: row.swap,
        closedAt: new Date(row.closed_at),
        currency: account?.currency ?? '',
        environment: account?.environment ?? 'live',
      };
    });

    /*
     * The opening deals for THIS page, in one query. Matched in memory on
     * login + position id: a position id is unique per MT5 server, and the
     * login pins it to the account the closing deal named.
     */
    const positionIds = [
      ...new Set(closing.map((row) => row.positionId).filter((id): id is string => Boolean(id))),
    ];
    const opening =
      positionIds.length === 0
        ? []
        : await this.db
            .select({
              login: mt5Deals.login,
              positionId: mt5Deals.mt5PositionId,
              action: mt5Deals.action,
              price: mt5Deals.price,
              commission: mt5Deals.commission,
              dealtAt: mt5Deals.dealtAt,
            })
            .from(mt5Deals)
            .where(
              and(
                // With the login, `(login, mt5_position_id)` serves this lookup;
                // a position id alone is unique only per MT5 server.
                inArray(mt5Deals.login, logins),
                inArray(mt5Deals.mt5PositionId, positionIds),
                eq(mt5Deals.entry, ENTRY_IN),
                inArray(mt5Deals.action, [...TRADE_ACTIONS]),
              ),
            )
            .orderBy(asc(mt5Deals.dealtAt));

    const openedBy = new Map<string, (typeof opening)[number]>();
    for (const deal of opening) {
      const key = `${deal.login}:${deal.positionId}`;
      // The EARLIEST opening deal is the position's open.
      if (!openedBy.has(key)) openedBy.set(key, deal);
    }

    const rows = closing.map((row) => {
      const opened = row.positionId ? openedBy.get(`${row.login}:${row.positionId}`) : undefined;
      /*
       * The POSITION's side. A buy is closed by a sell deal and a sell by a
       * buy, so without the opening deal the side is the closing deal's
       * reversed — never the closing deal's own, which would label every
       * closed buy a sell.
       */
      const side = opened
        ? dealSide(opened.action)
        : dealSide(row.action) === 'buy'
          ? 'sell'
          : 'buy';
      return {
        id: row.id,
        ticket: row.ticket,
        positionId: row.positionId,
        login: row.login,
        environment: row.environment,
        symbol: row.symbol,
        side,
        volume: row.volume,
        openPrice: opened?.price ?? null,
        closePrice: row.closePrice,
        profit: row.profit,
        commission: opened
          ? new Decimal(row.commission).plus(opened.commission).toFixed(8)
          : row.commission,
        swap: row.swap,
        currency: row.currency,
        openedAt: opened?.dealtAt ?? null,
        closedAt: row.closedAt,
      };
    });

    return {
      rows,
      total: total.total,
      totalCapped: total.totalCapped,
      nextCursor: paged.nextCursor,
      prevCursor: paged.prevCursor ?? null,
      page,
      limit,
    };
  }

  /**
   * A client's TRANSACTIONS — every movement of their money, newest first.
   *
   * Deliberately unfiltered by direction: deposits, withdrawals and transfers
   * are one history from the operator's side, and splitting them across three
   * requests would make "what happened to this client's balance" a question
   * answered by reading three lists in parallel and merging them by eye.
   */
  async listClientTransactions(filter: {
    userId: number;
    page?: string | number;
    limit?: string | number;
    /** Keyset position from a previous page — `nextCursor` / `prevCursor`. */
    cursor?: string;
    /** `prev` / `last` walk backward — `pageDirection`. */
    dir?: string;
    scope?: ClientScope;
  }) {
    /*
     * VISIBILITY FIRST, so an out-of-scope client is a 404 like every sibling.
     *
     * The predicate below already protects the DATA — it is in the WHERE clause
     * and always was — so this is not closing a leak. It is closing the gap
     * between "you may not see this client" and "this client has nothing",
     * which the scoped query alone reports identically. That collapse is the one
     * `lib/masking.ts` exists to prevent on the frontend, and it is how an
     * operator ends up reasoning from an emptiness that was never real.
     *
     * No oracle either way: a client id that names nobody answered 200 with an
     * empty list before this and answers 404 now, exactly as an out-of-scope one
     * does. Found by the by-id census in `client-scope-enforcement.spec.ts`,
     * which drove these two for the first time.
     */
    await this.visibility.assertVisible(filter.userId, filter.scope ?? UNRESTRICTED);

    const rawPage = filter.page === undefined ? undefined : String(filter.page);
    const paging = twoWayPaging({ page: rawPage, cursor: filter.cursor, dir: filter.dir });
    // The legacy offset caller (an older console) still pages by number.
    const page = paging ? 1 : Math.max(1, Number.parseInt(rawPage ?? '1', 10) || 1);
    const limit = pageSize(filter.limit);
    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, transactions.userId);
    const cursor = filter.cursor
      ? decodeCursor(filter.cursor, 'createdAt', 'timestamptz')
      : undefined;
    // Newest first through `(user_id, created_at, id)`; Previous / Last walk it backward.
    const walk = walkOrder('desc', paging);

    const where = and(eq(transactions.userId, filter.userId), ...(scoped ? [scoped] : []));
    const pageWhere = cursor
      ? and(
          where,
          keysetSeek(transactions.createdAt, transactions.id, cursor, walk, 'timestamptz', 'uuid'),
        )
      : where;

    const rows = await this.db
      .select({
        id: transactions.id,
        direction: transactions.direction,
        state: transactions.state,
        /* §6.1 — a decimal STRING all the way to the screen. */
        amount: transactions.amount,
        currency: transactions.currency,
        methodKey: transactions.methodKey,
        /*
         * The method's NAME — "Whish Money", not `whish` (owner, 26 Sep 2026).
         * A deposit names its payment method and a withdrawal its payout method;
         * they live in different tables and one row can match only one of them,
         * the same coalesce the transactions desk uses. Null for money that went
         * through no method (a manual credit), which the screen names from
         * `provider`.
         */
        methodName: sql<
          string | null
        >`coalesce(${paymentMethods.internalLabel}, ${paymentMethods.name}, ${withdrawalPaymentMethods.internalLabel}, ${withdrawalPaymentMethods.name})`,
        provider: transactions.provider,
        providerRef: transactions.providerRef,
        createdAt: transactions.createdAt,
        settledAt: transactions.settledAt,
        // The sort value as text, for the cursor (microseconds intact).
        cursorValue: sql<string>`${transactions.createdAt}::text`,
      })
      .from(transactions)
      .leftJoin(paymentMethods, eq(paymentMethods.key, transactions.methodKey))
      .leftJoin(
        withdrawalPaymentMethods,
        eq(withdrawalPaymentMethods.key, transactions.withdrawalMethodKey),
      )
      .where(pageWhere)
      .orderBy(
        ...(walk === 'asc'
          ? [asc(transactions.createdAt), asc(transactions.id)]
          : [desc(transactions.createdAt), desc(transactions.id)]),
      )
      // One extra row answers "is there more" with no second query.
      .limit(limit + 1)
      .offset((page - 1) * limit);
    const paged = wrapPage(
      rows,
      (row) => row.id,
      limit,
      'createdAt',
      paging ? { ...paging, fromCursor: Boolean(filter.cursor) } : undefined,
    );

    // Counted up to TOTAL_CAP + 1 rows (`cappedTotal`).
    const [{ value: counted = 0 } = {}] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(
        this.db
          .select({ one: sql`1` })
          .from(transactions)
          .where(where)
          .limit(TOTAL_CAP + 1)
          .as('counted'),
      );
    const total = cappedTotal(counted);

    return {
      rows: paged.rows,
      total: total.total,
      totalCapped: total.totalCapped,
      nextCursor: paged.nextCursor,
      prevCursor: paged.prevCursor,
      page,
      limit,
    };
  }
}
