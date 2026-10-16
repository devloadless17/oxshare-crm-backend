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
import {
  buildCursorPage,
  pageSize,
  TOTAL_CAP,
  walkOrder,
  type CursorPosition,
  type PageDirection,
} from '../../../common/pagination';
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
import Decimal from 'decimal.js';
import {
  MOVEMENT_GROUPS,
  MOVEMENT_TYPES,
  bucketCase,
  effectOf,
  type MovementEffect,
  type SettlementBucket,
  totalsTypeCase,
  totalsTypesPredicate,
  unionTypeCase,
  unionTypesPredicate,
  type MovementType,
} from '../movement-type';
import type { TransferOrigin } from '../transfer-provenance';
import { movementDetails, type MovementDetailRow, type MovementDetails } from './movement-details';
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
/**
 * The kinds a TRANSFERS read may return, narrowed by its origin filter (16 Oct 2026). Forced by the
 * Transfers endpoints whatever the caller asked: it is the wall between a transfers reader and
 * every payment on the platform. `commission` is the commission arm's; every other origin is a
 * wallet ⇄ account transfer's.
 */
export function transferKindsFor(origins: readonly TransferOrigin[] | undefined): MovementKind[] {
  if (!origins?.length) return ['transfer', 'commission_transfer'];
  const kinds: MovementKind[] = [];
  if (origins.some((origin) => origin !== 'commission')) kinds.push('transfer');
  if (origins.includes('commission')) kinds.push('commission_transfer');
  return kinds;
}

/** The id an unknown account filter resolves to: no row has it, so the list is simply empty. */
const NIL_ACCOUNT = '00000000-0000-0000-0000-000000000000';

/** The most clients a money-list search may name — see `assertSearchNarrow`. */
const MAX_SEARCHED_CLIENTS = 1_000;

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
  /** Where a transfer's money came from (0226); 'commission' on the commission arm; else null. */
  transfer_origin: TransferOrigin | null;
}

/** The admin Financial list's raw rows: the union's columns plus the client. */
type AdminCombinedRow = CombinedRow &
  MovementDetailRow & {
    user_email: string;
    user_first_name: string;
    user_portal_id: number;
    user_last_name: string;
  };

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
  /** Any of these kinds (the HTTP `kind` is a one-item list; the Transfers page forces two). */
  kinds?: readonly MovementKind[];
  /** Any of these accounting types (`movement-type.ts`) — the Financial tabs and Type filter. */
  types?: readonly MovementType[];
  /**
   * Any of these transfer origins (0226). Only the transfer and commission arms carry one, so the
   * payment arm never matches. Read live: no stored total is kept per origin.
   */
  origins?: readonly TransferOrigin[];
  /**
   * One trading account's transfers, by its id — resolved from a login at the edge, and the NIL
   * uuid for an unknown or out-of-territory one, so the answer never says whether it exists.
   */
  tradingAccountId?: string;
  state?: MovementState;
  currency?: string;
  /** Free text over the client's email and name — see `listForAdmin.q`. */
  q?: string;
  /** `[from, until)` instants — `common/date-range.ts`. */
  from?: Date;
  until?: Date;
  /**
   * The SETTLED period (audit R4-1, 16 Oct 2026): `[from, until)` on `settled_at`, so a closed
   * month's settled figure never moves. Read live — the stored totals key only by creation day.
   */
  settled?: { from?: Date; until?: Date };
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
  /** The same fact as SQL, for a clause that must hold on any arm's rows. */
  isPayment: SQL;
  /**
   * `(direction, provider_code, channel_code)` on the payments arm (0168): the
   * route a movement took, for filters that ask who settles it. Null on the arms
   * that carry no route.
   */
  route: SQL | null;
  /** The payments arm's two method-key columns (deposit, withdrawal); absent elsewhere. */
  methodKeys?: [SQL, SQL];
  /** The movement's wallet; given in outer mode, where the admin search reads it. */
  wallet?: SQL;
  /**
   * The trading account a movement names: a transfer's account, and the account a DEPOSIT was
   * aimed at (audit R4-3) — given in outer mode.
   */
  accounts?: [SQL, SQL];
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
export function movementTotalsSource(
  filter: AdminMovementsFilter,
): 'daily' | 'client' | 'tag' | undefined {
  // One record (`id`) is a live read — no total is kept per row.
  // No total is kept per method either.
  // The desk's own rows ARE kept since 0221: the totals carry each payment's route.
  if (filter.q?.trim() || filter.attention || filter.id) return undefined;
  if (filter.methods?.length) return undefined;
  // No total is kept per transfer origin or per trading account (0226): read the rows.
  if (filter.origins?.length || filter.tradingAccountId) return undefined;
  // The stored totals key by CREATION day; a settled period reads the rows (audit R4-1).
  if (filter.settled?.from || filter.settled?.until) return undefined;
  /*
   * The daily totals are UTC days: they answer a period only when it starts and
   * ends on UTC midnights. A viewer's own "today" in Beirut does not, so it reads
   * the live rows — narrowed by the range to a few, through the created_at index.
   */
  if (filter.scope.unrestricted && filter.userId === undefined) {
    return isUtcDayAligned(filter) ? 'daily' : undefined;
  }
  if (filter.from || filter.until) return undefined;
  /*
   * ONE tag, nobody pinned: the tag's own kept totals (0218), the same cost for
   * a book of ten or of a million. Several tags cannot be added together — a
   * client carrying two would count twice — so they read per client.
   */
  if (
    filter.userId === undefined &&
    !filter.scope.unrestricted &&
    filter.scope.tagIds.length === 1
  ) {
    return 'tag';
  }
  return 'client';
}

/** One route a desk decides: a direction on a provider's channel (0168). */
interface DeskRoute {
  direction: string;
  providerCode: string;
  channelCode: string;
}

/** The per-day or per-client totals plus their unfolded deltas, as `m`. */
function keyedTotalsSource(totals: 'daily' | 'client', where: SQL): SQL {
  const key = totals === 'daily' ? sql`day` : sql`user_id`;
  const table = totals === 'daily' ? sql`movement_daily_totals` : sql`movement_client_totals`;
  /*
   * The filter goes INSIDE each half, and the outer select has none. Outside,
   * a territory was a hash join against a scan of EVERY client's totals on
   * every money list (173 ms at 1M clients for a book of 2,000); inside, each
   * half is read through its key for the territory's clients only (8 ms).
   */
  return sql`
    WITH m AS (
      SELECT ${key}, kind, direction, state, currency, route, count, total FROM ${table} m${where}
      UNION ALL
      SELECT ${key}, kind, direction, state, currency, route, count, total
        FROM movement_total_deltas m${where}
    )`;
}

/**
 * One tag's kept totals (0218), exact at this instant, as `m`:
 * what is folded, plus the client totals of whoever joined or left the tag
 * since the last fold, plus the unfolded movements of everyone carrying it now.
 */
function tagTotalsSource(tagId: string, where: SQL): SQL {
  return sql`
    WITH every AS (
      SELECT kind, direction, state, currency, route, count, total
        FROM movement_tag_totals WHERE tag_id = ${tagId}::uuid
      UNION ALL
      SELECT c.kind, c.direction, c.state, c.currency, c.route, e.sign * c.count, e.sign * c.total
        FROM movement_tag_member_events e
        JOIN movement_client_totals c ON c.user_id = e.user_id
       WHERE e.tag_id = ${tagId}::uuid
      UNION ALL
      SELECT d.kind, d.direction, d.state, d.currency, d.route, d.count, d.total
        FROM movement_total_deltas d
       WHERE EXISTS (
         SELECT 1 FROM client_tag_assignments a
          WHERE a.user_id = d.user_id AND a.tag_id = ${tagId}::uuid
       )
    ), m AS (SELECT * FROM every${where})`;
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
  /**
   * `type` — counts per accounting type, its own axis left out (the Financial tabs).
   * `accounting` — count and total per currency × type × settlement bucket (the tiles).
   */
  shape: 'state' | 'direction' | 'summary' | 'type' | 'accounting',
  /** The routes a person decides (`deskDecidedRoutes`): read only for `deskDecided`. */
  deskRoutes: readonly DeskRoute[] = [],
): SQL {
  const totals = movementTotalsSource(filter);
  if (!totals) throw new Error('movementTotalsQuery: no stored totals answer this filter');
  const conditions: SQL[] = [];
  if (filter.deskDecided) {
    // The same routes the live rows are matched on, as the totals key them (0221).
    conditions.push(
      deskRoutes.length === 0
        ? sql`FALSE`
        : sql`kind = 'payment' AND (direction, route) IN (${sql.join(
            deskRoutes.map((r) => sql`(${r.direction}, ${`${r.providerCode}:${r.channelCode}`})`),
            sql`, `,
          )})`,
    );
  }
  if (filter.kinds?.length) {
    conditions.push(
      sql`kind IN (${sql.join(
        filter.kinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})`,
    );
  }
  if (filter.types?.length && shape !== 'type') conditions.push(totalsTypesPredicate(filter.types));
  if (filter.currency) conditions.push(sql`currency = ${filter.currency}`);
  if (shape !== 'direction' && filter.direction) {
    conditions.push(sql`direction = ${filter.direction}`);
  }
  if (shape !== 'state' && filter.state) conditions.push(sql`state = ${filter.state}`);
  if (totals === 'daily') {
    if (filter.from) conditions.push(sql`day >= ${utcDate(filter.from)}::date`);
    if (filter.until) conditions.push(sql`day < ${utcDate(filter.until)}::date`);
  } else if (totals === 'client') {
    const scoped = clientScopePredicate(filter.scope, sql`m.user_id`);
    if (scoped) conditions.push(scoped);
    if (filter.userId !== undefined) conditions.push(sql`m.user_id = ${filter.userId}::integer`);
  }
  const where = conditions.length ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  const source =
    totals === 'tag'
      ? tagTotalsSource(filter.scope.tagIds[0], where)
      : keyedTotalsSource(totals, where);
  if (shape === 'summary') {
    return sql`${source}
      SELECT direction, kind, state, currency,
             sum(count)::int AS value, sum(total)::text AS total
        FROM m
       GROUP BY GROUPING SETS ((direction, kind, state, currency), (direction, currency))
      HAVING sum(count) <> 0
       ORDER BY direction, kind NULLS LAST, state, currency`;
  }
  if (shape === 'type') {
    return sql`${source}
      SELECT ${totalsTypeCase()} AS type, sum(count)::int AS value FROM m
       GROUP BY 1 HAVING sum(count) <> 0`;
  }
  if (shape === 'accounting') {
    return sql`${source}
      SELECT currency, ${totalsTypeCase()} AS type, ${bucketCase(sql`state`)} AS bucket,
             sum(count)::int AS value, sum(total)::text AS total
        FROM m
       GROUP BY 1, 2, 3 HAVING sum(count) <> 0
       ORDER BY 1, 2, 3`;
  }
  const axis = shape === 'state' ? sql`state` : sql`direction`;
  return sql`${source}
    SELECT ${axis}, sum(count)::int AS value FROM m
     GROUP BY ${axis} HAVING sum(count) <> 0`;
}

/** One accounting line of the summary: a currency × type × settlement bucket. */
export interface AccountingLine {
  currency: string;
  type: MovementType;
  effect: MovementEffect;
  bucket: SettlementBucket;
  count: number;
  /** A decimal STRING (§6.1). */
  total: string;
}

/** A summary's money per currency × effect × settlement bucket (16 Oct 2026). */
export interface EffectTotal {
  currency: string;
  effect: MovementEffect;
  bucket: SettlementBucket;
  count: number;
  /** A decimal STRING (§6.1). */
  total: string;
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
  /** From where to where, who and why — the same facts the list row carries (16 Oct 2026). */
  details: MovementDetails;
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

const UUID_TERM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `wallet_number()`'s alphabet (0090): 12 characters, no i, l, o or u. */
const WALLET_NUMBER_TERM = /^[0-9a-hjkmnp-tv-z]{12}$/i;
const LOGIN_TERM = /^[0-9]{3,12}$/;
/** A provider's id or reference: one token, no spaces, short enough to be one. */
const PROVIDER_ID_TERM = /^[A-Za-z0-9._:-]{4,100}$/;

/**
 * What an operator may HOLD for one MOVEMENT rather than for a client (audit R4-2, 16 Oct 2026):
 * the movement's own id (a ledger row, a support thread), the reference the provider or the desk
 * gave it, the provider's payment or payout id, a wallet number, or an MT5 login. Each is an EXACT
 * match through its own index, so a search quoting any of them finds the movement instead of
 * reading as "no such movement". `ids` are movement ids (unique across every arm: uuids).
 */
function movementIdentifierSearch(q: string): {
  ids?: SQL;
  walletNumber?: string;
  login?: string;
} {
  const ids: SQL[] = [];
  if (UUID_TERM.test(q)) ids.push(sql`SELECT ${q.toLowerCase()}::uuid AS id`);
  if (PROVIDER_ID_TERM.test(q)) {
    ids.push(
      sql`SELECT pi.id FROM transactions pi WHERE pi.provider_ref IN (${q}, ${q.toUpperCase()})`,
    );
    ids.push(sql`SELECT pi.id FROM transactions pi WHERE pi.provider_payment_id = ${q}`);
    ids.push(sql`SELECT pi.id FROM transactions pi WHERE pi.provider_payout_id = ${q}`);
  }
  return {
    ids: ids.length ? sql.join(ids, sql` UNION `) : undefined,
    walletNumber: WALLET_NUMBER_TERM.test(q) ? q.toLowerCase() : undefined,
    login: LOGIN_TERM.test(q) ? q : undefined,
  };
}

/*
 * ── WHAT EVERY ADMIN MOVEMENT ROW SAYS ABOUT ITSELF (16 Oct 2026) ──────────────────────────────
 *
 * From where to where the money moved, who started it, who approved and who decided it, why, and
 * what the provider charged — read for the rows a page SHOWS, after it is cut, never inside the
 * union. Every join is a primary-key or unique-index probe on at most `limit` rows, so the cost is
 * the page's, not the book's. Admin reads only: the client's own history never selects this.
 *
 *   w / ta        the row's wallet and trading account (numbers and logins, never nicknames)
 *   tr / src      a transfer's provenance (0226) and the deposit or desk credit that funded it
 *   iwt / fw      a commission move's FROM wallet
 *   tx            the payment's own row, for what the union does not carry (fees, approval, reason)
 *   onward / dest a deposit aimed at an account: the transfer that moved it on — or none
 *   rq / ap / dc  the desk member who asked, approved, decided — by NAME, never email
 */
const MOVEMENT_DETAIL_COLUMNS = sql`
          w.wallet_number          AS wallet_number,
          w.kind                   AS wallet_kind,
          ta.login                 AS account_login,
          ta.environment           AS account_environment,
          fw.id                    AS from_wallet_id,
          fw.wallet_number         AS from_wallet_number,
          fw.kind                  AS from_wallet_kind,
          tr.source_transaction_id AS source_transaction_id,
          tr.requested_by_admin_id AS transfer_requested_by,
          tr.desk_reason           AS transfer_desk_reason,
          tr.desk_reason_ar        AS transfer_desk_reason_ar,
          src.provider             AS source_provider,
          src.provider_ref         AS source_ref,
          src.settled_at           AS source_settled_at,
          (SELECT coalesce(spm.internal_label, spm.name) FROM payment_methods spm
            WHERE spm.key = src.method_key) AS source_method_label,
          tx.approved_by_admin_id  AS approved_by,
          tx.approved_at           AS approved_at,
          tx.desk_reason           AS payment_desk_reason,
          tx.desk_reason_ar        AS payment_desk_reason_ar,
          tx.provider_environment  AS provider_environment,
          tx.provider_fee          AS provider_fee,
          tx.provider_net_amount   AS provider_net_amount,
          tx.provider_request_amount AS provider_request_amount,
          tx.provider_amount_received AS provider_amount_received,
          tx.requested_amount      AS requested_amount,
          tx.provider_status       AS provider_status,
          tx.provider_checked_at   AS provider_checked_at,
          onward.id                AS onward_transfer_id,
          onward.state             AS onward_state,
          dest.id                  AS onward_account_id,
          dest.login               AS onward_login,
          dest.environment         AS onward_environment,
          rq.name                  AS requested_by_name,
          ap.name                  AS approved_by_name,
          dc.name                  AS decided_by_name`;

const MOVEMENT_DETAIL_JOINS = sql`
        LEFT JOIN wallets w ON w.id = page.wallet_id
        LEFT JOIN trading_accounts ta ON ta.id = page.trading_account_id
        LEFT JOIN transfers tr ON page.kind = 'transfer' AND tr.id = page.id
        LEFT JOIN transactions src ON src.id = tr.source_transaction_id
        LEFT JOIN ib_wallet_transfers iwt ON page.kind = 'commission_transfer' AND iwt.id = page.id
        LEFT JOIN wallets fw ON fw.id = iwt.from_wallet_id
        LEFT JOIN transactions tx ON page.kind = 'payment' AND tx.id = page.id
        LEFT JOIN transfers onward ON page.kind = 'payment' AND onward.source_transaction_id = page.id
        LEFT JOIN trading_accounts dest
          ON dest.id = coalesce(onward.trading_account_id, tx.destination_trading_account_id)
        LEFT JOIN admins rq ON rq.id = coalesce(tr.requested_by_admin_id,
          CASE WHEN tx.provider_code = 'manual' AND tx.channel_code = 'adjustment'
               THEN tx.reviewed_by END)
        LEFT JOIN admins ap ON ap.id = tx.approved_by_admin_id
        LEFT JOIN admins dc ON dc.id = page.reviewed_by`;

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

  /** The routes a person decides, when the filter asks for the desk's own rows. */
  private deskRoutesOf(filter: AdminMovementsFilter): readonly DeskRoute[] {
    return filter.deskDecided ? this.providers.deskDecidedRoutes() : [];
  }
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
    /** Previous / Last walk the same index backward — `pageDirection`. */
    paging?: PageDirection;
  }) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = pageSize(filter.limit);
    const db = this.db;

    const sortKey: WithdrawalSortKey = filter.sort ?? DEFAULT_WITHDRAWAL_SORT;
    // The order the QUERY walks: the list's own, reversed for Previous / Last.
    const direction = walkOrder(filter.order ?? 'desc', filter.paging);
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
        // What the rail told the client when they requested it (0202).
        payToDetails: transactions.payToDetails,
        providerCode: transactions.providerCode,
        channelCode: transactions.channelCode,
        providerEnvironment: transactions.providerEnvironment,
        userId: transactions.userId,
        userPortalId: users.id,
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userPhone: users.phone,
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
        kinds: ['payment'],
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
      filter.paging ? { ...filter.paging, fromCursor: Boolean(filter.cursor) } : undefined,
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
      // What the rail told the client when they asked (0202).
      payToDetails: r.payToDetails,
      user: {
        id: r.userId,
        portalId: r.userPortalId,
        email: r.userEmail,
        firstName: r.userFirstName,
        lastName: r.userLastName,
        // The client's OWN phone, beside the destination the money goes to.
        phone: r.userPhone,
      },
    }));

    return {
      items,
      nextCursor: paged.nextCursor,
      prevCursor: paged.prevCursor,
      total,
      page,
      limit,
      counts,
      // Every count on this desk is exact; the field is the lists' shared shape.
      countsCapped: [] as string[],
    };
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
    /**
     * Apply `armWhere` ONCE, outside the union, instead of inside every arm.
     *
     * ⚠️ For any caller that pages or counts a LARGE set (the admin list).
     * Postgres keeps an arm that has its own WHERE as a separate sub-select and
     * plans it with no knowledge of the outer ORDER BY and LIMIT, so it never
     * walks an index in order: it fetched and sorted every matching movement to
     * show 25. Measured at 3M movements, 11 Oct 2026: the Deposits desk 250 ms
     * alone and 2 s under 25 administrators; 2 ms with the clause outside. A
     * clause outside is still pushed into every arm and still reads each arm's
     * own index. The pinned-owner callers keep theirs inside: one client's rows
     * are few, and their rebate arm is a join that is never flattened anyway.
     */
    outer = false,
  ): SQL {
    const arm = (columns: MovementArm): SQL => (outer ? sql`` : armWhere(columns));
    const whole = outer
      ? armWhere({
          owner: sql`movements.user_id`,
          id: sql`movements.id`,
          payments: true,
          isPayment: sql`movements.kind = 'payment'`,
          // NULL on the arms with no route, so no route list can match them.
          route: sql`(movements.direction, movements.route_provider, movements.route_channel)`,
          methodKeys: [sql`movements.method_key`, sql`movements.withdrawal_method_key`],
          wallet: sql`movements.wallet_id`,
          accounts: [
            sql`movements.trading_account_id`,
            sql`movements.destination_trading_account_id`,
          ],
        })
      : undefined;
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
          'deposit'::transaction_direction,
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
          NULL::uuid                              AS trading_account_id,
          NULL::varchar                           AS route_provider,
          NULL::varchar                           AS route_channel,
          NULL::transfer_origin                   AS transfer_origin
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
        ${arm({ owner: sql`w.user_id`, id: sql`le.id`, payments: false, isPayment: sql`FALSE`, route: null })}
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
      WITH ${prelude ? sql`${prelude},` : sql``} ${whole ? sql`movements` : sql`combined`} AS (
        SELECT
          t.id,
          t.user_id,
          t.wallet_id,
          /*
           * The ENUM, in every arm: cast to text here, a direction filter reaches
           * the planner as an expression it has no statistics for, it expects a
           * handful of rows where half the table matches, and sorts every row
           * of the tab to show 25 (11 Oct 2026).
           */
          t.direction                             AS direction,
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
          NULL::uuid                              AS trading_account_id,
          -- The route (0168), for the admin list's desk filter.
          t.provider_code                         AS route_provider,
          t.channel_code                          AS route_channel,
          -- Where a TRANSFER's money came from (0226): never on a payment.
          NULL::transfer_origin                   AS transfer_origin
        FROM transactions t
        ${arm({
          owner: sql`t.user_id`,
          id: sql`t.id`,
          payments: true,
          isPayment: sql`TRUE`,
          /*
           * The enum itself, never `::text`: a cast hides the column from the
           * planner's statistics, it then expects a handful of rows where half
           * the table matches, and sorts every pending deposit to show 25
           * (2 s on the desk under load, 11 Oct 2026). Compare with enum values.
           */
          route: sql`(t.direction, t.provider_code, t.channel_code)`,
          methodKeys: [sql`t.method_key`, sql`t.withdrawal_method_key`],
        })}

        UNION ALL

        SELECT
          tr.id,
          tr.user_id,
          tr.wallet_id,
          CASE WHEN tr.direction = 'account_to_wallet' THEN 'deposit' ELSE 'withdrawal' END::transaction_direction,
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
          -- WHO released it by hand (0230): the transfer's decider, named like a payment's.
          tr.released_by_admin_id,                -- reviewed_by
          CASE WHEN tr.released_by_admin_id IS NOT NULL
               THEN tr.settled_at END,            -- reviewed_at
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
          tr.trading_account_id,
          NULL::varchar,                          -- route_provider
          NULL::varchar,                          -- route_channel
          tr.origin                               -- transfer_origin, never cast (0226)
        FROM transfers tr
        ${arm({ owner: sql`tr.user_id`, id: sql`tr.id`, payments: false, isPayment: sql`FALSE`, route: null })}

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
          'deposit'::transaction_direction,
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
          NULL::uuid                              AS trading_account_id,
          NULL::varchar                           AS route_provider,
          NULL::varchar                           AS route_channel,
          'commission'::transfer_origin           AS transfer_origin
        FROM ib_wallet_transfers iwt
        ${arm({ owner: sql`iwt.user_id`, id: sql`iwt.id`, payments: false, isPayment: sql`FALSE`, route: null })}

        ${rebateArm}
      )${whole ? sql`, combined AS (SELECT movements.* FROM movements${whole})` : sql``}
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
        /*
         * NO reviewedBy (16 Oct 2026): which administrator decided is the desk's business,
         * not the client's — the KYC side strips the same field on purpose.
         */
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
    const named = q ? movementIdentifierSearch(q) : {};
    const searched = q
      ? sql`searched AS MATERIALIZED (SELECT users.id FROM users WHERE ${clientIdentitySearch(q)})`
      : undefined;

    const deskRoutes = filter.deskDecided
      ? sql.join(
          this.providers
            .deskDecidedRoutes()
            .map(
              (r) =>
                sql`(${r.direction}::transaction_direction, ${r.providerCode}, ${r.channelCode})`,
            ),
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
      ({ owner, id, payments, isPayment, route, methodKeys, wallet, accounts }) => {
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
         * In the definition of `combined` itself, upstream of every reader: an
         * out-of-scope movement never enters it, so it also cannot appear in
         * the counts, the summary or the
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
          // The client it names, OR a deposit's evidence, OR an identifier of the movement itself.
          const matches: SQL[] = [sql`${owner} = ANY(ARRAY(SELECT searched.id FROM searched))`];
          if (payments && evidence) {
            matches.push(sql`(${isPayment} AND ${id} = ANY(ARRAY(${evidence})))`);
          }
          if (named.ids) matches.push(sql`${id} = ANY(ARRAY(${named.ids}))`);
          if (named.walletNumber && wallet) {
            matches.push(sql`${wallet} = ANY(ARRAY(
              SELECT wn.id FROM wallets wn WHERE wn.wallet_number = ${named.walletNumber}))`);
          }
          if (named.login && accounts) {
            const ids = sql`ARRAY(SELECT la.id FROM trading_accounts la WHERE la.login = ${named.login})`;
            matches.push(sql`(${accounts[0]} = ANY(${ids}) OR ${accounts[1]} = ANY(${ids}))`);
          }
          conditions.push(
            matches.length === 1 ? matches[0] : sql`(${sql.join(matches, sql` OR `)})`,
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
      // Outside the union: see `outer` on movementsCte.
      true,
    );

    /*
     * Every count and sum reads the bare union — the client columns are for
     * display, and a join Postgres cannot eliminate would cost one `users`
     * probe per movement for numbers it cannot change (the FK is NOT NULL).
     */
    const countSource = sql`${cte} SELECT combined.* FROM combined`;
    // For counting only: no columns, so Postgres reads the index and not the rows.
    const countOnes = sql`${cte} SELECT 1 FROM combined`;

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
          users.id         AS user_portal_id,
          ${MOVEMENT_DETAIL_COLUMNS}
        FROM page
        JOIN users ON users.id = page.user_id
        ${MOVEMENT_DETAIL_JOINS}
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
    const conditionsFor = (
      omit: { state?: boolean; direction?: boolean; type?: boolean } = {},
    ): SQL[] => {
      const conditions: SQL[] = [];
      if (!omit.direction && filter.direction) {
        conditions.push(sql`combined.direction = ${filter.direction}::transaction_direction`);
      }
      if (filter.kinds?.length) {
        conditions.push(
          sql`combined.kind IN (${sql.join(
            filter.kinds.map((kind) => sql`${kind}`),
            sql`, `,
          )})`,
        );
      }
      // The accounting types (movement-type.ts): kind, wallet-side direction and the desk's route.
      if (!omit.type && filter.types?.length) conditions.push(unionTypesPredicate(filter.types));
      /*
       * Origin and account exist only on the transfer arms (0226). On every other arm the column
       * is a constant NULL, so the condition folds away and that arm is never read.
       */
      if (filter.origins?.length) {
        conditions.push(
          sql`combined.transfer_origin IN (${sql.join(
            filter.origins.map((origin) => sql`${origin}::transfer_origin`),
            sql`, `,
          )})`,
        );
      }
      if (filter.tradingAccountId) {
        // A transfer on it, or a DEPOSIT aimed at it — the one that "never moved" (audit R4-3).
        conditions.push(sql`(combined.trading_account_id = ${filter.tradingAccountId}::uuid
          OR combined.destination_trading_account_id = ${filter.tradingAccountId}::uuid)`);
      }
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
      conditions.push(...withinRange(sql`combined.settled_at`, filter.settled));
      return conditions;
    };

    return { countSource, countOnes, page, conditionsFor, whereOf };
  }

  /**
   * The platform-wide money-movement list — GET /admin/transactions.
   *
   * The union `listForUser` reads, minus the pinned owner, plus the actor's
   * client scope, the `users` join, a keyset cursor and two count facets. The
   * response never carries a monetary NUMBER: `money()` normalises every
   * amount to the string the column holds (§6.1).
   */
  /**
   * A money-list search first resolves the CLIENTS it names, then reads their
   * movements. That is fast for one client or a few hundred; a common first
   * name matches a hundred thousand, and filtering millions of movements by a
   * hundred thousand owners took seconds — one call 28 s (measured, 11 Oct
   * 2026). So a search naming more than MAX_SEARCHED_CLIENTS is refused with
   * the reason, rather than answered slowly or, worse, partly.
   */
  private async assertSearchNarrow(q: string | undefined): Promise<void> {
    const term = q?.trim();
    if (!term) return;
    const { rows } = await this.db.execute(sql`
      SELECT count(*)::int AS value FROM (
        SELECT 1 FROM users WHERE ${clientIdentitySearch(term)} LIMIT ${MAX_SEARCHED_CLIENTS + 1}
      ) matched`);
    if ((rows[0] as { value: number }).value > MAX_SEARCHED_CLIENTS) {
      throw new ValidationError(
        'This search matches more than 1,000 clients. Add a surname, or search by Portal ID, email or phone.',
      );
    }
  }

  /**
   * The trading account a money list is narrowed to, from what an operator holds: its id, or its
   * MT5 login (16 Oct 2026). An unknown login answers the NIL id — an ordinary empty list, exactly
   * like an account outside the reader's territory — so the filter never says whether an account
   * exists. Only a malformed value is refused, and only for its format.
   */
  async accountFilterId(raw: string | undefined): Promise<string | undefined> {
    const value = raw?.trim();
    if (!value) return undefined;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return value.toLowerCase();
    }
    if (!/^[A-Za-z0-9_-]{1,50}$/.test(value)) {
      throw new ValidationError('account must be a trading account id or an MT5 login.');
    }
    const { rows } = await this.db.execute(
      sql`SELECT id FROM trading_accounts WHERE login = ${value} LIMIT 1`,
    );
    return (rows[0] as { id: string } | undefined)?.id ?? NIL_ACCOUNT;
  }

  /**
   * The ledger postings ONE movement made (16 Oct 2026) — what a single-record read shows a
   * `ledger.view` holder, so a movement and its accounting entries are read side by side. Each
   * (wallet, reference type, reference id) is a probe of `ledger_entries_wallet_reference_uq`:
   * a payment posts under `transaction` (and `<id>:refund`), a transfer under `transfer`, a
   * commission move under `ib_transfer` on both of its wallets.
   */
  async ledgerPostingsFor(movement: {
    id: string;
    kind: MovementKind;
    walletId: string;
    fromWalletId?: string | null;
  }): Promise<
    {
      walletId: string;
      walletNumber: string | null;
      entryType: string;
      amount: string;
      balanceAfter: string;
      createdAt: Date;
    }[]
  > {
    const keys: SQL[] =
      movement.kind === 'payment'
        ? [
            sql`(${movement.walletId}::uuid, 'transaction', ${movement.id})`,
            sql`(${movement.walletId}::uuid, 'transaction', ${`${movement.id}:refund`})`,
          ]
        : movement.kind === 'transfer'
          ? [sql`(${movement.walletId}::uuid, 'transfer', ${movement.id})`]
          : [
              sql`(${movement.walletId}::uuid, 'ib_transfer', ${movement.id})`,
              ...(movement.fromWalletId
                ? [sql`(${movement.fromWalletId}::uuid, 'ib_transfer', ${movement.id})`]
                : []),
            ];
    const { rows } = await this.db.execute(sql`
      SELECT le.wallet_id, w.wallet_number, le.entry_type, le.amount, le.balance_after, le.created_at
        FROM ledger_entries le
        JOIN wallets w ON w.id = le.wallet_id
       WHERE (le.wallet_id, le.reference_type, le.reference_id) IN (${sql.join(keys, sql`, `)})
       ORDER BY le.created_at, le.id`);
    return (
      rows as unknown as {
        wallet_id: string;
        wallet_number: string | null;
        entry_type: string;
        amount: string;
        balance_after: string;
        created_at: string;
      }[]
    ).map((row) => ({
      walletId: row.wallet_id,
      walletNumber: row.wallet_number,
      entryType: row.entry_type,
      amount: money(row.amount),
      balanceAfter: money(row.balance_after),
      createdAt: instantOf(row.created_at),
    }));
  }

  async listAllForAdmin(
    filter: AdminMovementsFilter & {
      page?: number;
      limit?: number;
      /** Keyset position — R-2.4. When present, `page` is ignored. */
      cursor?: CursorPosition;
      /** R-2.5 server-side sort. Validated by `sortKey` before it gets here. */
      sort?: AdminTransactionSortKey;
      order?: SortOrder;
      /** Previous / Last walk the same indexes backward — `pageDirection`. */
      paging?: PageDirection;
      /**
       * Which second facet to count: `direction` (the wallet-side tabs older consoles read) or
       * `type` (the accounting tabs, 16 Oct 2026). Only the one asked for is paid for.
       */
      facet?: 'direction' | 'type';
    },
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const facet = filter.facet ?? 'direction';
    const limit = pageSize(filter.limit);
    const sortKey: AdminTransactionSortKey = filter.sort ?? DEFAULT_ADMIN_TRANSACTION_SORT;
    const direction = walkOrder(filter.order ?? 'desc', filter.paging);
    const sortSpec = ADMIN_TRANSACTION_SORT_COLUMNS[sortKey];

    await this.assertSearchNarrow(filter.q);
    const { countOnes, page: pageOf, conditionsFor, whereOf } = this.adminMovements(filter);

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
    /*
     * A facet the stored totals cannot answer (a search, the desk's own rows, a
     * method…) is counted ONE VALUE AT A TIME, each through the same index the
     * page reads and stopped at TOTAL_CAP + 1 rows (11 Oct 2026). The GROUP BY it
     * replaces read every matching movement on every page view: the deposit
     * desk took 0.6–0.9 s at three million rows, and grew with each deposit.
     */
    const cappedFacet = (
      axis: 'state' | 'direction' | 'type',
      values: readonly string[],
      omit: { state?: boolean; direction?: boolean; type?: boolean },
    ): SQL =>
      sql.join(
        values.map(
          (value) => sql`
            SELECT ${value}::text AS ${sql.raw(axis)}, (
              SELECT count(*)::int FROM (
                ${countOnes}${whereOf([
                  ...conditionsFor(omit),
                  // The VALUE is cast, never the column: `state::text` cannot use the
                  // state index, and a bare text parameter is refused by the enum.
                  axis === 'state'
                    ? sql`combined.state = ${value}::transaction_state`
                    : axis === 'type'
                      ? unionTypesPredicate([value as MovementType])
                      : sql`combined.direction = ${value}::transaction_direction`,
                ])} LIMIT ${TOTAL_CAP + 1}
              ) capped
            ) AS value`,
        ),
        sql` UNION ALL `,
      );
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
        ? this.db.execute(movementTotalsQuery(filter, 'state', this.deskRoutesOf(filter)))
        : this.db.execute(cappedFacet('state', transactionStateEnum.enumValues, { state: true })),
      facet === 'type'
        ? totals
          ? this.db.execute(movementTotalsQuery(filter, 'type', this.deskRoutesOf(filter)))
          : this.db.execute(cappedFacet('type', MOVEMENT_TYPES, { type: true }))
        : totals
          ? this.db.execute(movementTotalsQuery(filter, 'direction', this.deskRoutesOf(filter)))
          : this.db.execute(
              cappedFacet('direction', transactionDirectionEnum.enumValues, { direction: true }),
            ),
    ]);

    /** The tabs whose count stopped at the cap: the console shows them as "10,000+". */
    const countsCapped: string[] = [];
    const counts: Record<string, number> = { all: 0 };
    for (const row of stateRows.rows as unknown as { state: string; value: number }[]) {
      if (row.value === 0) continue;
      // Stored totals are exact; a capped facet stops at TOTAL_CAP + 1.
      counts[row.state] = totals ? row.value : Math.min(row.value, TOTAL_CAP);
      counts['all'] += counts[row.state];
      if (!totals && row.value > TOTAL_CAP) countsCapped.push(row.state);
    }
    const directionCounts: Record<string, number> = { all: 0 };
    const typeCounts: Record<string, number> = { all: 0 };
    const groupCounts: Record<string, number> = { all: 0 };
    if (facet === 'type') {
      for (const row of directionRows.rows as unknown as { type: string; value: number }[]) {
        if (row.value === 0) continue;
        typeCounts[row.type] = totals ? row.value : Math.min(row.value, TOTAL_CAP);
        typeCounts['all'] += typeCounts[row.type];
        if (!totals && row.value > TOTAL_CAP) countsCapped.push(row.type);
      }
      // The tabs' groups, added up here so no screen adds counts; a capped part caps its group.
      for (const [group, members] of Object.entries(MOVEMENT_GROUPS)) {
        groupCounts[group] = members.reduce((sum, type) => sum + (typeCounts[type] ?? 0), 0);
        if (members.some((type) => countsCapped.includes(type))) countsCapped.push(group);
      }
      groupCounts['all'] = typeCounts['all'];
    } else {
      for (const row of directionRows.rows as unknown as { direction: string; value: number }[]) {
        if (row.value === 0) continue;
        directionCounts[row.direction] = totals ? row.value : Math.min(row.value, TOTAL_CAP);
        directionCounts['all'] += directionCounts[row.direction];
        if (!totals && row.value > TOTAL_CAP) countsCapped.push(row.direction);
      }
    }
    // A sum holding a capped part is itself "at least", on both rows of tabs:
    // they describe the same set of movements.
    if (countsCapped.length > 0) {
      countsCapped.push('all');
      counts['all'] = Math.min(counts['all'], TOTAL_CAP);
      directionCounts['all'] = Math.min(directionCounts['all'], TOTAL_CAP);
      typeCounts['all'] = Math.min(typeCounts['all'], TOTAL_CAP);
      groupCounts['all'] = Math.min(groupCounts['all'], TOTAL_CAP);
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
      filter.paging ? { ...filter.paging, fromCursor: Boolean(filter.cursor) } : undefined,
    );

    const items = paged.items.map((row) => ({
      ...toMovementRow(row),
      // From where to where, who and why, what the provider charged (16 Oct 2026).
      ...movementDetails(row),
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

    return {
      items,
      nextCursor: paged.nextCursor,
      prevCursor: paged.prevCursor,
      total,
      page,
      limit,
      counts,
      directionCounts,
      typeCounts,
      groupCounts,
      countsCapped,
    };
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
    await this.assertSearchNarrow(filter.q);
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
      details: movementDetails(row),
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
    accounting: AccountingLine[];
    effects: EffectTotal[];
    net: { currency: string; total: string }[];
  }> {
    await this.assertSearchNarrow(filter.q);
    const { countSource, conditionsFor, whereOf } = this.adminMovements(filter);
    const totalsSource = movementTotalsSource(filter);

    /*
     * ONE scan for both granularities — GROUPING SETS aggregates the fine
     * breakdown and the per-direction headline in a single pass over the
     * union, where two queries would scan every money table twice for numbers
     * derived from the same rows. The coarse set leaves `kind`/`state` NULL,
     * which is unambiguous because both are NOT NULL on every real row.
     */
    // The stored totals (0165) answer every filter they can — see `movementTotalsSource`.
    const grouped = movementTotalsSource(filter)
      ? await this.db.execute(movementTotalsQuery(filter, 'summary', this.deskRoutesOf(filter)))
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
    /*
     * THE ACCOUNTING LINES (16 Oct 2026): per currency × type × settlement bucket, from the stored
     * totals when they answer (their route separates the desk's own money), the rows otherwise.
     * Settled is money that moved; in progress is still moving; not completed never moved. The
     * buckets are never added together, and nothing crosses a currency.
     */
    const accountingRows = (totalsSource
      ? await this.db.execute(movementTotalsQuery(filter, 'accounting', this.deskRoutesOf(filter)))
      : await this.db.execute(sql`
            WITH counted AS (${countSource}${whereOf(conditionsFor())})
            SELECT currency, ${unionTypeCase()} AS type, ${bucketCase(sql`state`)} AS bucket,
                   count(*)::int AS value, coalesce(sum(amount), 0)::text AS total
              FROM counted
             GROUP BY 1, 2, 3
             ORDER BY 1, 2, 3`)
    ).rows as unknown as {
      currency: string;
      type: MovementType;
      bucket: SettlementBucket;
      value: number;
      total: string;
    }[];
    const accounting: AccountingLine[] = accountingRows.map((row) => ({
      currency: row.currency,
      type: row.type,
      effect: effectOf(row.type),
      bucket: row.bucket,
      count: row.value,
      // Never Number(row.total) — the string IS the value (§6.1).
      total: money(row.total),
    }));
    // Net = settled money in − settled money out, per currency: decimal arithmetic, never a float.
    const netByCurrency = new Map<string, Decimal>();
    for (const line of accounting) {
      if (line.bucket !== 'settled' || line.effect === 'internal') continue;
      const running = netByCurrency.get(line.currency) ?? new Decimal(0);
      netByCurrency.set(
        line.currency,
        line.effect === 'in' ? running.plus(line.total) : running.minus(line.total),
      );
    }
    const net = [...netByCurrency.entries()].map(([currency, total]) => ({
      currency,
      total: money(total.toFixed(8)),
    }));
    // Per currency × effect × bucket — what a tile shows, added up HERE so no screen adds money.
    const byEffect = new Map<string, EffectTotal & { sum: Decimal }>();
    for (const line of accounting) {
      const key = `${line.currency}|${line.effect}|${line.bucket}`;
      const entry = byEffect.get(key) ?? {
        currency: line.currency,
        effect: line.effect,
        bucket: line.bucket,
        count: 0,
        total: '0',
        sum: new Decimal(0),
      };
      entry.count += line.count;
      entry.sum = entry.sum.plus(line.total);
      byEffect.set(key, entry);
    }
    const effects: EffectTotal[] = [...byEffect.values()].map(({ sum, ...entry }) => ({
      ...entry,
      total: money(sum.toFixed(8)),
    }));

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
      accounting,
      effects,
      net,
    };
  }
}
