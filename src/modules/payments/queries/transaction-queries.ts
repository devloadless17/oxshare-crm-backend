import { type ProofDetail } from '../../../common/payments/proof-fields';
import { type PayToDetail } from '../../../common/payments/pay-to-fields';
import { and, asc, desc, eq, sql, type SQL, type SQLWrapper, lte } from 'drizzle-orm';
import {
  paymentProviders,
  transactionDirectionEnum,
  transactions,
  transactionStateEnum,
  users,
  withdrawalPaymentMethods,
} from '../../../database/schema';
import type { ListTransactionsQueryDto } from '../dto/transaction-query.dto';
import { clientIdentitySearch } from '../../../store/users.store';
import type { TransactionView } from '../transaction-view';
import { money } from '../../wallet/money';
import { buildCursorPage, pageSize, type CursorPosition } from '../../../common/pagination';
import {
  type DateRange,
  dateRangeQuery,
  isUtcDayAligned,
  utcDate,
  withinRange,
} from '../../../common/date-range';
import type { SortOrder } from '../../../common/sorting';
import { sortKey, sortOrder } from '../../../common/sorting';
import type { Db } from '../../../database/db';
import { PaymentProviderRegistry } from '../providers/payment-provider-registry';
import { ValidationError } from '../../../common/errors/domain-errors';
import { rebateNameArabic } from '../../../common/i18n/reason-arabic';
import {
  clientScopePredicate,
  UNRESTRICTED,
  type ClientScope,
} from '../../../common/security/client-scope';

/** The stored row, as every read here returns it. */
type TransactionRow = typeof transactions.$inferSelect;

/**
 * What a movement IS, when the list holds more than one kind of them.
 *
 * `payment` is a row in `transactions` — a deposit or a withdrawal. `transfer`
 * is a row in `transfers`, wallet ⇄ trading account. `commission_transfer` is a
 * row in `ib_wallet_transfers`, a partner moving earnings from their commission
 * wallet into their main one. They share one list because they are one history
 * to the person reading it, and they are separate tables because each has
 * something the others do not — a provider, a bridge confirmation, or neither.
 *
 * ## `commission_transfer` is its own kind rather than another `transfer`
 *
 * Both are internal moves, so folding them together is tempting. They answer
 * different questions: a `transfer` changes how much of a client's money is
 * available to TRADE, and a `commission_transfer` changes how much of a
 * partner's money is available to WITHDRAW. A screen that printed one label for
 * both would tell a partner their earnings had gone to a trading account.
 *
 * A renderer branches on THIS, never on the absence of a payment field: a
 * transfer has no method, no provider and no destination — but "the method is
 * null" is also true of a manual admin credit.
 */
export type MovementKind = 'payment' | 'transfer' | 'commission_transfer';

/**
 * The kind values as a runtime list, for validating `?kind=` at the edge.
 *
 * `MovementKind` is a type and erases at runtime; this is its one runtime
 * mirror, and `satisfies` is what keeps the two from drifting — add a kind to
 * either and the compiler demands the other. NOT a pgEnum's `.enumValues`:
 * `kind` is the union's own vocabulary, stated in SQL below, and exists in no
 * table.
 */
export const TRANSACTION_KINDS = [
  'payment',
  'transfer',
  'commission_transfer',
] as const satisfies readonly MovementKind[];

/**
 * One row of a client's money history, from either table.
 *
 * Every payment field is null on a transfer; the two fields at the bottom are
 * what tell the two apart.
 */
export type TransactionListRow = TransactionView & {
  /** Resolved server-side so a client and an operator read the same words. */
  methodName: string | null;
  /** The method's Arabic name (0179); null when untranslated or no method. */
  methodNameAr: string | null;
  kind: MovementKind;
  /** The trading account a TRANSFER moved money to or from. Null on a payment. */
  tradingAccountId: string | null;
};

/** The union's own column names, before they are mapped to the DTO's. */
interface CombinedRow {
  id: string;
  user_id: number;
  wallet_id: string;
  direction: TransactionRow['direction'];
  amount: string;
  currency: string;
  state: TransactionRow['state'];
  method_key: string | null;
  withdrawal_method_key: string | null;
  provider: string;
  provider_ref: string | null;
  destination: string | null;
  destination_trading_account_id: string | null;
  proof_filename: string | null;
  /** The client's answers to an offline method's details (0163). */
  proof_details: ProofDetail[] | null;
  /** What an offline method showed the client at filing (0199). */
  pay_to_details: PayToDetail[] | null;
  rejection_reason: string | null;
  /** Its Arabic, written with it (0179). A transfer's `failure_reason_ar`. */
  rejection_reason_ar: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  settled_at: string | null;
  /* The payments core's neutral columns (0173), in the union's positions. */
  provider_payment_id: string | null;
  provider_payout_id: string | null;
  provider_submitted_at: string | null;
  needs_attention: boolean;
  attention_reason: string | null;
  provider_note: string | null;
  created_at: string;
  /** Selected by `methodNamesOf`, for the rows a read shows. */
  method_name: string | null;
  /** The method's Arabic name (0179). CLIENT reads only. */
  method_name_ar?: string | null;
  /** The desk's label, falling back to the name (0161). ADMIN reads only. */
  method_label?: string | null;
  kind: MovementKind;
  trading_account_id: string | null;
}

/** The admin Financial list's raw rows: the union's columns plus the client. */
interface AdminCombinedRow extends CombinedRow {
  user_email: string;
  user_first_name: string;
  user_portal_id: number;
  user_last_name: string;
}

/** The union's direction vocabulary — wallet-side, for every kind. */
export type MovementDirection = (typeof transactionDirectionEnum.enumValues)[number];
/** The union's state vocabulary — transfer states arrive pre-mapped into it. */
export type MovementState = (typeof transactionStateEnum.enumValues)[number];

/**
 * The filters every admin read of the union shares — the list, its counts, the
 * summary and the CSV export all build their predicates from THIS shape, so a
 * row the list hides cannot appear in a count, a tile or a file.
 *
 * The vocabulary fields are the UNIONS, not `string` — this service is what a
 * queued job would call (R-4.3), and an in-process caller passing the transfer
 * table's own pre-mapping vocabulary (`state: 'settled'`) would otherwise get
 * a silently empty list rather than a compile error. The HTTP edge narrows to
 * these same unions via `enumQuery`.
 */
export interface AdminMovementsFilter {
  /**
   * Row-level visibility — REQUIRED, never defaulted. Every one of these
   * reads spans the whole platform's money, so a caller must SAY it is
   * unrestricted (`UNRESTRICTED`) rather than become so by forgetting an
   * argument. A queued report that omits scope is a compile error here, not a
   * territory leak found by a scoped operator months later.
   */
  scope: ClientScope;
  /** Narrow to one client — already validated as a UUID at the edge. */
  userId?: number;
  direction?: MovementDirection;
  kind?: MovementKind;
  state?: MovementState;
  currency?: string;
  /** Free text over the client's email and name — see `listForAdmin.q`. */
  q?: string;
  /** `[from, until)` instants — `common/date-range.ts`. */
  from?: Date;
  until?: Date;
  /**
   * Only payments a PERSON must reconcile (`needs_attention`, 0173) — where an
   * attention task's link lands, and the desk's "what is flagged" view. The
   * transfer arms carry no flag, so they never match.
   */
  attention?: boolean;
  /**
   * Only movements a PERSON decides (0168): deposits on a route the desk
   * confirms (paid outside the platform) and every withdrawal. What the
   * deposits desk lists — a deposit on a provider's hosted page is settled by
   * the provider, and offering Approve on it only earned a refusal.
   */
  deskDecided?: boolean;
  /**
   * Only movements through these payment methods (their keys, deposit or
   * withdrawal) — the buyer's "a payment method is the most important field".
   * Only a payment has a method, so the transfer arms never match.
   */
  methods?: string[];
  /**
   * One movement by its row uuid — where a notification's link lands: a
   * payment's `transactions.id`, a transfer's `transfers.id`. Applied inside
   * EACH arm beside the scope, so an out-of-scope id is simply no row.
   */
  id?: string;
}

/**
 * One table of the money union, as `movementsCte`'s `armWhere` sees it: the
 * columns a caller's WHERE needs, named for THIS table, so every condition is
 * written against the table's own indexed columns rather than the union's output
 * (which no index can serve).
 */
interface MovementArm {
  /** The client who owns the movement. */
  owner: SQL;
  /** The movement's own id. */
  id: SQL;
  /** True for `transactions` — the one table a deposit's evidence lives in. */
  payments: boolean;
  /**
   * `(direction, provider_code, channel_code)` on the payments arm (0168): the
   * route a movement took, for filters that ask who settles it. Null on the arms
   * that carry no route.
   */
  route: SQL | null;
  /** The payments arm's two method-key columns (deposit, withdrawal); absent elsewhere. */
  methodKeys?: [SQL, SQL];
}

/**
 * Which stored TOTALS (migration 0165) can answer this filter's counts and
 * summary — or none, and the live rows must.
 *
 *  - `daily` — per UTC day × kind × direction × state × currency: a reader who
 *    sees every client, whatever the tabs, currency and dates.
 *  - `client` — per client × the same four: a desk admin's territory, or one
 *    client, with any tabs and currency but no dates (these totals have no day).
 *  - neither — a search (it matches MOVEMENTS, a deposit's evidence among them,
 *    not only clients), the attention flag (a column no total keeps), or a
 *    territory narrowed by dates. Each of those reads an index narrowed to its
 *    own rows instead (see `adminMovements`).
 */
export function movementTotalsSource(filter: AdminMovementsFilter): 'daily' | 'client' | undefined {
  // One record (`id`) is a live read — no total is kept per row.
  // No total is kept per method either.
  if (filter.q?.trim() || filter.attention || filter.deskDecided || filter.id) return undefined;
  if (filter.methods?.length) return undefined;
  /*
   * The daily totals are UTC days: they answer a period only when it starts and
   * ends on UTC midnights. A viewer's own "today" in Beirut does not, so it reads
   * the live rows — narrowed by the range to a few, through the created_at index.
   */
  if (filter.scope.unrestricted && filter.userId === undefined) {
    return isUtcDayAligned(filter) ? 'daily' : undefined;
  }
  if (!filter.from && !filter.until) return 'client';
  return undefined;
}

/**
 * The facets and the summary, from the totals `movementTotalsSource` names: the
 * compact table plus the deltas not yet folded into it, in ONE statement — so
 * it reads one snapshot of both and is exact at every instant, folded or not
 * (0165's header). A desk admin's territory is applied to the per-client totals
 * by the same predicate every live read uses.
 *
 * `state` / `direction` return `{state|direction, value}` rows with that axis's
 * own filter left out, exactly as the live facets do; `summary` returns the live
 * summary's shape (`GROUPING SETS`), `value` a count and `total` a decimal STRING
 * (§6.1). Buckets that net to nothing are dropped, as the live query never has them.
 */
export function movementTotalsQuery(
  filter: AdminMovementsFilter,
  shape: 'state' | 'direction' | 'summary',
): SQL {
  const totals = movementTotalsSource(filter);
  if (!totals) throw new Error('movementTotalsQuery: no stored totals answer this filter');
  const conditions: SQL[] = [];
  if (filter.kind) conditions.push(sql`kind = ${filter.kind}`);
  if (filter.currency) conditions.push(sql`currency = ${filter.currency}`);
  if (shape !== 'direction' && filter.direction) {
    conditions.push(sql`direction = ${filter.direction}`);
  }
  if (shape !== 'state' && filter.state) conditions.push(sql`state = ${filter.state}`);
  if (totals === 'daily') {
    if (filter.from) conditions.push(sql`day >= ${utcDate(filter.from)}::date`);
    if (filter.until) conditions.push(sql`day < ${utcDate(filter.until)}::date`);
  } else {
    const scoped = clientScopePredicate(filter.scope, sql`m.user_id`);
    if (scoped) conditions.push(scoped);
    if (filter.userId !== undefined) conditions.push(sql`m.user_id = ${filter.userId}::integer`);
  }
  const where = conditions.length ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  const key = totals === 'daily' ? sql`day` : sql`user_id`;
  const table = totals === 'daily' ? sql`movement_daily_totals` : sql`movement_client_totals`;
  const source = sql`
    WITH m AS (
      SELECT ${key}, kind, direction, state, currency, count, total FROM ${table}
      UNION ALL
      SELECT ${key}, kind, direction, state, currency, count, total FROM movement_total_deltas
    )`;
  if (shape === 'summary') {
    return sql`${source}
      SELECT direction, kind, state, currency,
             sum(count)::int AS value, sum(total)::text AS total
        FROM m${where}
       GROUP BY GROUPING SETS ((direction, kind, state, currency), (direction, currency))
      HAVING sum(count) <> 0
       ORDER BY direction, kind NULLS LAST, state, currency`;
  }
  const axis = shape === 'state' ? sql`state` : sql`direction`;
  return sql`${source}
    SELECT ${axis}, sum(count)::int AS value FROM m${where}
     GROUP BY ${axis} HAVING sum(count) <> 0`;
}

/** One row of the Financial CSV export — flattened, the amount a STRING. */
export interface AdminTransactionExportRow {
  id: string;
  kind: MovementKind;
  direction: string;
  state: string;
  amount: string;
  currency: string;
  methodName: string;
  provider: string;
  providerRef: string | null;
  /** The payment provider's own id for the movement (0173's neutral column). */
  providerPaymentId: string | null;
  destination: string | null;
  /** What the client gave to identify an offline payment (0163). */
  proofDetails: ProofDetail[] | null;
  /** Where the client was told to send an offline deposit, as shown at filing (0199). */
  payToDetails: PayToDetail[] | null;
  rejectionReason: string | null;
  userId: number;
  userPortalId: number;
  userEmail: string;
  userFirstName: string;
  userLastName: string;
  createdAt: Date;
  settledAt: Date | null;
  /**
   * The row's `created_at` as the raw Postgres literal, microseconds intact —
   * the keyset position the NEXT batch seeks from. Deliberately not the `Date`
   * above: a JS Date truncates to milliseconds, and a truncated boundary is
   * exactly how a keyset skips the rows sharing the boundary's millisecond.
   * Not a CSV column; the export's column list never reads it.
   */
  cursorCreatedAt: string;
}

/**
 * Every timestamp above is a STRING, and that is not a typo.
 *
 * `db.execute(sql\`…\`)` runs raw SQL, so none of drizzle's column mappers
 * apply — a `timestamptz` arrives as the Postgres literal
 * `2026-08-14 16:20:59.660801+00` rather than a `Date`. The fields were
 * previously declared `Date` and the rows cast with `as unknown as`, which is
 * precisely the cast that stops the compiler from noticing the difference.
 *
 * Parsing here rather than passing the string through is what keeps the wire
 * format uniform: `JSON.stringify` turns a Date into ISO 8601, which is what
 * every other endpoint in this API returns and what both frontends parse. That
 * literal is NOT ISO — its space separator and six-digit fraction are accepted
 * by V8's lenient parser but are implementation-defined elsewhere, so shipping
 * it would hand Safari and Firefox a value `new Date()` can reject outright.
 *
 * Node parses the literal correctly (verified); the equivalent-looking
 * `replace(' ', 'T')` does NOT — a 'T' commits V8 to strict ISO, which allows
 * no more than three fractional digits. Leave the string exactly as Postgres
 * wrote it.
 */
const instantOf = (value: string): Date => new Date(value);
const instantOrNull = (value: string | null): Date | null =>
  value === null ? null : instantOf(value);

/**
 * A movement's method NAME — looked up for the rows a read SHOWS, after the
 * page is cut, never inside the union (29 Sep 2026).
 *
 * ONE name for both rails: a deposit names its method through `method_key`, a
 * withdrawal through `withdrawal_method_key` into a DIFFERENT table — one row
 * can never match both, so the coalesce is unambiguous rather than a guess
 * about precedence. A rebate states its own (`arm_method_name`); a transfer has
 * none.
 *
 * Inside the union the lookup ran for every movement a query touched: as joins
 * it stopped each arm being read in index order (every page sorted the whole
 * table), and as per-row subqueries it ran for every row a search or sort then
 * discarded — ~0.9 s for a search matching every client, to show 26 rows. Here
 * it runs once per row shown.
 *
 * `desk` adds the DESK's name (0161, `method_label`): admin reads select it,
 * the client's never do. The client's read adds the Arabic name instead
 * (0179, `method_name_ar`) — null when untranslated, so the portal falls back to
 * `method_name`; a rebate's name is the portal's own string (keyed off `kind`).
 */
function methodNamesOf(row: 'page' | 'combined', desk: boolean): SQL {
  const r = sql.raw(row);
  const name = sql`COALESCE(
      (SELECT pm.name FROM payment_methods pm WHERE pm.key = ${r}.method_key),
      (SELECT wpm.name FROM withdrawal_payment_methods wpm
        WHERE wpm.key = ${r}.withdrawal_method_key),
      ${r}.arm_method_name
    ) AS method_name`;
  if (!desk) {
    return sql`${name},
    COALESCE(
      (SELECT pm.name_ar FROM payment_methods pm WHERE pm.key = ${r}.method_key),
      (SELECT wpm.name_ar FROM withdrawal_payment_methods wpm
        WHERE wpm.key = ${r}.withdrawal_method_key)
    ) AS method_name_ar`;
  }
  return sql`${name},
    COALESCE(
      (SELECT coalesce(pm.internal_label, pm.name) FROM payment_methods pm
        WHERE pm.key = ${r}.method_key),
      (SELECT coalesce(wpm.internal_label, wpm.name) FROM withdrawal_payment_methods wpm
        WHERE wpm.key = ${r}.withdrawal_method_key)
    ) AS method_label`;
}

/**
 * The scalar mappings the admin Financial list and its CSV export SHARE — one
 * definition, so the screen and the file cannot describe the same row
 * differently (a `methodName` fallback fixed in one copy and not the other is
 * the discrepancy a reconciling auditor escalates). The list nests the client
 * under `user` on top of this; the export flattens the client beside it.
 */
/**
 * The deposit desk's half of the admin search (0163): the details a client
 * filed with an offline deposit — the phone it was sent from, a transfer code —
 * and the deposit's own `OX-` reference.
 *
 * Folded to lower-case letters and digits on both sides, so "70 123 456" finds
 * +96170123456 and "ab-12" finds AB12, through the partial trigram index on
 * `deposit_details_search(proof_details)`. Matched as a set of transaction ids
 * rather than a column of the union, so each half keeps its own index and the
 * identity search beside it is unchanged. `undefined` when the query cannot
 * name either (under three letters or digits, and not a reference).
 */
function depositEvidenceSearch(q: string): SQL | undefined {
  const folded = q.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches: SQL[] = [];
  if (folded.length >= 3) {
    // `folded` is [a-z0-9] only, so it carries no LIKE wildcard of its own.
    matches.push(sql`
      SELECT ev.id FROM transactions ev
      WHERE ev.proof_details IS NOT NULL
        AND deposit_details_search(ev.proof_details) LIKE ${`%${folded}%`}`);
  }
  if (/^ox-[0-9a-z]{6}$/i.test(q)) {
    matches.push(sql`SELECT ev.id FROM transactions ev WHERE ev.provider_ref = ${q.toUpperCase()}`);
  }
  if (matches.length === 0) return undefined;
  return sql.join(matches, sql` UNION `);
}

function toMovementRow(row: AdminCombinedRow) {
  return {
    id: row.id,
    kind: row.kind,
    direction: row.direction,
    state: row.state,
    amount: money(row.amount), // money crosses the boundary as a string (§6.1)
    currency: row.currency,
    /*
     * The rail's display name, falling back to `provider` — the queue's own
     * rule. For the two transfer kinds the union names no method, so the
     * fallback is their stated provider ('transfer' / 'commission'), which
     * the frontends already translate through `kind`.
     */
    methodName: row.method_label ?? row.method_name ?? row.provider,
    provider: row.provider,
    providerRef: row.provider_ref,
    providerPaymentId: row.provider_payment_id,
    destination: row.destination,
    rejectionReason: row.rejection_reason,
    rejectionReasonAr: row.rejection_reason_ar ?? null,
    // The receipt on an offline deposit, so the desk can show the image beside
    // the row it is deciding on. Null on every other movement.
    proofFilename: row.proof_filename,
    proofDetails: row.proof_details,
    payToDetails: row.pay_to_details,
    createdAt: instantOf(row.created_at),
    settledAt: instantOrNull(row.settled_at),
    reviewedAt: instantOrNull(row.reviewed_at),
  };
}

/**
 * The columns the admin withdrawal queue may be ordered by — R-2.5.
 *
 * ## `amount` sorts on the NUMERIC column, in SQL
 *
 * This is the money rule (§6), not a performance preference. `amount` is
 * `NUMERIC(28,8)`, and the two obvious shortcuts are both wrong:
 *
 *  - `ORDER BY amount::float8` loses precision above 2^53. Two withdrawals
 *    differing in the last satoshi compare EQUAL after the cast, so the queue
 *    orders them arbitrarily and the operator working top-down cannot tell.
 *  - Sorting the fetched page in JavaScript sorts the 25 rows in hand, which is
 *    R-2.5's named failure: identical-looking, and wrong in a way nobody notices
 *    until somebody acts on the top row.
 *
 * Postgres compares `numeric` exactly at full precision, so the bare column is
 * both the correct comparison and the indexable one. `Number()`/`parseFloat` are
 * lint errors on this path precisely so the first shortcut cannot be taken by
 * accident.
 *
 * ## The joined client columns
 *
 * `users` is already INNER JOINed for the queue's name/email display, so sorting
 * by applicant costs no extra join. `firstName` is offered rather than a
 * concatenated full name: the index is on the column, and a `first || ' ' ||
 * last` expression would need its own expression index to stay seekable.
 */
export const WITHDRAWAL_SORT_COLUMNS = {
  createdAt: transactions.createdAt,
  amount: transactions.amount,
  state: transactions.state,
  userEmail: users.email,
  userFirstName: users.firstName,
} as const;

export type WithdrawalSortKey = keyof typeof WITHDRAWAL_SORT_COLUMNS;

/** Newest first — what the queue showed before it was sortable. */
export const DEFAULT_WITHDRAWAL_SORT: WithdrawalSortKey = 'createdAt';

/**
 * Sort keys for the admin Financial list — R-2.5, over the UNION.
 *
 * SQL FRAGMENTS rather than Drizzle columns, because the list reads the
 * `combined` CTE assembled as raw SQL below — there is no column object to
 * hand the query builder. The map stays a CLOSED, compiled-in lookup for the
 * reason `listForUser`'s own `sortable` map records: this statement is
 * assembled as SQL text, so the only path from a request string to a SQL
 * identifier must be a lookup that either finds a known fragment or throws
 * (`sortKey` in common/sorting.ts does the throwing — GHSA-gpj5-g38j-94v9).
 *
 * Three keys, deliberately fewer than the withdrawal queue's five: the joined
 * `users` columns are not offered, because sorting the union by a joined
 * column defeats the per-arm indexes 0094 adds and needs its own index story
 * before it is honest to expose (R-2.5: the allowlist may not exceed the
 * indexes).
 *
 * Each entry carries its CAST beside its column, so a sort key cannot be
 * added without stating its value type — the cast is what the keyset seek
 * compares the cursor value under, and a key that silently fell into a text
 * comparison would paginate a numeric column in the '9' > '100' order §6.1
 * exists to prevent. The cast name doubles as the cursor-value VALIDATOR's
 * dispatch key (see `cursorSeekValue`), which is what turns a tampered cursor
 * into a 400 instead of a Postgres cast error.
 *
 * `state` sorts in LIFECYCLE order — pending, approved, success, failure,
 * rejected — the `transaction_state` enum's own, the order the withdrawal queue
 * already used. It sorted alphabetically while the union carried state as text,
 * which no index could serve: every status sort read the whole money history
 * (~1 s at 160,000 rows). 0165 indexes each arm's state in that order.
 */
export const ADMIN_TRANSACTION_SORT_COLUMNS = {
  createdAt: { column: sql`combined.created_at`, pageColumn: 'created_at', cast: 'timestamptz' },
  amount: { column: sql`combined.amount`, pageColumn: 'amount', cast: 'numeric' },
  state: { column: sql`combined.state`, pageColumn: 'state', cast: 'transaction_state' },
} as const satisfies Record<
  string,
  { column: SQL; pageColumn: string; cast: 'timestamptz' | 'numeric' | 'transaction_state' }
>;

export type AdminTransactionSortKey = keyof typeof ADMIN_TRANSACTION_SORT_COLUMNS;

/**
 * The CLIENT's own history — `GET /payments/transactions`.
 *
 * A separate map from the admin one above because the two lists are separate
 * decisions about the same union: the admin desk offers three keys and says why
 * ("the allowlist may not exceed the indexes"), the portal offers five.
 *
 * `direction` and `currency` are offered here and are indexed in no arm of the
 * union — and that is FINE here, unlike on the admin desk.
 *
 * The admin map's rule ("the allowlist may not exceed the indexes") is about a
 * list spanning every client. This one is not: `listForUser` builds each arm
 * with `WHERE <arm>.user_id = ${userId}`, so the sort only ever orders one
 * client's own movements — tens of rows, not millions. An index on `direction`
 * would also be close to useless at that cardinality.
 *
 * Recorded because the absence looks like the admin desk's problem and is not,
 * and because the reasoning changes the moment this query stops being
 * user-scoped.
 *
 * Existed only as an inline object literal in `listForUser`, which is why the
 * lookup that read it walked the prototype chain. A named map is what lets
 * `sortKey` guard it the way it guards the other twelve.
 */
export const CLIENT_TRANSACTION_SORT_COLUMNS = {
  createdAt: sql`created_at`,
  amount: sql`amount`,
  direction: sql`direction`,
  currency: sql`currency`,
  state: sql`state`,
} as const satisfies Record<string, SQL>;

export type ClientTransactionSortKey = keyof typeof CLIENT_TRANSACTION_SORT_COLUMNS;

/** Newest first, like every other money list. */
export const DEFAULT_ADMIN_TRANSACTION_SORT: AdminTransactionSortKey = 'createdAt';

/** The sentence `decodeCursor` uses — one message for one failure, wherever caught. */
const MALFORMED_CURSOR = 'Malformed cursor. Omit it to start from the first page.';

/**
 * The keyset seek predicate for one cursor — VALIDATED, then cast.
 *
 * `decodeCursor` shape-checks the envelope but cannot know a sort key's value
 * type; this is the half that stops a tampered or proxy-truncated cursor from
 * reaching Postgres as `'abc'::numeric` or `'x'::uuid` and surfacing as a
 * 22P02 500 (R-2.1: a bad caller value is a 400 with a sentence, never a
 * database error). The cast is dispatched from the sort map's own entry, so a
 * new sort key states its type once and gets its validation with it.
 */
function cursorSeek(
  spec: (typeof ADMIN_TRANSACTION_SORT_COLUMNS)[AdminTransactionSortKey],
  cursor: CursorPosition,
  comparator: SQL,
): SQL {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)) {
    throw new ValidationError(MALFORMED_CURSOR);
  }
  if (spec.cast === 'numeric' && !/^-?\d+(\.\d+)?$/.test(cursor.value)) {
    throw new ValidationError(MALFORMED_CURSOR);
  }
  if (spec.cast === 'timestamptz' && Number.isNaN(Date.parse(cursor.value))) {
    throw new ValidationError(MALFORMED_CURSOR);
  }
  if (
    spec.cast === 'transaction_state' &&
    !(transactionStateEnum.enumValues as readonly string[]).includes(cursor.value)
  ) {
    throw new ValidationError(MALFORMED_CURSOR);
  }
  const cast =
    spec.cast === 'timestamptz'
      ? sql`${cursor.value}::timestamptz`
      : spec.cast === 'numeric'
        ? sql`${cursor.value}::numeric`
        : sql`${cursor.value}::transaction_state`;
  return sql`(${spec.column}, combined.id) ${comparator} (${cast}, ${cursor.id}::uuid)`;
}

/**
 * The read models over payments: the withdrawal queue, the client's money
 * history, the admin movements union, their exports and their totals. Reads
 * only — nothing here moves money.
 */
export class TransactionQueries {
  constructor(
    private readonly db: Db,
    private readonly providers: PaymentProviderRegistry,
  ) {}

  /**
   * The client a transaction belongs to, or undefined.
   *
   * Deliberately returns the OWNER rather than the row: every caller of this is
   * asking a client-scope question, and handing back the transaction would
   * invite one of them to read an amount or a state off a row they have not yet
   * established the caller may see.
   */
  async ownerOf(id: string): Promise<number | undefined> {
    const [row] = await this.db
      .select({ userId: transactions.userId })
      .from(transactions)
      .where(eq(transactions.id, id))
      .limit(1);
    return row?.userId;
  }

  async listForAdmin(filter: {
    /**
     * One withdrawal by its uuid — where a notification's link lands. AND-ed
     * with the scope below, so an out-of-scope id is an empty page, never a
     * "it exists elsewhere" answer.
     */
    id?: string;
    state?: string;
    page?: number;
    limit?: number;
    /** Keyset position — R-2.4. When present, `page` is ignored. */
    cursor?: CursorPosition;
    /** Row-level visibility. Admin callers pass the actor's; defaults to open. */
    scope?: ClientScope;
    /**
     * Free-text search over the CLIENT — email, first name, last name.
     *
     * The same three columns the KYC and partner queues search. An operator
     * moves between these screens, and a box that matched different fields on
     * each would be a trap rather than a feature.
     *
     * Not the amount, and not the provider reference: both are exact-match
     * lookups where a substring gives confidently wrong results — `100` would
     * match 1,001.00 — and neither is what somebody chasing a client's payout
     * types first.
     */
    q?: string;
    /** R-2.5 server-side sort. Validated by `sortKey` before it gets here. */
    sort?: WithdrawalSortKey;
    order?: SortOrder;
    /** When requested — `[from, until)`, `common/date-range.ts`. Narrows the tabs too. */
    range?: DateRange;
  }) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = pageSize(filter.limit);
    const db = this.db;

    const sortKey: WithdrawalSortKey = filter.sort ?? DEFAULT_WITHDRAWAL_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = WITHDRAWAL_SORT_COLUMNS[sortKey];

    const conditions = [eq(transactions.direction, 'withdrawal')];

    // In the WHERE clause: an out-of-scope withdrawal never enters the queue,
    // so it also cannot appear in the per-state counts computed alongside it.
    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, transactions.userId);
    if (scoped) conditions.push(scoped);
    if (filter.id) conditions.push(eq(transactions.id, filter.id));
    if (filter.state) {
      conditions.push(eq(transactions.state, filter.state as 'pending'));
    }
    conditions.push(...withinRange(transactions.createdAt, filter.range));
    /*
     * Keyset seek — R-2.4. This is the withdrawal QUEUE: an admin works down it
     * while clients keep submitting, which is precisely the concurrent-insert
     * case where offset paging skips a row. A skipped withdrawal is one nobody
     * actions, and nothing about it looks wrong.
     *
     * The COMPARATOR FOLLOWS THE SORT DIRECTION, and the cursor value is cast to
     * the sort column's own type — both for the reasons `users.store.ts`
     * records. Under `ORDER BY ... ASC` "after this row" is `>`, and a `<` left
     * behind would page backwards through a forwards list, silently re-serving
     * rows the caller had already seen.
     *
     * `amount` casts to `numeric`, never to a float: the cursor carries the
     * exact decimal string the row held, and `::numeric` is what compares it at
     * full precision against a `NUMERIC(28,8)` column.
     */
    /*
     * In the WHERE clause, so it narrows the RESULT SET and therefore the
     * counts and the cursor with it. Filtering fetched rows would leave the
     * total describing something else and the pager offering empty pages.
     */
    /*
     * ESCAPED. A user-typed term goes into a LIKE pattern, where `%` and `_` are
     * wildcards and a backslash escapes them — so an operator searching for a
     * literal `%` matched every row, and `a_c` matched `abc`.
     *
     * Not an injection: the value is still a bind parameter. It is a SEARCH that
     * silently answers a different question from the one asked, which on a review
     * queue reads as "everybody is pending" rather than as a bug. Eight sibling
     * searches already escape; these two were the exceptions.
     */
    // A Portal ID or a name/email — see `clientIdentitySearch`.
    const q = filter.q?.trim() || undefined;
    if (q) {
      conditions.push(
        /*
         * The CONCATENATED expression, which is the one the trigram index is built
         * on (`users_search_trgm_idx`, migration 0010).
         *
         * This was three separate `ILIKE`s OR-ed together, and
         * `client-list-indexes.spec.ts` already PROVES that form cannot use the
         * index — it asserts `not.toContain('users_search_trgm_idx')` for exactly
         * this shape. So every search of this queue was a sequential scan while
         * the index sat beside it, unused.
         *
         * It also searches BETTER: "jane smith" matches the concatenation and can
         * never match any single column, which is what an operator typing a full
         * name expects. `kyc.store.ts` already states the intent — both queues are
         * review queues of people and "a search box that matched different fields
         * on each would be a trap".
         */
        clientIdentitySearch(q),
      );
    }

    if (filter.cursor) {
      const comparator = direction === 'asc' ? sql`>` : sql`<`;
      const cast =
        sortKey === 'createdAt'
          ? sql`${filter.cursor.value}::timestamptz`
          : sortKey === 'amount'
            ? sql`${filter.cursor.value}::numeric`
            : sql`${filter.cursor.value}::text`;
      // The enum column (`state`) compares as text; Postgres knows the enum's
      // text representation, so this casts cleanly.
      const seekColumn =
        sortKey === 'createdAt' || sortKey === 'amount'
          ? sql`${sortColumn}`
          : sql`${sortColumn}::text`;

      conditions.push(
        sql`(${seekColumn}, ${transactions.id}) ${comparator} (${cast}, ${filter.cursor.id}::uuid)`,
      );
    }
    const where = and(...conditions);
    const usingCursor = Boolean(filter.cursor) || page <= 1;
    // Both keys in the SAME direction — a b-tree can be read backwards only when
    // every column of the ORDER BY agrees, which is what lets migration 0035's
    // `(col DESC, id DESC)` indexes serve both directions with no sort node.
    const orderBy = direction === 'asc' ? asc : desc;

    const rowsQuery = db
      .select({
        // The sort value at full precision, for the cursor — see the note at
        // `buildCursorPage` below. Stripped before the row becomes a response.
        cursorValue: sql<string>`${sortColumn}::text`,
        id: transactions.id,
        amount: transactions.amount,
        currency: transactions.currency,
        state: transactions.state,
        provider: transactions.provider,
        providerRef: transactions.providerRef,
        destination: transactions.destination,
        rejectionReason: transactions.rejectionReason,
        rejectionReasonAr: transactions.rejectionReasonAr,
        requestedAt: transactions.createdAt,
        /*
         * WHO decided. Recorded since the lifecycle existed and projected
         * nowhere, so the desk showed WHEN a payout was reviewed and never by
         * whom — on a console that splits `withdrawals.approve` from
         * `withdrawals.settle` precisely so two people can be required.
         * `AdminMoneyService` resolves it to a name for the response.
         */
        reviewedBy: transactions.reviewedBy,
        reviewedAt: transactions.reviewedAt,
        settledAt: transactions.settledAt,
        providerPayoutId: transactions.providerPayoutId,
        providerSubmittedAt: transactions.providerSubmittedAt,
        providerRequestAmount: transactions.providerRequestAmount,
        providerFee: transactions.providerFee,
        needsAttention: transactions.needsAttention,
        attentionReason: transactions.attentionReason,
        providerNote: transactions.providerNote,
        providerCode: transactions.providerCode,
        channelCode: transactions.channelCode,
        providerEnvironment: transactions.providerEnvironment,
        userId: transactions.userId,
        userPortalId: users.id,
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        withdrawalMethodKey: transactions.withdrawalMethodKey,
        /*
         * The rail's name AS THE DESK KNOWS IT — its internal label (0161),
         * falling back to the display name — resolved server-side and joined at
         * read time, so renaming it relabels every request at once.
         *
         * Null for every withdrawal written before migration 0062, which named
         * no method. The admin column falls back to `provider` for those rather
         * than showing a blank cell.
         */
        withdrawalMethodName: sql<
          string | null
        >`coalesce(${withdrawalPaymentMethods.internalLabel}, ${withdrawalPaymentMethods.name})`,
      })
      .from(transactions)
      .innerJoin(users, eq(transactions.userId, users.id))
      /*
       * LEFT, never inner: the column is nullable for pre-0062 rows, and an
       * inner join would silently drop every historical withdrawal from the
       * queue — a filter nobody asked for, applied to money.
       */
      .leftJoin(
        withdrawalPaymentMethods,
        eq(transactions.withdrawalMethodKey, withdrawalPaymentMethods.key),
      )
      .where(where)
      .orderBy(orderBy(sortColumn), orderBy(transactions.id))
      .limit(limit + 1)
      .offset(usingCursor ? 0 : (page - 1) * limit);

    /*
     * Per-state counts over the full set — deliberately ignoring the STATE
     * filter (the desk tabs must show every state's size regardless of the
     * active tab) but NEVER the SCOPE. This aggregated without the scope
     * predicate once, and the row a scoped admin could not see still moved
     * their nav badge and tab counts: aggregate intelligence about clients
     * outside their territory, found live by the 13 Aug scoped walk.
     *
     * The SEARCH narrows these; the STATE filter does not. Two filters on
     * different axes: the tabs exist to show how big each state is, so applying
     * the active state would make every tab but one read zero; the search is the
     * reader's current subject — if they are looking at one client, a Pending
     * badge counting all 8,571 rows describes a queue they are not looking at.
     *
     * Without a search they come from the STORED TOTALS (0165) — a withdrawal
     * is a payment movement in the withdrawal direction — through the same
     * territory predicate. Counting the rows here cost a scan of every
     * withdrawal on every page, twice (a total and the tabs), growing with the
     * book. There is no separate total any more: it is the active tab's count,
     * the same rule the Financial list states — and, unlike the count it
     * replaces, it no longer shrank as the desk paged past a cursor.
     */
    const scope = filter.scope ?? UNRESTRICTED;
    const countRowsOf = async (): Promise<{ state: string; value: number }[]> => {
      const totalsFilter: AdminMovementsFilter = {
        scope,
        kind: 'payment',
        direction: 'withdrawal',
        ...filter.range,
      };
      // The period narrows the tabs like the search does; the stored totals
      // answer it only on UTC-day bounds (`movementTotalsSource`).
      if (!q && movementTotalsSource(totalsFilter)) {
        const totals = await db.execute(movementTotalsQuery(totalsFilter, 'state'));
        return totals.rows as unknown as { state: string; value: number }[];
      }
      const countConditions = [eq(transactions.direction, 'withdrawal')];
      if (scoped) countConditions.push(scoped);
      countConditions.push(...withinRange(transactions.createdAt, filter.range));
      // The concatenated expression the trigram index is built on — see above.
      if (q) countConditions.push(clientIdentitySearch(q));
      return db
        .select({ state: transactions.state, value: sql<number>`count(*)::int` })
        .from(transactions)
        .innerJoin(users, eq(transactions.userId, users.id))
        .where(and(...countConditions))
        .groupBy(transactions.state);
    };
    const [rows, countRows] = await Promise.all([rowsQuery, countRowsOf()]);
    const counts: Record<string, number> = { all: 0 };
    for (const row of countRows) {
      counts[row.state] = row.value;
      counts['all'] += row.value;
    }
    const total = filter.state ? (counts[filter.state] ?? 0) : counts['all'];

    /*
     * `buildCursorPage` mints the cursor by reading `row[sort]`, so the row it
     * is handed must carry the sort key under THAT NAME.
     *
     * The projection renames two of them — `created_at` is served as
     * `requestedAt`, and the client columns are flattened to `userEmail` /
     * `userFirstName` — so the page is built from rows re-labelled back to the
     * allowlist's keys, and the API shaping happens afterwards. Without this the
     * lookup returns `undefined` on every non-default sort, `cursorValueOf`
     * turns that into an empty string, and page two seeks to a position that
     * matches nothing: the list would simply end after one page.
     */
    const paged = buildCursorPage(
      /*
       * `cursorValue` carries the sort value at FULL PRECISION, and it is not
       * optional on this list.
       *
       * A JS Date holds milliseconds and the column holds microseconds, so a
       * cursor minted from `requestedAt` skips every row sharing the boundary
       * row's millisecond. Withdrawals submitted together — a batch payout, a
       * provider callback storm — share one, and a desk paging its own queue
       * would simply not see them.
       */
      rows.map((r) => ({ ...r, createdAt: r.requestedAt })),
      limit,
      total,
      sortKey,
    );

    // Who pays each request NOW (0168): the provider for an automated payout
    // it can take, the desk otherwise — what the approve dialog tells the desk.
    const providerStates = await this.providers.states(
      await this.db.select().from(paymentProviders),
    );
    const items = paged.items.map((r) => ({
      id: r.id,
      amount: money(r.amount), // money crosses the boundary as a string
      currency: r.currency,
      state: r.state,
      provider: r.provider,
      providerCode: r.providerCode,
      channelCode: r.channelCode,
      providerEnvironment: r.providerEnvironment,
      paidBy:
        this.providers.isAutomatedPayout(r) && providerStates.get(r.providerCode)?.usable
          ? ('provider' as const)
          : ('desk' as const),
      providerRef: r.providerRef,
      destination: r.destination,
      /*
       * The rail's display NAME, falling back to the raw `provider` key.
       *
       * The fallback is what keeps historical rows honest: a withdrawal written
       * before migration 0062 names no method, and rendering an em dash there
       * would say "no method" about money that certainly went out through one.
       * `provider` is the only record those rows have of it.
       */
      methodName: r.withdrawalMethodName ?? r.provider,
      rejectionReason: r.rejectionReason,
      rejectionReasonAr: r.rejectionReasonAr,
      requestedAt: r.requestedAt,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt,
      settledAt: r.settledAt,
      /* The payout's state at its provider (0173's neutral columns). */
      providerPayoutId: r.providerPayoutId,
      providerSubmittedAt: r.providerSubmittedAt,
      providerRequestAmount: r.providerRequestAmount,
      providerFee: r.providerFee,
      needsAttention: r.needsAttention,
      attentionReason: r.attentionReason,
      providerNote: r.providerNote,
      user: {
        id: r.userId,
        portalId: r.userPortalId,
        email: r.userEmail,
        firstName: r.userFirstName,
        lastName: r.userLastName,
      },
    }));

    return { items, nextCursor: paged.nextCursor, total, page, limit, counts };
  }

  /**
   * One batch of withdrawals for a CSV export — the same filter and the same
   * scope as `listForAdmin`, without the page-size ceiling.
   *
   * ── Why this is a separate method rather than a flag on `listForAdmin` ─────
   *
   * `listForAdmin` runs its limit through `pageSize()`, which clamps to
   * `MAX_PAGE_SIZE` (100). That ceiling is correct for a screen and wrong for an
   * export, whose whole promise is "every row matching these filters, not the
   * page you are looking at". Adding an `unbounded: true` parameter to the list
   * method would put a switch on the query the entire admin surface reads, and
   * getting that switch wrong is an unpaginated read of a 219,000-row table
   * from a screen.
   *
   * What is NOT duplicated is the part that matters: the scope predicate is
   * built by the same `clientScopePredicate` call against the same
   * `transactions.userId` column, in the WHERE clause. An export cannot see a
   * row the queue would have hidden.
   *
   * Offset paging rather than a keyset seek, and a SNAPSHOT BOUND is what makes
   * that safe.
   *
   * ⚠️ This used to claim the bound was unnecessary: "a concurrent insert can
   * only add a row at the head this pass has already passed — it cannot shift a
   * row across a batch boundary." That is exactly backwards. The ordering is
   * `created_at DESC`, so a new row sorts FIRST — it does not land at a head
   * already gone by, it pushes every later row down one. `OFFSET 1000` then
   * points at what was row 999, and the last row of batch 1 is written to the
   * file a second time.
   *
   * `createdAt <= startedAt` removes the possibility rather than reasoning about
   * it: rows created after the run began never enter the set, so the offsets
   * cannot shift. It is the same snapshot instant `AdminExportService
   * .transactionBatch` threads through its keyset export — "the SAME value on
   * every batch" — applied to the paging strategy that actually needs it.
   */
  async listForExport(filter: {
    state?: string;
    offset: number;
    limit: number;
    scope?: ClientScope;
    /** The export run's snapshot instant — the SAME value on every batch. */
    startedAt: Date;
    /** The period the desk is looking at — the file lists what the screen lists. */
    range?: DateRange;
  }) {
    const conditions = [
      ...withinRange(transactions.createdAt, filter.range),
      eq(transactions.direction, 'withdrawal'),
      // The snapshot bound. Without it a concurrent insert shifts every offset.
      lte(transactions.createdAt, filter.startedAt),
    ];

    // Identical to the queue's, on the same column. See the note above.
    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, transactions.userId);
    if (scoped) conditions.push(scoped);
    if (filter.state) {
      conditions.push(eq(transactions.state, filter.state as 'pending'));
    }

    const rows = await this.db
      .select({
        id: transactions.id,
        amount: transactions.amount,
        currency: transactions.currency,
        state: transactions.state,
        provider: transactions.provider,
        providerRef: transactions.providerRef,
        destination: transactions.destination,
        rejectionReason: transactions.rejectionReason,
        requestedAt: transactions.createdAt,
        reviewedAt: transactions.reviewedAt,
        settledAt: transactions.settledAt,
        userId: transactions.userId,
        userPortalId: users.id,
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
      })
      .from(transactions)
      .innerJoin(users, eq(transactions.userId, users.id))
      .where(and(...conditions))
      // Matching the queue's default ordering, so an export and the screen list
      // the same rows in the same order.
      .orderBy(desc(transactions.createdAt), desc(transactions.id))
      .limit(filter.limit)
      .offset(filter.offset);

    /*
     * `money()` for the same reason `listForAdmin` uses it: the value crosses
     * the boundary as a STRING, normalised to the 8 decimal places the column
     * stores, and is never converted to a number on the way to the file.
     */
    return rows.map((r) => ({ ...r, amount: money(r.amount) }));
  }

  /**
   * The `combined` CTE — every money movement on the platform, from the three
   * tables that hold one, unioned in SQL. Shared VERBATIM by the client's own
   * history (`listForUser`) and the admin Financial list (`listAllForAdmin`),
   * so the two screens cannot drift on what counts as a movement.
   *
   * ── TRANSFERS ARE IN THIS LIST, AND THEY LIVE IN ANOTHER TABLE ───────────
   *
   * A money history is deposits, withdrawals AND wallet ⇄ account transfers.
   * The first two are rows in `transactions`; the third is a row in
   * `transfers`, because a transfer has two legs and a bridge confirmation
   * that a payment does not. Two tables, one history.
   *
   * They are unioned HERE, in SQL, rather than merged by the caller — and that
   * is not a preference. Both endpoints page, sort, filter and COUNT. A
   * client-side merge of two paged lists gives a page whose rows come from one
   * table and a total that describes the other, which is exactly the
   * "showing 4 of 100" failure `listForUser`'s own history records. The union
   * is the only place where one predicate can govern both.
   *
   * ── The mapping, and why each choice is the honest one ──────────────────
   *
   * `direction` is stated FROM THE WALLET'S SIDE, because that is what every
   * other row in this list describes: `account_to_wallet` brings money in, so
   * it reads as a deposit; `wallet_to_account` takes it out, so it reads as a
   * withdrawal. A screen must not print those words for a transfer — `kind`
   * exists for that — but the DIRECTION is the same fact, and inventing a
   * third enum value would break both frontends' exhaustive switches over a
   * Postgres enum this row is not stored in.
   *
   * `state` is mapped rather than passed through: a transfer is
   * pending/settled/failed and a transaction is pending/…/success/failure, and
   * a list that mixes two vocabularies makes "settled" and "success" look like
   * different outcomes. Mapped once, here, where both sets are visible.
   *
   * `kind` is what a renderer branches on. It is the one new field, and it is
   * NOT nullable: every row says what it is.
   *
   * ── The one parameter: WHO MAY BE SEEN, decided PER ARM ──────────────────
   *
   * Each arm hands its own columns (`MovementArm`) to `armWhere`, which returns
   * that arm's whole WHERE clause — or an empty fragment for "no restriction".
   * Per arm rather than on the outer SELECT, so each branch keeps its own
   * `user_idx` usable and Postgres prunes before the union rather than after:
   * on the admin list the clause is the actor's client-scope predicate and the
   * client search, which over the union's output read every movement there is.
   */
  /**
   * @param includeRebates whether the client's REBATE credits form a fourth arm.
   *
   * TRUE for a client reading their own history, FALSE for the admin Financial
   * list, and the asymmetry is deliberate rather than an oversight.
   *
   * A rebate is a ledger entry with no `transactions` row, so without this arm
   * it appears on NO screen a client can open — money in their own balance they
   * cannot account for, which is the one thing a wallet history must never do.
   * That is why the arm exists at all.
   *
   * The admin has other places to read the same fact: `/commissions` lists
   * every accrual with the partner, the client, the rate and the rung, which is
   * strictly more than a movement row can carry. On the Financial list the
   * rebates were noise against the deposits, withdrawals and transfers the
   * screen exists for — and they are about to get noisier, since one payout run
   * now credits per wallet rather than per trade (0116).
   */
  /**
   * @param prelude further CTEs the arms' conditions read (the admin search's
   * `searched`), placed before `combined` in the same WITH.
   */
  private movementsCte(
    armWhere: (arm: MovementArm) => SQL,
    includeRebates: boolean,
    prelude?: SQL,
  ): SQL {
    /*
     * THE REBATE ARM, conditional (0116).
     *
     * A fragment rather than an `if` around two whole queries: the CTE is one
     * template literal and duplicating four hundred lines of union to vary one
     * arm is how two copies of a money query drift apart.
     *
     * Empty for the admin Financial list. See the parameter's own note for why
     * the two callers legitimately differ.
     */
    const rebateArm = includeRebates
      ? sql`
        UNION ALL

        /*
         * THE CLIENT'S REBATE — money paid back to them for their own trading.
         *
         * ## Why it was invisible, and why that mattered
         *
         * A rebate is a LEDGER ENTRY with no transactions row: the accrual
         * pipeline credits the wallet directly through WalletService.post, so
         * nothing in the three tables above ever knew about it. This list is a
         * client's whole money history, so 67 real credits simply did not exist
         * on any screen a client can open — money in their balance they could
         * not account for, which is the one thing a wallet history must never
         * do.
         *
         * ## COMMISSION is deliberately NOT here
         *
         * The same table holds commission credits, and adding them would be one
         * extra predicate. It is left out on purpose: commission has its own
         * history on the partner page, and a partner reading both screens would
         * see the same earning twice with no way to tell it was one payment.
         * A rebate has no such home — this is its only one.
         *
         * ## Filtered on entry_type, not on the wallet kind
         *
         * A rebate credits the MAIN wallet, which is also where deposits land,
         * so the wallet cannot distinguish it. entry_type is what the accrual
         * writes and what confirmPending branches on, so it is the same fact
         * the money path used rather than a second one that could disagree.
         *
         * NO BACKTICKS in this comment, for the reason the arm above states: the
         * whole query is a template literal.
         */
        SELECT
          le.id,
          w.user_id,
          le.wallet_id,
          /*
           * Always deposit. A rebate only ever credits, and a reversal is a
           * separate compensating adjustment entry rather than a negative
           * rebate — see reverseAccrual, which posts an adjustment precisely so
           * a clawback does not net against what was earned.
           */
          'deposit'::text,
          le.amount,
          w.currency,
          /*
           * success, because a ledger row existing IS the money having moved.
           * The append-only trigger means there is no pending state it could
           * be written in and later corrected out of.
           */
          'success'::transaction_state,
          NULL::varchar,                          -- method_key
          NULL::varchar,                          -- withdrawal_method_key
          /*
           * NAMED, like the two arms above and for the same reason:
           * transactions.provider is NOT NULL and this did arrive through
           * something. The DTO documents provider as an OPEN set that no screen
           * may switch on exhaustively.
           */
          'rebate'::varchar,                      -- provider
          NULL::varchar,                          -- provider_ref
          NULL::varchar,                          -- destination
          NULL::uuid,                             -- destination_trading_account_id
          NULL::varchar,                          -- proof_filename
          NULL::jsonb,                            -- proof_details
          NULL::jsonb,                            -- pay_to_details
          NULL::text,                             -- rejection_reason: it cannot fail
          NULL::text,                             -- rejection_reason_ar
          NULL::uuid,                             -- reviewed_by
          NULL::timestamptz,                      -- reviewed_at
          le.created_at                           AS settled_at,
          NULL::varchar,                          -- provider_payment_id
          NULL::varchar,                          -- provider_payout_id
          NULL::timestamptz,                      -- provider_submitted_at
          FALSE,                                  -- needs_attention
          NULL::text,                             -- attention_reason
          NULL::text,                             -- provider_note
          le.created_at,
          /*
           * NAMED rather than null, unlike the transfer and commission arms.
           *
           * The method column is what a client reads to tell one movement from
           * another, and those two arms already say what they are in the row
           * beside it — a transfer names its account, a commission move is the
           * only thing on the commission screen. A rebate sits in a list of
           * deposits and withdrawals with nothing distinguishing it, so a blank
           * method left the client asking where the money came from, which is
           * the question this whole arm exists to answer.
           */
          /*
           * "Rebate", or "Rebate · 40 trades" once a run covered more than one.
           *
           * A payout run credits the wallet ONCE now (0116), so a single line
           * can stand for forty closed trades. Without the count a client sees
           * one unexplained figure where they used to see forty small ones —
           * which trades a rebate paid on is the first thing they ask.
           *
           * The count comes from the BATCH, joined below; NULL for every rebate
           * credited before 0116, when each really was one trade. COALESCE
           * keeps those reading exactly as they always did.
           */
          CASE
            WHEN b.accrual_count > 1
              THEN 'Rebate · ' || b.accrual_count || ' trades'
            ELSE 'Rebate'
          END::varchar                            AS arm_method_name,
          'rebate'::text                          AS kind,
          NULL::uuid                              AS trading_account_id
        /*
         * The rebate predicate rides on the JOIN, not on a WHERE.
         *
         * armWhere returns an EMPTY fragment when its caller has no owner to
         * pin — the admin list does exactly that — so appending a trailing AND
         * after it leaves a dangling AND with no WHERE, and the whole query
         * fails to parse. Putting the condition in the join keeps this arm
         * correct whether or not the caller filters.
         */
        FROM ledger_entries le
        JOIN wallets w ON w.id = le.wallet_id AND le.entry_type = 'rebate'
        /*
         * LEFT, because a rebate credited before 0116 has no batch — it keyed
         * off its own accrual. An INNER join would silently drop every one of
         * those from a client's history, which is the same disappearing-money
         * failure this arm was added to fix.
         */
        LEFT JOIN ib_accrual_batches b
          /*
           * reference_id is a varchar holding ids from several tables, so it is
           * cast only inside a CASE that has checked it IS a uuid: no throw, and
           * the join probes the primary key rather than casting every b.id.
           *
           * NO BACKTICKS: the whole query is a template literal, as the arms
           * above warn. This comment had them and broke the parse.
           */
          ON b.id = CASE WHEN le.reference_type = 'accrual_batch' AND le.reference_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         THEN le.reference_id::uuid END
        ${armWhere({ owner: sql`w.user_id`, id: sql`le.id`, payments: false, route: null })}
      `
      : sql``;

    /*
     * ⚠️ EVERY ARM MUST GIVE EACH COLUMN THE SAME TYPE — `NULL::varchar`, never
     * `NULL::text`, beside a varchar column (29 Sep 2026). A mismatch makes
     * Postgres coerce the union's output, which stops it treating the arms as
     * one appendable set: no Merge Append, so an ORDER BY … LIMIT could not read
     * each arm's index in order and every Financial page sorted the whole
     * money history. `destination` (varchar here, text in two arms) did exactly
     * that; aligned, the first page reads 26 index entries per arm. `state` is a
     * `transaction_state` on every arm for the same reason (0165).
     */
    return sql`
      WITH ${prelude ? sql`${prelude},` : sql``} combined AS (
        SELECT
          t.id,
          t.user_id,
          t.wallet_id,
          t.direction::text                       AS direction,
          t.amount,
          t.currency,
          t.state                                 AS state,
          t.method_key,
          t.withdrawal_method_key,
          t.provider,
          t.provider_ref,
          t.destination,
          t.destination_trading_account_id,
          t.proof_filename,
          t.proof_details,
          t.pay_to_details,
          t.rejection_reason,
          t.rejection_reason_ar,
          t.reviewed_by,
          t.reviewed_at,
          t.settled_at,
          t.provider_payment_id,
          t.provider_payout_id,
          t.provider_submitted_at,
          t.needs_attention,
          t.attention_reason,
          t.provider_note,
          t.created_at,
          /*
           * The method's NAME is not looked up here: methodNamesOf names the
           * rows a read SHOWS, from method_key and withdrawal_method_key above.
           */
          NULL::varchar                           AS arm_method_name,
          'payment'::text                         AS kind,
          NULL::uuid                              AS trading_account_id
        FROM transactions t
        ${armWhere({
          owner: sql`t.user_id`,
          id: sql`t.id`,
          payments: true,
          route: sql`(t.direction::text, t.provider_code, t.channel_code)`,
          methodKeys: [sql`t.method_key`, sql`t.withdrawal_method_key`],
        })}

        UNION ALL

        SELECT
          tr.id,
          tr.user_id,
          tr.wallet_id,
          CASE WHEN tr.direction = 'account_to_wallet' THEN 'deposit' ELSE 'withdrawal' END,
          tr.amount,
          tr.currency,
          /*
           * IDENTICAL to the expression 0165 indexes on transfers — that is how
           * the planner matches it, and a status tab or sort reads the index.
           */
          CASE tr.state
            WHEN 'settled' THEN 'success'::transaction_state
            WHEN 'failed' THEN 'failure'::transaction_state
            ELSE 'pending'::transaction_state
          END,
          NULL::varchar,                          -- method_key
          NULL::varchar,                          -- withdrawal_method_key
          /*
           * NAMED, not null: transactions.provider is NOT NULL, and a transfer
           * did move through something — the wallet-to-account rail. The DTO
           * documents provider as an OPEN set that no screen may switch on
           * exhaustively, so adding a value is in contract; inventing a null
           * would not be, and would break the column type.
           */
          'transfer'::varchar,                    -- provider
          NULL::varchar,                          -- provider_ref
          NULL::varchar,                          -- destination
          NULL::uuid,                             -- destination_trading_account_id
          NULL::varchar,                          -- proof_filename
          NULL::jsonb,                            -- proof_details
          NULL::jsonb,                            -- pay_to_details
          /*
           * The transfer's failure reason lands in rejection_reason: both
           * answer "why did this not happen", and giving them one column means a
           * screen showing the reason shows it for every kind of movement.
           */
          tr.failure_reason,
          tr.failure_reason_ar,
          NULL::uuid,                             -- reviewed_by
          NULL::timestamptz,                      -- reviewed_at
          tr.settled_at,
          NULL::varchar,                          -- provider_payment_id
          NULL::varchar,                          -- provider_payout_id
          NULL::timestamptz,                      -- provider_submitted_at
          FALSE,                                  -- needs_attention
          NULL::text,                             -- attention_reason
          NULL::text,                             -- provider_note
          tr.created_at,
          NULL::varchar                           AS arm_method_name,
          'transfer'::text                        AS kind,
          tr.trading_account_id
        FROM transfers tr
        ${armWhere({ owner: sql`tr.user_id`, id: sql`tr.id`, payments: false, route: null })}

        UNION ALL

        /*
         * A partner moving commission into their main wallet.
         *
         * NO BACKTICKS in any COMMENT in this block, or the two arms above:
         * this whole query is a TEMPLATE LITERAL, so one backtick in a comment
         * ends the string and the rest of the file parses as code. (The
         * armWhere interpolations carry nested template literals — those are
         * code, not comment text, and compose fine.)
         *
         * ## direction is stated from the MAIN wallet's side
         *
         * Always deposit, because that is what the movement does to the wallet
         * every other row in this list is about — the same rule the transfer arm
         * above follows. The commission wallet's matching debit is NOT a second
         * row: that wallet never appears in GET /wallet, so a client reading a
         * withdrawal against a wallet they cannot see would be reading about
         * money leaving nowhere.
         *
         * The ledger still holds both legs. This list is a client's history, not
         * the accounting record — /wallet/ledger is where both sides live.
         *
         * ## state is always success
         *
         * Not a simplification: ib_wallet_transfers has no state column, because
         * both legs commit in one transaction against two rows of the same
         * table. A row existing IS the movement having happened, so there is no
         * pending state a screen could ever render.
         */
        SELECT
          iwt.id,
          iwt.user_id,
          iwt.to_wallet_id                        AS wallet_id,
          'deposit'::text,
          iwt.amount,
          iwt.currency,
          'success'::transaction_state,
          NULL::varchar,                          -- method_key
          NULL::varchar,                          -- withdrawal_method_key
          /*
           * NAMED, like the transfer arm and for the same reason:
           * transactions.provider is NOT NULL and this did move through
           * something — the commission rail. The DTO documents provider as an
           * OPEN set no screen may switch on exhaustively.
           */
          'commission'::varchar,                  -- provider
          NULL::varchar,                          -- provider_ref
          NULL::varchar,                          -- destination
          NULL::uuid,                             -- destination_trading_account_id
          NULL::varchar,                          -- proof_filename
          NULL::jsonb,                            -- proof_details
          NULL::jsonb,                            -- pay_to_details
          NULL::text,                             -- rejection_reason: it cannot fail
          NULL::text,                             -- rejection_reason_ar
          NULL::uuid,                             -- reviewed_by
          NULL::timestamptz,                      -- reviewed_at
          iwt.created_at                          AS settled_at,
          NULL::varchar,                          -- provider_payment_id
          NULL::varchar,                          -- provider_payout_id
          NULL::timestamptz,                      -- provider_submitted_at
          FALSE,                                  -- needs_attention
          NULL::text,                             -- attention_reason
          NULL::text,                             -- provider_note
          iwt.created_at,
          NULL::varchar                           AS arm_method_name,
          'commission_transfer'::text             AS kind,
          NULL::uuid                              AS trading_account_id
        FROM ib_wallet_transfers iwt
        ${armWhere({ owner: sql`iwt.user_id`, id: sql`iwt.id`, payments: false, route: null })}

        ${rebateArm}
      )
    `;
  }

  /**
   * A client's own history — filtered, ordered and paged BY THE DATABASE.
   *
   * ## ⚠️ What this replaced, and why it was wrong
   *
   * This method used to be a bare `SELECT ... ORDER BY created_at DESC LIMIT
   * 100` with no parameters, and the portal did the filtering, the sorting and
   * the counting in the browser. Both apps documented that as "the client's
   * whole history"; the `LIMIT 100` had made it false without anybody updating
   * the sentence.
   *
   * So a client with 150 movements was filtering the newest 100 and being told
   * "showing 4 of 100". PLATFORM-CONVENTIONS R-2.5 names that failure exactly —
   * and this is the screen a client uses to check the ledger against their own
   * records, which makes an under-report here worse than on any other list.
   *
   * Every constraint is now a WHERE, the ordering is an ORDER BY, and `total` is
   * a COUNT over the same predicate. A filter therefore covers every row the
   * client has, not the newest hundred.
   *
   * ## Ordering amounts is the database's job, and it is better at it
   *
   * `amount` is `NUMERIC(28,8)`. Postgres orders it numerically and exactly —
   * no decimal.js, no `Number()`, and no risk of the text comparison that puts
   * '9.00000000' above '100.00000000'. §6.1 is satisfied by never taking the
   * value out of the database to compare it.
   */
  async listForUser(
    userId: number,
    query: ListTransactionsQueryDto = {},
  ): Promise<{ items: TransactionListRow[]; total: number; page: number; limit: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;

    /*
     * The union of the three money tables — `movementsCte` below, which
     * carries this method's original design commentary and is shared with the
     * admin Financial list. This caller pins one OWNER: every arm reads
     * `WHERE <arm>.user_id = the session's user`, so the owner comes from the
     * session and never from a parameter (R-4.4).
     */
    /* TRUE: this is the ONLY screen a client has for their rebates. */
    const selection = sql`${this.movementsCte(({ owner }) => sql` WHERE ${owner} = ${userId}`, true)}
      SELECT combined.*, ${methodNamesOf('combined', false)} FROM combined
    `;

    /*
     * The predicate, built once and applied to BOTH the page and the count.
     *
     * Sharing it is the point: two separately-assembled WHERE clauses are two
     * things that can drift, and the failure is a total that disagrees with the
     * rows beside it. "Showing 25 of 312" where 312 counted something else is a
     * number a client cannot act on and cannot tell is wrong.
     *
     * It reads from combined, so a filter covers transfers and payments alike
     * — a client narrowing to "pending" sees every pending movement, not the
     * pending half of one table.
     */
    const where = this.clientHistoryWhere(query);

    /*
     * The sort column, resolved through a MAP rather than by interpolation.
     *
     * The DTO's `@IsIn` already closes the set, but this is what makes the
     * closure structural: there is no path from a request string to a SQL
     * identifier, only a lookup that either finds a known fragment or falls back
     * to created_at. That matters more here than it did before — this
     * statement is assembled as SQL text rather than by the query builder.
     *
     * ⚠️ REWRITTEN. The paragraph above describes what this used to do and why
     * that was thought sufficient; both halves were wrong in the same way.
     *
     *   const column = sortable[query.sort ?? 'createdAt'] ?? sortable.createdAt;
     *
     * A bracket lookup with no `hasOwnProperty` guard walks the PROTOTYPE, so
     * `?sort=constructor` resolves to `Object` — truthy, so the `??` never
     * fires. That is the identical shape of the bug `sorting.ts` and
     * `users.store.ts` were written about after `?sort=constructor` 500'd the
     * client list and its CSV export. The only thing holding it shut here was
     * `@IsIn` on the DTO, which is a second guard rather than this one working.
     *
     * The `??` fallback was wrong on its own terms too: R-2.5 requires an
     * unrecognised sort to be a 400 naming the allowlist, never a silent
     * substitution — "a sort the server ignored is a lie the UI tells". And
     * `order` accepted anything, silently meaning DESC, where `sortOrder`
     * throws.
     *
     * All three are now the shared helpers, which is what the other twelve sort
     * surfaces already use.
     */
    const key = sortKey(query.sort, CLIENT_TRANSACTION_SORT_COLUMNS, 'createdAt', 'transactions');
    const column = CLIENT_TRANSACTION_SORT_COLUMNS[key];
    const order = sortOrder(query.order) === 'asc' ? sql`ASC` : sql`DESC`;

    /*
     * The ORDER BY carries a TIE-BREAKER on id, and it is not cosmetic.
     *
     * Sorting by state or currency puts many rows on the same value, and
     * Postgres gives no guarantee about their relative order between queries —
     * so paging such a sort can show one row twice and skip another entirely.
     * The id is unique, which makes the total order deterministic.
     *
     * It matters more here than it did before: the rows come from two tables, so
     * even a sort by created_at can land a transfer and a payment on the same
     * instant.
     */
    const [rows, counted] = await Promise.all([
      this.db.execute(sql`
        ${selection}
        ${where}
        ORDER BY ${column} ${order}, id DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}
      `),
      this.db.execute(sql`
        WITH counted AS (${selection}${where})
        SELECT COUNT(*)::int AS value FROM counted
      `),
    ]);

    /*
     * Raw SQL returns the database's own column names, so the mapping to the
     * shape both frontends read happens here rather than being handed to them
     * by the query builder. Every field is named explicitly: a `SELECT *` spread
     * would quietly start shipping any column added to `transactions` later,
     * including ones a client should not see.
     *
     * ⚠️ It named the desk's payout state anyway — the provider payout id,
     * the submission claim, the attention flag and its reason — plus
     * the rail key and a transfer destination, and shipped them to the client.
     * The shape is `TransactionView` now (transaction-view.ts), so the compiler
     * refuses a field `TransactionDto` does not declare.
     */
    return {
      items: (rows.rows as unknown as CombinedRow[]).map((row) => ({
        id: row.id,
        userId: row.user_id,
        walletId: row.wallet_id,
        direction: row.direction,
        amount: money(row.amount),
        currency: row.currency,
        state: row.state,
        methodKey: row.method_key,
        provider: row.provider,
        providerRef: row.provider_ref,
        destination: row.destination,
        proofFilename: row.proof_filename,
        proofDetails: row.proof_details,
        rejectionReason: row.rejection_reason,
        // The Arabic written with it (0179); the controller falls back to the catalogue.
        ...(row.rejection_reason_ar ? { rejectionReasonAr: row.rejection_reason_ar } : {}),
        reviewedBy: row.reviewed_by,
        reviewedAt: instantOrNull(row.reviewed_at),
        settledAt: instantOrNull(row.settled_at),
        providerPaymentId: row.provider_payment_id,
        createdAt: instantOf(row.created_at),
        methodName: row.method_name,
        methodNameAr: row.method_name_ar ?? rebateNameArabic(row.kind, row.method_name),
        kind: row.kind,
        tradingAccountId: row.trading_account_id,
      })),
      total: (counted.rows[0] as unknown as { value: number } | undefined)?.value ?? 0,
      page,
      limit,
    };
  }

  /**
   * The WHERE over a client's `combined` history, shared by the page, its count
   * and the summary so the three can never describe different rows.
   */
  private clientHistoryWhere(query: ListTransactionsQueryDto): SQL {
    const filters = [
      ...(query.direction ? [sql`direction = ${query.direction}`] : []),
      ...(query.state ? [sql`state = ${query.state}`] : []),
      ...(query.currency ? [sql`currency = ${query.currency}`] : []),
      // Any of the kinds asked for — see the DTO for why direction cannot
      // separate a deposit from a transfer back out of a trading account.
      ...(query.kind?.length
        ? [
            sql`kind IN (${sql.join(
              query.kind.map((kind) => sql`${kind}`),
              sql`, `,
            )})`,
          ]
        : []),
      // `[from, until)`, the column bare for its index — `common/date-range.ts`.
      ...withinRange(sql`created_at`, dateRangeQuery(query.from, query.to)),
    ];

    return filters.length ? sql` WHERE ${sql.join(filters, sql` AND `)}` : sql``;
  }

  /**
   * Count and total per (currency, direction, state) over the client's FILTERED
   * history —
   * every matching row, not a page.
   *
   * The tiles on the Deposit, Withdraw and Transfer screens read this: "how
   * much have I deposited", "how much is still pending". Summed in SQL over
   * NUMERIC, returned as decimal strings, and never across currencies — there
   * is no FX source, so USD and USDT stay separate lines.
   *
   * Paging and sort are ignored: a summary of one page is the under-report
   * R-2.5 names.
   */
  async summaryForUser(
    userId: number,
    query: ListTransactionsQueryDto = {},
  ): Promise<
    { currency: string; direction: string; state: string; count: number; total: string }[]
  > {
    const selection = sql`${this.movementsCte(({ owner }) => sql` WHERE ${owner} = ${userId}`, true)}
      SELECT * FROM combined
    `;
    const where = this.clientHistoryWhere(query);
    const result = await this.db.execute(sql`
      WITH filtered AS (${selection}${where})
      SELECT currency, direction, state,
             COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::text AS total
      FROM filtered
      GROUP BY currency, direction, state
      ORDER BY currency, direction, state
    `);
    return (
      result.rows as unknown as {
        currency: string;
        direction: string;
        state: string;
        count: number;
        total: string;
      }[]
    ).map((row) => ({
      currency: row.currency,
      direction: row.direction,
      state: row.state,
      count: row.count,
      total: money(row.total),
    }));
  }

  /**
   * The pieces every admin read of the union assembles — the CTE with the
   * actor's scope applied PER ARM, the `users` join, and one predicate builder
   * shared by the page, the total, both count facets, the summary and the
   * export. Sharing the builder is the point: two separately-assembled WHERE
   * clauses are two things that can drift, and here the failure would be a
   * count or a file describing rows the list refused to show.
   */
  private adminMovements(filter: AdminMovementsFilter) {
    const whereOf = (conditions: SQL[]): SQL =>
      conditions.length ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

    /*
     * The SEARCH: a Portal ID or a name/email (`clientIdentitySearch`, the one
     * expression every client search shares), plus what identifies an offline
     * deposit (`depositEvidenceSearch`). The matching clients are resolved ONCE
     * per statement (`searched`, by the users indexes), and each arm below reads
     * only their rows through its own `user_id` index — the deposits the evidence
     * names through the primary key. Matched against the union's output instead,
     * it read every movement there is to find one client's eight: ~0.8 s at
     * 160,000 rows for an exact Portal ID (29 Sep 2026).
     */
    const q = filter.q?.trim() || undefined;
    const evidence = q ? depositEvidenceSearch(q) : undefined;
    const searched = q
      ? sql`searched AS MATERIALIZED (SELECT users.id FROM users WHERE ${clientIdentitySearch(q)})`
      : undefined;

    const deskRoutes = filter.deskDecided
      ? sql.join(
          this.providers
            .deskDecidedRoutes()
            .map((r) => sql`(${r.direction}, ${r.providerCode}, ${r.channelCode})`),
          sql`, `,
        )
      : undefined;
    const methodList = filter.methods?.length
      ? sql.join(
          filter.methods.map((key) => sql`${key}`),
          sql`, `,
        )
      : undefined;
    const cte = this.movementsCte(
      ({ owner, id, payments, route, methodKeys }) => {
        const conditions: SQL[] = [];
        // A person decides it (0168) — only a payment can be one.
        if (deskRoutes) conditions.push(route ? sql`${route} IN (${deskRoutes})` : sql`FALSE`);
        // Through one of these methods — only a payment has one.
        if (methodList) {
          conditions.push(
            methodKeys
              ? sql`(${methodKeys[0]} IN (${methodList}) OR ${methodKeys[1]} IN (${methodList}))`
              : sql`FALSE`,
          );
        }
        /*
         * In the ARM's WHERE clause: an out-of-scope movement never enters the
         * union, so it also cannot appear in the counts, the summary or the
         * export computed from it — the same rule `listForAdmin` states for the
         * withdrawal queue, applied one level deeper.
         */
        const scoped = clientScopePredicate(filter.scope, owner);
        if (scoped) conditions.push(scoped);
        // Validated as a Portal ID at the edge.
        if (filter.userId) conditions.push(sql`${owner} = ${filter.userId}::integer`);
        // Validated as a uuid at the edge; every arm's id column is a uuid.
        if (filter.id) conditions.push(sql`${id} = ${filter.id}::uuid`);
        if (searched) {
          const byClient = sql`${owner} = ANY(ARRAY(SELECT searched.id FROM searched))`;
          conditions.push(
            payments && evidence ? sql`(${byClient} OR ${id} = ANY(ARRAY(${evidence})))` : byClient,
          );
        }
        return whereOf(conditions);
        /*
         * FALSE — no rebate arm on the admin Financial list.
         *
         * This screen is deposits, withdrawals and transfers: the movements an
         * operator acts on or reconciles against a provider. A rebate is neither
         * — it is an internal credit the commission engine produced — and at one
         * payout per minute it buried the rows the page exists for.
         *
         * Not a loss of visibility: /commissions lists every accrual with the
         * partner, the client, the rate and the rung, which is strictly more than
         * a movement row can carry. The CLIENT's own history keeps the arm — see
         * the parameter's note, and `listForUser` above.
         */
      },
      false,
      searched,
    );

    /*
     * Every count and sum reads the bare union — the client columns are for
     * display, and a join Postgres cannot eliminate would cost one `users`
     * probe per movement for numbers it cannot change (the FK is NOT NULL).
     */
    const countSource = sql`${cte} SELECT combined.* FROM combined`;

    /*
     * One PAGE of the union, then its clients (29 Sep 2026). Joined first, every
     * movement was matched to its client and the whole union sorted to keep 26
     * rows; chosen first, each arm reads its own index in order and the client is
     * looked up for the page alone. INNER, because every movement's user_id is a
     * NOT NULL FK onto users, so the join can drop nothing. `column` is a key of
     * a closed map (`ADMIN_TRANSACTION_SORT_COLUMNS.pageColumn`, or the export's
     * fixed `created_at`), never request text.
     */
    const page = (
      conditions: SQL[],
      order: { column: 'created_at' | 'amount' | 'state'; direction: SortOrder },
      limit: number,
      offset = 0,
    ): SQL => {
      const dir = order.direction === 'asc' ? sql`ASC` : sql`DESC`;
      return sql`
        ${cte},
        page AS (
          SELECT combined.* FROM combined${whereOf(conditions)}
          ORDER BY ${sql.raw(`combined.${order.column}`)} ${dir}, combined.id ${dir}
          LIMIT ${limit} OFFSET ${offset}
        )
        SELECT
          page.*,
          ${methodNamesOf('page', true)},
          users.email      AS user_email,
          users.first_name AS user_first_name,
          users.last_name  AS user_last_name,
          users.id         AS user_portal_id
        FROM page
        JOIN users ON users.id = page.user_id
        ORDER BY ${sql.raw(`page.${order.column}`)} ${dir}, page.id ${dir}`;
    };

    /*
     * `omit` is how the count facets stay honest — the same two-axis rule the
     * withdrawal queue documents, applied SYMMETRICALLY: each facet ignores
     * exactly ITS OWN axis (state tabs ignore the state filter, direction
     * tabs the direction filter) and honours every other filter, so the two
     * facet rows on one screen always describe the same filtered set. NOTHING
     * may ever omit the scope or the search — both live in the CTE's arms,
     * upstream of every caller of this builder.
     *
     * Postgres pushes each of these into every arm, where 0165's indexes serve
     * them: a status tab reads `(state, created_at, id)`, a currency its own,
     * "needs attention" a partial index of the few flagged rows.
     */
    const conditionsFor = (omit: { state?: boolean; direction?: boolean } = {}): SQL[] => {
      const conditions: SQL[] = [];
      if (!omit.direction && filter.direction) {
        conditions.push(sql`combined.direction = ${filter.direction}`);
      }
      if (filter.kind) conditions.push(sql`combined.kind = ${filter.kind}`);
      if (!omit.state && filter.state) conditions.push(sql`combined.state = ${filter.state}`);
      if (filter.currency) conditions.push(sql`combined.currency = ${filter.currency}`);
      if (filter.attention) conditions.push(sql`combined.needs_attention`);
      /*
       * `[from, until)` instants, SARGABLE: the column is left bare for the 0094
       * indexes to range-scan (`created_at::date >= x` casts every row and no
       * b-tree can serve it). A date-only bound is a UTC day (date-range.ts), the
       * same day the daily totals (0165) count.
       */
      conditions.push(...withinRange(sql`combined.created_at`, filter));
      return conditions;
    };

    return { countSource, page, conditionsFor, whereOf };
  }

  /**
   * The platform-wide money-movement list — GET /admin/transactions.
   *
   * The union `listForUser` reads, minus the pinned owner, plus the actor's
   * client scope, the `users` join, a keyset cursor and two count facets. The
   * response never carries a monetary NUMBER: `money()` normalises every
   * amount to the string the column holds (§6.1).
   */
  async listAllForAdmin(
    filter: AdminMovementsFilter & {
      page?: number;
      limit?: number;
      /** Keyset position — R-2.4. When present, `page` is ignored. */
      cursor?: CursorPosition;
      /** R-2.5 server-side sort. Validated by `sortKey` before it gets here. */
      sort?: AdminTransactionSortKey;
      order?: SortOrder;
    },
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = pageSize(filter.limit);
    const sortKey: AdminTransactionSortKey = filter.sort ?? DEFAULT_ADMIN_TRANSACTION_SORT;
    const direction = filter.order ?? 'desc';
    const sortSpec = ADMIN_TRANSACTION_SORT_COLUMNS[sortKey];

    const { countSource, page: pageOf, conditionsFor, whereOf } = this.adminMovements(filter);

    /*
     * Keyset seek — R-2.4, the same tuple comparison `listForAdmin` documents.
     * `cursorSeek` validates the cursor's value and id against the sort key's
     * own type BEFORE casting, so a tampered cursor is a 400, not a 22P02.
     */
    const pageConditions = conditionsFor();
    if (filter.cursor) {
      const comparator = direction === 'asc' ? sql`>` : sql`<`;
      pageConditions.push(cursorSeek(sortSpec, filter.cursor, comparator));
    }

    const usingCursor = Boolean(filter.cursor) || page <= 1;

    /*
     * Three reads, one predicate builder. The facets deliberately EXCLUDE the
     * cursor seek — a count that shrank as the admin paged would describe
     * "what is after where I am", not the list — and each facet excludes
     * exactly its own axis (see `adminMovements.conditionsFor`). There is no
     * separate total query: the state facet keeps every filter but state, so
     * the fully-filtered total is its own state's bucket (or `all` when no
     * state is filtered) — a fourth scan of the union would recompute a
     * number this response already carries.
     *
     * The facets come from STORED TOTALS (0165) whenever the filter is one they
     * can answer (`movementTotalsSource`). Counting the union here cost ~200 ms
     * at 160,000 rows and grew with every deposit; the totals grow with days
     * and clients, not movements, and are exact (see `movementTotalsQuery`).
     */
    const totals = movementTotalsSource(filter) !== undefined;
    const [rows, stateRows, directionRows] = await Promise.all([
      this.db.execute(
        pageOf(
          pageConditions,
          { column: sortSpec.pageColumn, direction },
          limit + 1,
          usingCursor ? 0 : (page - 1) * limit,
        ),
      ),
      totals
        ? this.db.execute(movementTotalsQuery(filter, 'state'))
        : this.db.execute(sql`
            WITH counted AS (${countSource}${whereOf(conditionsFor({ state: true }))})
            SELECT state, count(*)::int AS value FROM counted GROUP BY state
          `),
      totals
        ? this.db.execute(movementTotalsQuery(filter, 'direction'))
        : this.db.execute(sql`
            WITH counted AS (${countSource}${whereOf(conditionsFor({ direction: true }))})
            SELECT direction, count(*)::int AS value FROM counted GROUP BY direction
          `),
    ]);

    const counts: Record<string, number> = { all: 0 };
    for (const row of stateRows.rows as unknown as { state: string; value: number }[]) {
      counts[row.state] = row.value;
      counts['all'] += row.value;
    }
    const directionCounts: Record<string, number> = { all: 0 };
    for (const row of directionRows.rows as unknown as { direction: string; value: number }[]) {
      directionCounts[row.direction] = row.value;
      directionCounts['all'] += row.value;
    }

    const total = filter.state ? (counts[filter.state] ?? 0) : counts['all'];

    /*
     * Relabelled before `buildCursorPage` for the reason `listForAdmin`
     * records: the cursor is minted by reading `row[sort]`, so the row must
     * carry the sort key under that name. `created_at` stays the RAW Postgres
     * literal — microseconds intact — because the cursor's whole job is to
     * name an exact position: a Date here would truncate to milliseconds, and
     * the next page's `< boundary` seek would skip every row sharing the
     * boundary's millisecond with smaller microseconds. The literal
     * round-trips through `::timestamptz` losslessly.
     */
    const paged = buildCursorPage(
      (rows.rows as unknown as AdminCombinedRow[]).map((row) => ({
        ...row,
        createdAt: row.created_at,
      })),
      limit,
      total,
      sortKey,
    );

    const items = paged.items.map((row) => ({
      ...toMovementRow(row),
      tradingAccountId: row.trading_account_id,
      walletId: row.wallet_id,
      // The row's badge and its "Mark resolved" — the finish line of the
      // attention task the admin followed here (0140).
      needsAttention: row.needs_attention,
      attentionReason: row.attention_reason,
      providerNote: row.provider_note,
      user: {
        id: row.user_id,
        portalId: row.user_portal_id,
        email: row.user_email,
        firstName: row.user_first_name,
        lastName: row.user_last_name,
      },
    }));

    return { items, nextCursor: paged.nextCursor, total, page, limit, counts, directionCounts };
  }

  /**
   * One batch of the Financial list for a CSV export — the same filters and
   * the same scope as `listAllForAdmin`, without the page-size ceiling, for
   * the reasons `listForExport` records (an export's promise is every matching
   * row, not the page on screen).
   *
   * ── KEYSET batches under a SNAPSHOT bound, not OFFSET ─────────────────────
   *
   * Two failure modes of offset batching, both real on "an archive the whole
   * platform keeps writing to":
   *
   *  - Correctness: a movement inserted mid-export is newest, sorts to
   *    position 0 under `created_at DESC`, and pushes every already-streamed
   *    row down one — so the row at each later batch boundary is emitted
   *    TWICE, and a reconciliation spreadsheet double-counts its amount. The
   *    `startedAt` bound closes that door regardless of batching: rows
   *    created after the export began are excluded from every batch, so the
   *    result set is frozen for the export's lifetime.
   *  - Cost: `OFFSET n` walks and discards n rows, so a cap-sized export
   *    re-sorts the whole archive once per batch — quadratic in total. The
   *    `after` keyset makes each batch seek directly to its start, the same
   *    `(created_at, id)` tuple the list's cursor uses, with the raw
   *    microsecond literal as the boundary so no row sharing a millisecond is
   *    skipped.
   */
  async listAllForExport(
    filter: AdminMovementsFilter & {
      limit: number;
      /** The instant the export STARTED — same value on every batch. */
      startedAt: Date;
      /** The previous batch's last row, from `cursorCreatedAt` + `id`. */
      after?: { createdAt: string; id: string };
    },
  ): Promise<AdminTransactionExportRow[]> {
    const { page, conditionsFor } = this.adminMovements(filter);

    const conditions = conditionsFor();
    conditions.push(sql`combined.created_at <= ${filter.startedAt.toISOString()}::timestamptz`);
    if (filter.after) {
      conditions.push(
        sql`(combined.created_at, combined.id) < (${filter.after.createdAt}::timestamptz, ${filter.after.id}::uuid)`,
      );
    }

    const rows = await this.db.execute(
      page(conditions, { column: 'created_at', direction: 'desc' }, filter.limit),
    );

    return (rows.rows as unknown as AdminCombinedRow[]).map((row) => ({
      // The shared mapper — the CSV must describe a row exactly as the screen
      // does, §6.1 string amount included.
      ...toMovementRow(row),
      userId: row.user_id,
      userPortalId: row.user_portal_id,
      userEmail: row.user_email,
      userFirstName: row.user_first_name,
      userLastName: row.user_last_name,
      cursorCreatedAt: row.created_at,
    }));
  }

  /**
   * Server-computed totals for the Financial page's tiles — every group keyed
   * by CURRENCY, because a sum across currencies is not a number (one group's
   * '100.00000000' USD and another's USDT share no unit). The page renders
   * these strings or nothing; it never adds them.
   *
   * Two granularities from one predicate: `rows` is the full breakdown
   * (direction × kind × state × currency) and `directions` the headline pair
   * a tile shows — both computed HERE so no caller ever aggregates the fine
   * rows into the coarse ones client-side.
   */
  async summarizeForAdmin(filter: AdminMovementsFilter): Promise<{
    rows: {
      direction: string;
      kind: MovementKind;
      state: string;
      currency: string;
      count: number;
      total: string;
    }[];
    directions: { direction: string; currency: string; count: number; total: string }[];
  }> {
    const { countSource, conditionsFor, whereOf } = this.adminMovements(filter);

    /*
     * ONE scan for both granularities — GROUPING SETS aggregates the fine
     * breakdown and the per-direction headline in a single pass over the
     * union, where two queries would scan every money table twice for numbers
     * derived from the same rows. The coarse set leaves `kind`/`state` NULL,
     * which is unambiguous because both are NOT NULL on every real row.
     */
    // The stored totals (0165) answer every filter they can — see `movementTotalsSource`.
    const grouped = movementTotalsSource(filter)
      ? await this.db.execute(movementTotalsQuery(filter, 'summary'))
      : await this.db.execute(sql`
      WITH counted AS (${countSource}${whereOf(conditionsFor())})
      SELECT
        direction,
        kind,
        state,
        currency,
        count(*)::int AS value,
        -- ::text, so the NUMERIC(28,8) crosses this boundary as a string
        -- whatever the driver does (§6.1); coalesce is belt-and-braces — a
        -- group only exists because rows do, so the sum cannot be null.
        coalesce(sum(amount), 0)::text AS total
      FROM counted
      GROUP BY GROUPING SETS ((direction, kind, state, currency), (direction, currency))
      ORDER BY direction, kind NULLS LAST, state, currency
    `);
    const allRows = grouped.rows as unknown as {
      direction: string;
      kind: MovementKind | null;
      state: string | null;
      currency: string;
      value: number;
      total: string;
    }[];
    const fineRows = allRows.filter(
      (row): row is (typeof allRows)[number] & { kind: MovementKind; state: string } =>
        row.kind !== null,
    );
    const byDirection = allRows.filter((row) => row.kind === null);

    return {
      rows: fineRows.map((row) => ({
        direction: row.direction,
        kind: row.kind,
        state: row.state,
        currency: row.currency,
        count: row.value,
        // Never Number(row.total) — the string IS the value (§6.1).
        total: row.total,
      })),
      directions: byDirection.map((row) => ({
        direction: row.direction,
        currency: row.currency,
        count: row.value,
        total: row.total,
      })),
    };
  }
}
