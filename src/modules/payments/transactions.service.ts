import { Inject, Injectable, Logger } from '@nestjs/common';
import { readProofDetails, type ProofDetail } from '../../common/payments/proof-fields';
import Decimal from 'decimal.js';
import { randomBytes } from 'crypto';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNull,
  ne,
  sql,
  type SQL,
  type SQLWrapper,
  lte,
} from 'drizzle-orm';
import {
  tradingAccounts,
  transactionDirectionEnum,
  transactions,
  transactionStateEnum,
  users,
  withdrawalPaymentMethods,
} from '../../database/schema';
import type { ListTransactionsQueryDto } from './dto/transaction-query.dto';
import { clientIdentitySearch } from '../../store/users.store';
import { TransfersService } from './transfers.service';
import { TransferExecutor } from './transfer-executor.service';
import type { TransactionView } from './transaction-view';

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
  /** The client's answers to an offline method's details (0162). */
  proof_details: ProofDetail[] | null;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  settled_at: string | null;
  rival_external_id: string | null;
  rival_withdrawal_id: string | null;
  rival_submitted_at: string | null;
  rival_needs_attention: boolean;
  rival_attention_reason: string | null;
  created_at: string;
  method_name: string | null;
  /** The desk's label, falling back to the name (0161). ADMIN mappings only. */
  method_label: string | null;
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
  /** Inclusive date bounds, compared by DATE PART — see the union's filters. */
  from?: string;
  to?: string;
  /**
   * Only payments a PERSON must reconcile (`rival_needs_attention`) — where an
   * attention task's link lands, and the desk's "what is flagged" view. The
   * transfer arms carry no flag, so they never match.
   */
  attention?: boolean;
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
  /** The payment platform's own id — see TransactionDto.rivalExternalId. */
  rivalExternalId: string | null;
  destination: string | null;
  /** What the client gave to identify an offline payment (0162). */
  proofDetails: ProofDetail[] | null;
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
 * The scalar mappings the admin Financial list and its CSV export SHARE — one
 * definition, so the screen and the file cannot describe the same row
 * differently (a `methodName` fallback fixed in one copy and not the other is
 * the discrepancy a reconciling auditor escalates). The list nests the client
 * under `user` on top of this; the export flattens the client beside it.
 */
/**
 * The deposit desk's half of the admin search (0162): the details a client
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
      SELECT t.id FROM transactions t
      WHERE t.proof_details IS NOT NULL
        AND deposit_details_search(t.proof_details) LIKE ${`%${folded}%`}`);
  }
  if (/^ox-[0-9a-z]{6}$/i.test(q)) {
    matches.push(sql`SELECT t.id FROM transactions t WHERE t.provider_ref = ${q.toUpperCase()}`);
  }
  if (matches.length === 0) return undefined;
  return sql`combined.id IN (${sql.join(matches, sql` UNION `)})`;
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
    rivalExternalId: row.rival_external_id,
    destination: row.destination,
    rejectionReason: row.rejection_reason,
    // The receipt on an offline deposit, so the desk can show the image beside
    // the row it is deciding on. Null on every other movement.
    proofFilename: row.proof_filename,
    proofDetails: row.proof_details,
    createdAt: instantOf(row.created_at),
    settledAt: instantOrNull(row.settled_at),
    reviewedAt: instantOrNull(row.reviewed_at),
  };
}

/**
 * `transactions.provider` for money an ADMIN placed by hand.
 *
 * A named constant because three places have to agree on the exact string: the
 * admin service that writes it, and both frontends, which show "Manual credit"
 * instead of a payment-method name when they see it. A literal repeated in
 * three repos is a typo away from a transaction that renders as an unknown
 * source on the client's own statement.
 *
 * It carries the `manual_` prefix every non-gateway row uses, so a
 * reconciliation that groups on the prefix keeps working, and `_admin` where a
 * method key would be — there is no method.
 */
export const MANUAL_ADMIN_PROVIDER = 'manual_admin';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';
import { assertActorCan, type Actor } from '../../common/security/actor';
import { money, toDecimal } from '../wallet/money';
import { buildCursorPage, pageSize, type CursorPosition } from '../../common/pagination';
import type { SortOrder } from '../../common/sorting';
import { sortKey, sortOrder } from '../../common/sorting';
import { formatLimit } from '../../common/currency-limits';
import { PaymentMethodsService } from './payment-methods.service';
import { wishDestinationIssue } from './rival/wish-phone';
import { isPayerReachableUrl } from './rival/payer-reachable-url';
import { Currency, Executor, WalletService } from '../wallet/wallet.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import {} from '../../common/provisioning/commission-accrual.port';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';
import { PaymentGateways } from './payment-gateways.service';
import type { DepositAttentionReason } from '../../common/notifications/admin-notification-catalogue';
import { AuditLogStore } from '../../store/audit-log.store';
import { SYSTEM_ACTOR } from '../../common/security/actor';
import {
  AuthorizationError,
  MoneyRuleError,
  NotFoundError,
  PaymentIndeterminateError,
  ValidationError,
} from '../../common/errors/domain-errors';
import {
  clientScopePredicate,
  UNRESTRICTED,
  type ClientScope,
} from '../../common/security/client-scope';

/**
 * Withdrawal lifecycle (§8.4 + FR-ADM-03).
 *
 *   request  → post the DEBIT, state=pending
 *   approve  → state=approved                    (no balance change)
 *   settle   → state=success                     (no balance change)
 *   reject   → post a compensating CREDIT, state=rejected, reason emailed
 *   fail     → post a compensating CREDIT, state=failure, client emailed
 *
 * ## Debit on request, not a hold — changed deliberately
 *
 * The earlier version reserved the funds in `wallets.on_hold` and posted the
 * debit only at settlement, so a pending withdrawal left the balance looking
 * untouched. That let a client request two withdrawals each within their
 * balance but not within it together, be told both were submitted, and have the
 * second refused later by an admin reading a number the client had never seen.
 *
 * Debiting at request means the balance always shows committed funds. The cost
 * is that a refusal has to give the money back, and it does so with a
 * COMPENSATING ENTRY (§6.4) — the original debit is never edited or deleted.
 * See `refund()` for why its reference carries a `:refund` suffix.
 *
 * `on_hold` still exists and is still used, by TRANSFERS: the wallet→account
 * leg holds while the bridge confirms, because there the counterparty really
 * can refuse after the fact.
 *
 * NOT built here (blocked, not forgotten):
 *  - Real provider calls (Whish / USDT). Credentials are open decision §12.5,
 *    so settlement is admin-triggered and records the provider reference by
 *    hand. The callback path will reuse settle() unchanged — its idempotency
 *    already lives in UNIQUE(provider, provider_ref).
 */
/**
 * Work the CALLER needs performed inside a money method's transaction.
 *
 * R-6.5: the admin audit row for a money movement must commit with the movement
 * or not at all — otherwise the withdrawal settles, the record of who authorised
 * it is lost, and D-21's whole justification (this is the one record that cannot
 * be reconstructed afterwards) stops holding for the actions that need it most.
 *
 * The handle is handed OUT rather than the audit service being imported in:
 * `AdminAuditService` lives in the `admin` module and this one must not reach
 * into it (ARCHITECTURE §4 — modules communicate through their own surfaces, not
 * by importing each other's internals). This file keeps owning the transaction
 * boundary, which is where §6.2 says it belongs.
 */
export type WithinTransaction = (
  tx: Executor,
  row: typeof transactions.$inferSelect,
) => Promise<void>;

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
 */
export const ADMIN_TRANSACTION_SORT_COLUMNS = {
  createdAt: { column: sql`combined.created_at`, cast: 'timestamptz' },
  amount: { column: sql`combined.amount`, cast: 'numeric' },
  state: { column: sql`combined.state`, cast: 'text' },
} as const satisfies Record<string, { column: SQL; cast: 'timestamptz' | 'numeric' | 'text' }>;

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
  const cast =
    spec.cast === 'timestamptz'
      ? sql`${cursor.value}::timestamptz`
      : spec.cast === 'numeric'
        ? sql`${cursor.value}::numeric`
        : sql`${cursor.value}::text`;
  return sql`(${spec.column}, combined.id) ${comparator} (${cast}, ${cursor.id}::uuid)`;
}

/**
 * Which withdrawal lifecycle an approval follows — see `approve()`.
 *
 * Not a boolean parameter, and not defaulted. Both lifecycles are correct for
 * their own rail and dangerous for the other, so the caller has to have thought
 * about it: a default would silently pick one the day a new payout rail is added.
 */
export interface ApproveWithdrawalOptions {
  /**
   * True when a payout rail will send the money and its event will settle the row.
   * False when a human is sending it, so approval records a completed payout.
   */
  awaitsProviderPayout: boolean;
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  /**
   * The db is injected, not fetched from the module-level singleton.
   *
   * `this.db` and the DRIZZLE_DB provider return the *same* lazy instance
   * (see database.module.ts), so this is behaviour-identical — but a declared
   * dependency can be seen, and reaching for a global from inside a money method
   * could not. `executor ?? this.db` still lets a caller pass a transaction
   * handle so a method joins their transaction (§6.2).
   */
  constructor(
    private readonly wallets: WalletService,
    @Inject(DRIZZLE_DB) private readonly db: Db,
    /*
     * Which deposit methods exist, and whether the chosen one can take money.
     * Appended for the reason the parameter below records — the suite
     * constructs this class positionally.
     */
    private readonly paymentMethods: PaymentMethodsService,
    /*
     * Decides whether a currency code is one this platform accepts right now.
     *
     * Appended, and the reason is the same one `AuthService` records: this
     * class is constructed positionally in the test suite, so inserting a
     * parameter in the middle silently shifts the ones after it.
     */
    private readonly currencies: CurrenciesService,
    /*
     * The commission port is NO LONGER INJECTED, and the parameter is gone
     * rather than left unused.
     *
     * Payments used to accrue on a settled deposit, which paid a partner a
     * share of the client's own money. Partners are paid on closed positions
     * now, and nothing in this file earns anybody anything.
     *
     * The port and its binding survive in `ib.module.ts` for CPA — a fixed
     * amount per qualified client, which legitimately triggers on a deposit —
     * so re-consuming it later is one parameter, not new plumbing.
     */
    /*
     * The hosted payment providers, and the config the callback URLs are built
     * from. APPENDED LAST for the reason every parameter above records: this
     * class is constructed positionally in the test suite, so inserting one in
     * the middle silently shifts the rest.
     */
    private readonly gateways: PaymentGateways,
    private readonly config: ConfigService,
    /*
     * The deposit-outcome mail (FR-CORE-07). Appended for the positional-
     * construction reason every parameter above records.
     */
    private readonly email: EmailService,
    /*
     * Bell rows — deposit outcomes to the client, new withdrawals to the
     * admins who can act on them. Behind the same port recipe as commissions
     * above, and APPENDED LAST for the same positional-construction reason.
     */
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
    /*
     * The onward leg of a deposit that names a trading account.
     *
     * `requestDeposit` has always accepted and validated
     * `destinationTradingAccountId`, and the comment beside that column has
     * always said settlement "chains a transfer to move it on" — but nothing
     * did. The field was captured, validated, stored, and then never read
     * again, so a client who chose an account watched their money stop in the
     * wallet.
     *
     * APPENDED LAST, for the positional-construction reason every parameter
     * above records.
     */
    private readonly transfers: TransfersService,
    private readonly transferExecutor: TransferExecutor,
    /*
     * The forensic record for a deposit NOBODY approved.
     *
     * Appended, never inserted, for the reason the parameters above record:
     * this class is constructed positionally in the suite, so a parameter added
     * in the middle silently shifts every one after it.
     */
    private readonly auditLog: AuditLogStore,
  ) {}

  /**
   * The payout rails on offer — what the portal's method picker renders.
   *
   * ENABLED only, ordered by `sort_order` then name, which is exactly the index
   * migration 0062 creates. Disabled rails are omitted rather than shown
   * greyed: a client cannot act on the difference, and a method they can see
   * but not choose reads as a fault in the page.
   *
   * The list is presentation. `requestWithdrawal` re-checks the key against the
   * same table and refuses anything absent or disabled, so hiding a rail here
   * is never what stops it being used (R-4.3).
   */
  async listWithdrawalMethods() {
    const rows = await this.db
      .select({
        key: withdrawalPaymentMethods.key,
        name: withdrawalPaymentMethods.name,
        logoUrl: withdrawalPaymentMethods.logoUrl,
      })
      .from(withdrawalPaymentMethods)
      .where(eq(withdrawalPaymentMethods.enabled, true))
      .orderBy(asc(withdrawalPaymentMethods.sortOrder), asc(withdrawalPaymentMethods.name));
    return rows;
  }

  async requestWithdrawal(params: {
    userId: number;
    amount: string;
    currency: Currency;
    destination: string;
    /**
     * A `withdrawal_payment_methods.key` — the rail the client chose.
     *
     * This replaced a `provider` string the client sent from a closed union
     * (`'whish' | 'usdt'`). The rails are DATA now (migration 0062), so the set
     * a client may choose from is a table the desk controls rather than a union
     * a deploy controls, and the check below is against what is actually
     * enabled rather than against what the code was compiled knowing about.
     */
    methodKey: string;
  }) {
    /*
     * The CURRENCY, checked against the catalogue rather than against a list in
     * a DTO.
     *
     * `@IsIn(['USD','USDT'])` used to do this at the edge, which refused a
     * withdrawal in any currency an operator had added since — EUR, GBP, AED and
     * TRY were all enabled and all unspendable. Currencies stopped being a
     * `pgEnum` for exactly that reason; the DTO was the last copy of the old
     * closed set.
     *
     * `assertUsable` is the stronger check the edge could not make: it refuses
     * an unknown code AND a DISABLED one, against what is actually on offer.
     * The `wallets_currency_currencies_code_fk` foreign key catches an unknown
     * code again below if a caller ever skips this — but a foreign key cannot
     * tell "disabled" from "available", which is why this runs first.
     */
    // The NORMALISED code is what the rest of this method uses: `assertUsable`
    // upper-cases and trims, so 'usd' and 'USD' cannot become two currencies on
    // the rows this writes.
    const {
      code: currency,
      decimals,
      limits,
    } = await this.currencies.assertUsableDetail(params.currency);

    const amount = toDecimal(params.amount);
    /*
     * `lessThanOrEqualTo(0)`, NOT `!isPositive()`.
     *
     * decimal.js reads the SIGN, and it gives ZERO a sign of 1 — so
     * `!amount.isPositive()` is FALSE for "0" and "0.00000000", and this guard
     * never fired for the one input it most obviously exists to reject. The
     * request then ran on to the ledger, which refused it with
     * "A ledger entry must move a non-zero amount" — a sentence naming a table
     * the client has never heard of, instead of the amount they typed.
     */
    if (amount.lessThanOrEqualTo(0))
      throw new ValidationError('Withdrawal amount must be positive.');

    /*
     * Absolute bounds — PLATFORM-CONVENTIONS R-5.1 — in THIS CURRENCY's units.
     *
     * Balance and KYC level were already checked below, and they are the RIGHT
     * checks. What was missing is a ceiling that holds when something upstream
     * is wrong: a mispriced wallet, a bad rate, a compromised session draining
     * an account in one move.
     *
     * The currency's own limits since 0162. They were one config number for
     * every currency, so a client could not withdraw more than 50,000 LBP —
     * about fifty cents — while the same number was a large USD withdrawal.
     */
    const min = toDecimal(limits.minWithdrawal);
    const max = toDecimal(limits.maxWithdrawal);
    if (amount.lessThan(min)) {
      throw new ValidationError(`The minimum withdrawal is ${formatLimit(min)} ${currency}.`);
    }
    if (amount.greaterThan(max)) {
      throw new ValidationError(
        `The maximum single withdrawal is ${formatLimit(max)} ${currency}. ` +
          'Please split the request or contact support.',
      );
    }

    /*
     * The rail must exist and be ENABLED, read live rather than trusted.
     *
     * The client sends a key; this is the only thing standing between that key
     * and a payout instruction, so a disabled rail is refused here rather than
     * merely hidden from the picker. Hiding it in the portal is presentation;
     * this is the rule (R-4.3 — every precondition checked in the service, so a
     * future admin tool or job satisfies the same one).
     */
    const [method] = await this.db
      .select()
      .from(withdrawalPaymentMethods)
      .where(eq(withdrawalPaymentMethods.key, params.methodKey))
      .limit(1);
    if (!method || !method.enabled) {
      throw new ValidationError('That withdrawal method is not available.');
    }

    /*
     * The amount must be one this withdrawal can actually PAY — D-77.
     *
     * Two scales bound a payout and only one of them used to be checked:
     *
     *   currencies.decimals   what the OPERATOR says the currency holds.
     *                         Editable from 0 to 8 on the admin screen.
     *   gateways.payoutScale  what the PROVIDER can send exactly.
     *                         Rival settles at 2 (RIVAL_MONEY_SCALE).
     *
     * Checking only the first closed this for USD — which declares 2 — and left
     * it wide open the moment anybody configured a currency to more places than
     * Rival supports: the CRM would accept 100.12345678, debit all of it, and
     * Rival would be asked for 100.12, keeping the difference exactly as before.
     * The fix would have LOOKED applied while doing nothing, which is worse than
     * not having it.
     *
     * So the bound is the SMALLER of the two. A desk-paid withdrawal has no rail
     * and is bounded by the currency alone — a human settling it can send
     * whatever the currency expresses.
     *
     * `quantiseOut` refuses rather than rounds, so a value that somehow reaches
     * Rival with too many places is a loud, recoverable failure instead of
     * silent dust. This check is what stops the client meeting that refusal at
     * approval time, hours after they asked.
     */
    const railScale = this.gateways.settlementScale(method.key);
    const payableDecimals = railScale === null ? decimals : Math.min(decimals, railScale);
    if (amount.decimalPlaces() > payableDecimals) {
      /*
       * The message names the largest amount that WOULD be accepted, rounded
       * DOWN so it is never more than the client has.
       *
       * A client's balance can legitimately carry sub-cent value — commission
       * and rebates are percentages stored at the full NUMERIC(28,8) scale — so
       * "withdraw everything" can produce an amount this rule refuses. Without
       * the figure the refusal is a dead end on the one action the client most
       * wants; with it, it is an instruction they can act on immediately.
       */
      throw new ValidationError(
        `${method.name} settles ${currency} to ${payableDecimals} decimal ` +
          `${payableDecimals === 1 ? 'place' : 'places'}. The most you can withdraw from this ` +
          `request is ` +
          `${amount.toDecimalPlaces(payableDecimals, Decimal.ROUND_DOWN).toFixed(payableDecimals)} ` +
          `${currency}.`,
      );
    }

    /*
     * A whish withdrawal's destination is a phone number Rival will pay over
     * Whish-to-Whish, validated NOW with Rival's own rules (wish-phone.ts):
     * refusing at request time bounces the typo on the client in the moment
     * they can fix it, instead of days later as a failed submission on an
     * approval the admin cannot explain.
     */
    if (method.key === 'whish') {
      const issue = wishDestinationIssue(params.destination);
      if (issue) throw new ValidationError(issue);
    }

    const db = this.db;
    const [user] = await db.select().from(users).where(eq(users.id, params.userId)).limit(1);
    if (!user) throw new NotFoundError('User not found.');
    // §8.4: funded features are gated on KYC level 1 (FR-CORE-15).
    if (user.verificationLevel < 1) {
      throw new AuthorizationError('Withdrawals require a verified account (KYC level 1).');
    }

    /*
     * A rolling 24-hour cap, on top of the per-request one.
     *
     * A per-request limit alone is trivially defeated by making N requests, so
     * it caps the paperwork rather than the exposure. Counted over everything
     * not rejected — a pending withdrawal is money already on its way out.
     */
    const dayCap = toDecimal(limits.maxWithdrawalDaily);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await db
      .select({ amount: transactions.amount })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, params.userId),
          eq(transactions.direction, 'withdrawal'),
          eq(transactions.currency, currency),
          gte(transactions.createdAt, since),
          ne(transactions.state, 'rejected'),
        ),
      );
    const already = recent.reduce((sum, row) => sum.plus(toDecimal(row.amount)), toDecimal('0'));
    if (already.plus(amount).greaterThan(dayCap)) {
      throw new ValidationError(
        `This would exceed the ${formatLimit(dayCap)} ${currency} rolling 24-hour ` +
          `withdrawal limit — ${formatLimit(already)} has already been requested in that window.`,
      );
    }

    /*
     * DEBIT ON REQUEST, not a hold. Changed from the version this restores.
     *
     * The old flow reserved the funds (`on_hold`) and posted the debit only at
     * settlement. That kept the balance looking untouched while a withdrawal
     * was pending, which is the problem: a client could request two withdrawals
     * each within their balance but not within it together, be told both were
     * submitted, and have the second refused at approval time by an admin
     * looking at a number the client never saw.
     *
     * Debiting now means the balance always reflects committed funds. The
     * refusal path writes a COMPENSATING CREDIT (§6.4) rather than editing
     * anything — see `reject` and `markFailed` below.
     *
     * The row is inserted BEFORE the ledger post because the post needs the
     * transaction id as its reference, and that id is what makes the debit
     * idempotent. Both are in one transaction, so a failure at either step
     * leaves neither — the previous ordering bug this comment replaces was the
     * mirror of that: a hold committed before a failed INSERT left funds
     * reserved against a withdrawal that did not exist, invisible and
     * unreleasable.
     */
    return db
      .transaction(async (dbTx) => {
        const wallet = await this.wallets.getOrCreateWallet(params.userId, currency, 'main', dbTx);
        const [row] = await dbTx
          .insert(transactions)
          .values({
            userId: params.userId,
            walletId: wallet.id,
            direction: 'withdrawal',
            amount: money(amount),
            currency: currency,
            state: 'pending',
            /*
             * `provider` carries the method key, and the new
             * `withdrawalMethodKey` carries it again as a real foreign key.
             *
             * That is not redundancy worth removing. `provider` is half of
             * `UNIQUE(provider, provider_ref)` — the §6.3 idempotency guarantee
             * for replayed payment callbacks — so it has to stay populated and
             * has to keep meaning "which rail" to the reconciler. The foreign
             * key is what makes the rail a referenced row rather than a string,
             * which is what lets the admin list join its display name and what
             * stops a method with history being deleted.
             */
            provider: method.key,
            withdrawalMethodKey: method.key,
            destination: params.destination,
          })
          .returning();

        /*
         * `post` locks the wallet and refuses an overdraft, so this is also the
         * balance check — and it is the only one that cannot be raced. A check
         * before the insert would be a read-then-write, and two withdrawals
         * submitted together would both pass it.
         */
        await this.wallets.post(
          {
            userId: params.userId,
            currency: currency,
            amount: amount.negated(),
            entryType: 'withdrawal',
            referenceType: LEDGER_REFERENCE.transaction,
            referenceId: row.id,
          },
          dbTx,
        );

        return row;
      })
      .then((row) => {
        /*
         * Ring the reviewers' bells AFTER the request has committed, never
         * inside it: resolving who can act on it (the catalogue's permissions,
         * each admin's scope) is several reads, and a money transaction does not
         * stay open for a courtesy (§6.2 keeps that transaction to lock →
         * compute → insert → update). The port never throws, and the polled
         * queue badge remains the durable signal — this row is the per-item task
         * with a deep link on top. Approving or rejecting it resolves it for
         * every reviewer at once (the `transactions` trigger, migration 0140).
         */
        void this.notifications.notifyAdmins({
          kind: 'admin.withdrawal.requested',
          params: { transactionId: row.id, amount: row.amount, currency: row.currency },
          dedupeKey: `admin.withdrawal.requested:${row.id}`,
          subject: { id: row.id, clientId: row.userId },
        });
        return row;
      });
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
    if (filter.state) {
      conditions.push(eq(transactions.state, filter.state as 'pending'));
    }
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

    const rows = await db
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
        rivalWithdrawalId: transactions.rivalWithdrawalId,
        rivalSubmittedAt: transactions.rivalSubmittedAt,
        rivalNeedsAttention: transactions.rivalNeedsAttention,
        rivalAttentionReason: transactions.rivalAttentionReason,
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
     * JOINED TO `users`, because `where` may reference their columns.
     *
     * The predicate is shared with the rows query above — that is the point of
     * building it once — and the search matches on the client's name and email.
     * Without the join this counts against a table that has no `users` in
     * scope and Postgres rejects the whole statement.
     */
    const [{ value: total }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(transactions)
      .innerJoin(users, eq(transactions.userId, users.id))
      .where(where);

    /*
     * Per-state counts over the full set — deliberately ignoring the STATE
     * filter (the desk tabs must show every state's size regardless of the
     * active tab) but NEVER the SCOPE. This aggregated without the scope
     * predicate once, and the row a scoped admin could not see still moved
     * their nav badge and tab counts: aggregate intelligence about clients
     * outside their territory, found live by the 13 Aug scoped walk.
     */
    const countConditions = [eq(transactions.direction, 'withdrawal')];
    if (scoped) countConditions.push(scoped);
    /*
     * The SEARCH narrows these; the STATE filter does not.
     *
     * Two filters on different axes. The tabs exist to show how big each state
     * is, so applying the active state to them would make every tab but one
     * read zero. The search is the reader's current subject — if they are
     * looking at one client, a Pending badge counting all 8,571 rows describes
     * a queue they are not looking at, and they would act on it.
     */
    if (q) {
      countConditions.push(
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
    const countRows = await db
      .select({ state: transactions.state, value: sql<number>`count(*)::int` })
      .from(transactions)
      .innerJoin(users, eq(transactions.userId, users.id))
      .where(and(...countConditions))
      .groupBy(transactions.state);
    const counts: Record<string, number> = { all: 0 };
    for (const row of countRows) {
      counts[row.state] = row.value;
      counts['all'] += row.value;
    }

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

    const items = paged.items.map((r) => ({
      id: r.id,
      amount: money(r.amount), // money crosses the boundary as a string
      currency: r.currency,
      state: r.state,
      provider: r.provider,
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
      requestedAt: r.requestedAt,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt,
      settledAt: r.settledAt,
      rivalWithdrawalId: r.rivalWithdrawalId,
      rivalSubmittedAt: r.rivalSubmittedAt,
      rivalNeedsAttention: r.rivalNeedsAttention,
      rivalAttentionReason: r.rivalAttentionReason,
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
  }) {
    const conditions = [
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
   * Each arm hands its own user-id column to `armWhere`, which returns that
   * arm's whole WHERE clause — or an empty fragment for "no restriction".
   * Per arm rather than on the outer SELECT, so each branch keeps its own
   * `user_idx` usable and Postgres prunes before the union rather than after:
   * on the admin list the clause is the actor's client-scope predicate, an
   * EXISTS that would otherwise run over every row the union produced.
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
  private movementsCte(armWhere: (userIdColumn: SQL) => SQL, includeRebates: boolean): SQL {
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
          'success'::text,
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
          NULL::text,                             -- destination
          NULL::uuid,                             -- destination_trading_account_id
          NULL::varchar,                          -- proof_filename
          NULL::jsonb,                            -- proof_details
          NULL::text,                             -- rejection_reason: it cannot fail
          NULL::uuid,                             -- reviewed_by
          NULL::timestamptz,                      -- reviewed_at
          le.created_at                           AS settled_at,
          NULL::varchar,                          -- rival_external_id
          NULL::varchar,                          -- rival_withdrawal_id
          NULL::timestamptz,                      -- rival_submitted_at
          FALSE,                                  -- rival_needs_attention
          NULL::text,                             -- rival_attention_reason
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
          END::varchar                            AS method_name,
          NULL::varchar                           AS method_label,
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
           * b.id::text, not le.reference_id::uuid. reference_id is a varchar
           * holding ids from several tables, so casting IT would throw on any
           * row whose reference is not a uuid — the cast is evaluated before
           * the reference_type filter can exclude it.
           *
           * NO BACKTICKS: the whole query is a template literal, as the arms
           * above warn. This comment had them and broke the parse.
           */
          ON b.id::text = le.reference_id AND le.reference_type = 'accrual_batch'
        ${armWhere(sql`w.user_id`)}
      `
      : sql``;

    return sql`
      WITH combined AS (
        SELECT
          t.id,
          t.user_id,
          t.wallet_id,
          t.direction::text                       AS direction,
          t.amount,
          t.currency,
          t.state::text                           AS state,
          t.method_key,
          t.withdrawal_method_key,
          t.provider,
          t.provider_ref,
          t.destination,
          t.destination_trading_account_id,
          t.proof_filename,
          t.proof_details,
          t.rejection_reason,
          t.reviewed_by,
          t.reviewed_at,
          t.settled_at,
          t.rival_external_id,
          t.rival_withdrawal_id,
          t.rival_submitted_at,
          t.rival_needs_attention,
          t.rival_attention_reason,
          t.created_at,
          /*
           * ONE name for both rails. A deposit names its method through
           * method_key, a withdrawal through withdrawal_method_key into a
           * DIFFERENT table — one row can never match both, so the coalesce is
           * unambiguous rather than a guess about precedence.
           */
          COALESCE(pm.name, wpm.name)             AS method_name,
          -- The DESK's name (0161): admin mappings read it, the client's never do.
          COALESCE(pm.internal_label, pm.name, wpm.internal_label, wpm.name) AS method_label,
          'payment'::text                         AS kind,
          NULL::uuid                              AS trading_account_id
        FROM transactions t
        LEFT JOIN payment_methods pm ON pm.key = t.method_key
        LEFT JOIN withdrawal_payment_methods wpm ON wpm.key = t.withdrawal_method_key
        ${armWhere(sql`t.user_id`)}

        UNION ALL

        SELECT
          tr.id,
          tr.user_id,
          tr.wallet_id,
          CASE WHEN tr.direction = 'account_to_wallet' THEN 'deposit' ELSE 'withdrawal' END,
          tr.amount,
          tr.currency,
          CASE tr.state
            WHEN 'settled' THEN 'success'
            WHEN 'failed'  THEN 'failure'
            ELSE 'pending'
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
          NULL::text,                             -- destination
          NULL::uuid,                             -- destination_trading_account_id
          NULL::varchar,                          -- proof_filename
          NULL::jsonb,                            -- proof_details
          /*
           * The transfer's failure reason lands in rejection_reason: both
           * answer "why did this not happen", and giving them one column means a
           * screen showing the reason shows it for every kind of movement.
           */
          tr.failure_reason,
          NULL::uuid,                             -- reviewed_by
          NULL::timestamptz,                      -- reviewed_at
          tr.settled_at,
          NULL::varchar,                          -- rival_external_id
          NULL::varchar,                          -- rival_withdrawal_id
          NULL::timestamptz,                      -- rival_submitted_at
          FALSE,                                  -- rival_needs_attention
          NULL::text,                             -- rival_attention_reason
          tr.created_at,
          NULL::varchar                           AS method_name,
          NULL::varchar                           AS method_label,
          'transfer'::text                        AS kind,
          tr.trading_account_id
        FROM transfers tr
        ${armWhere(sql`tr.user_id`)}

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
          'success'::text,
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
          NULL::text,                             -- destination
          NULL::uuid,                             -- destination_trading_account_id
          NULL::varchar,                          -- proof_filename
          NULL::jsonb,                            -- proof_details
          NULL::text,                             -- rejection_reason: it cannot fail
          NULL::uuid,                             -- reviewed_by
          NULL::timestamptz,                      -- reviewed_at
          iwt.created_at                          AS settled_at,
          NULL::varchar,                          -- rival_external_id
          NULL::varchar,                          -- rival_withdrawal_id
          NULL::timestamptz,                      -- rival_submitted_at
          FALSE,                                  -- rival_needs_attention
          NULL::text,                             -- rival_attention_reason
          iwt.created_at,
          NULL::varchar                           AS method_name,
          NULL::varchar                           AS method_label,
          'commission_transfer'::text             AS kind,
          NULL::uuid                              AS trading_account_id
        FROM ib_wallet_transfers iwt
        ${armWhere(sql`iwt.user_id`)}

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
    const selection = sql`${this.movementsCte((owner) => sql` WHERE ${owner} = ${userId}`, true)}
      SELECT * FROM combined
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
     * ⚠️ It named the desk's payout state anyway — `rivalWithdrawalId`,
     * `rivalSubmittedAt`, `rivalNeedsAttention`, `rivalAttentionReason` — plus
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
        reviewedBy: row.reviewed_by,
        reviewedAt: instantOrNull(row.reviewed_at),
        settledAt: instantOrNull(row.settled_at),
        rivalExternalId: row.rival_external_id,
        createdAt: instantOf(row.created_at),
        methodName: row.method_name,
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
      /*
       * INCLUSIVE at both ends, compared by DATE PART.
       *
       * `created_at::date >= from` rather than `created_at >= from`. Comparing a
       * timestamp against the end date parsed as midnight excludes almost the
       * whole final day — the "my newest transaction vanished when I set an end
       * date" bug the portal's date-range.ts exists to prevent.
       */
      ...(query.from ? [sql`created_at::date >= ${query.from}::date`] : []),
      ...(query.to ? [sql`created_at::date <= ${query.to}::date`] : []),
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
    const selection = sql`${this.movementsCte((owner) => sql` WHERE ${owner} = ${userId}`, true)}
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

    const cte = this.movementsCte((owner) => {
      const conditions: SQL[] = [];
      /*
       * In the ARM's WHERE clause: an out-of-scope movement never enters the
       * union, so it also cannot appear in the counts, the summary or the
       * export computed from it — the same rule `listForAdmin` states for the
       * withdrawal queue, applied one level deeper.
       */
      const scoped = clientScopePredicate(filter.scope, owner);
      if (scoped) conditions.push(scoped);
      // Validated as a UUID at the edge — an unvalidated value against a uuid
      // column is the 500 common/query-params.ts documents.
      if (filter.userId) conditions.push(sql`${owner} = ${filter.userId}::integer`);
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
    }, false);

    /*
     * The client columns, joined once for display, search and the export —
     * INNER, because every movement's user_id is a NOT NULL FK onto users, so
     * the join can drop nothing.
     */
    const joined = sql`${cte}
      SELECT
        combined.*,
        users.email      AS user_email,
        users.first_name AS user_first_name,
        users.last_name  AS user_last_name,
        users.id  AS user_portal_id
      FROM combined
      JOIN users ON users.id = combined.user_id`;

    // Escaped, so a literal % or _ in the search means itself — the same
    // `escapeLike` the client and KYC queues adopted; an unescaped `_` turns
    // "j_n@x.com" into a one-character wildcard and over-matches silently.
    // A Portal ID or a name/email — see `clientIdentitySearch`. Joined as
    // plain `users` (it was aliased `u`) so the shared expression applies here
    // too, and this search cannot drift from the other six.
    const q = filter.q?.trim() || undefined;

    /*
     * The counts do not need the client columns unless the SEARCH references
     * them — and Postgres cannot eliminate an inner join on its own. Counting
     * over the bare union saves one `users` probe per movement row on every
     * facet of every page render; the join is count-neutral either way (the
     * FK is NOT NULL), so the numbers cannot differ.
     */
    const countSource = q ? joined : sql`${cte} SELECT combined.* FROM combined`;

    /*
     * `omit` is how the count facets stay honest — the same two-axis rule the
     * withdrawal queue documents, applied SYMMETRICALLY: each facet ignores
     * exactly ITS OWN axis (state tabs ignore the state filter, direction
     * tabs the direction filter) and honours every other filter, so the two
     * facet rows on one screen always describe the same filtered set. NOTHING
     * may ever omit the scope — it lives in the CTE's arms, upstream of every
     * caller of this builder.
     */
    const conditionsFor = (omit: { state?: boolean; direction?: boolean } = {}): SQL[] => {
      const conditions: SQL[] = [];
      if (!omit.direction && filter.direction) {
        conditions.push(sql`combined.direction = ${filter.direction}`);
      }
      if (filter.kind) conditions.push(sql`combined.kind = ${filter.kind}`);
      if (!omit.state && filter.state) conditions.push(sql`combined.state = ${filter.state}`);
      if (filter.currency) conditions.push(sql`combined.currency = ${filter.currency}`);
      if (filter.attention) conditions.push(sql`combined.rival_needs_attention`);
      /*
       * INCLUSIVE at both ends, and SARGABLE: the bounds are computed on the
       * constants, never by casting the column. `created_at::date >= x` wraps
       * every row's column in a cast no b-tree can serve, so the one filter
       * that should shrink the scan most shrank it not at all; `created_at >=
       * x::date` and `< to + 1 day` are the same inclusive-by-date-part
       * semantics (both sides resolve in the session timezone) with the
       * column left bare for the 0094 indexes to range-scan.
       */
      if (filter.from) conditions.push(sql`combined.created_at >= ${filter.from}::date`);
      if (filter.to) {
        conditions.push(sql`combined.created_at < ${filter.to}::date + interval '1 day'`);
      }
      // The same three columns every admin queue searches (see `listForAdmin`),
      // plus what identifies an offline deposit (see `depositEvidenceSearch`).
      if (q) {
        /*
         * The same concatenation as the drizzle queues above, spelled in raw
         * SQL because this list is assembled as text. Three OR-ed ILIKEs
         * cannot use `users_search_trgm_idx`; the concatenation is the
         * expression the index was built on.
         */
        const identity = clientIdentitySearch(q);
        const evidence = depositEvidenceSearch(q);
        conditions.push(evidence ? sql`(${identity} OR ${evidence})` : identity);
      }
      return conditions;
    };

    return { joined, countSource, conditionsFor, whereOf };
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

    const { joined, countSource, conditionsFor, whereOf } = this.adminMovements(filter);

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

    const orderDir = direction === 'asc' ? sql`ASC` : sql`DESC`;
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
     */
    const [rows, stateRows, directionRows] = await Promise.all([
      this.db.execute(sql`
        ${joined}${whereOf(pageConditions)}
        ORDER BY ${sortSpec.column} ${orderDir}, combined.id ${orderDir}
        LIMIT ${limit + 1} OFFSET ${usingCursor ? 0 : (page - 1) * limit}
      `),
      this.db.execute(sql`
        WITH counted AS (${countSource}${whereOf(conditionsFor({ state: true }))})
        SELECT state, count(*)::int AS value FROM counted GROUP BY state
      `),
      this.db.execute(sql`
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
      needsAttention: row.rival_needs_attention,
      attentionReason: row.rival_attention_reason,
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
    const { joined, conditionsFor, whereOf } = this.adminMovements(filter);

    const conditions = conditionsFor();
    conditions.push(sql`combined.created_at <= ${filter.startedAt.toISOString()}::timestamptz`);
    if (filter.after) {
      conditions.push(
        sql`(combined.created_at, combined.id) < (${filter.after.createdAt}::timestamptz, ${filter.after.id}::uuid)`,
      );
    }

    const rows = await this.db.execute(sql`
      ${joined}${whereOf(conditions)}
      ORDER BY combined.created_at DESC, combined.id DESC
      LIMIT ${filter.limit}
    `);

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
    const grouped = await this.db.execute(sql`
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

  /**
   * Move a settled deposit on to the trading account it was aimed at.
   *
   * ## Two movements, and the client sees both
   *
   * A deposit routed to an account is a DEPOSIT into the wallet followed by a
   * TRANSFER out of it. It is not one operation with a different endpoint: the
   * wallet is this system's ledger, every deposit lands there, and the money
   * reaches MT5 the same way any other transfer does — through
   * `TransferExecutor`, with the same idempotency key, the same hold, and the
   * same settlement.
   *
   * That also means the client's history shows the two rows that actually
   * happened, rather than one row implying money went somewhere it never was.
   *
   * ## AFTER the credit commits, never inside it
   *
   * The transfer debits the wallet, so the deposit's credit has to be durable
   * first — chaining inside the settlement transaction would take money out of a
   * balance that does not exist yet if the outer commit then failed.
   *
   * ## A failed transfer must NOT fail the deposit
   *
   * The money is legitimately in the wallet by this point. Leaving it there is
   * safe, visible and recoverable: the client can transfer it themselves, and
   * nothing is lost. Unwinding a settled deposit to punish a failed onward leg
   * would be far worse, and the reasons this can fail are ordinary — an
   * unverified client (transfers need KYC level 1), a suspended account, or an
   * unreachable bridge.
   *
   * So it is logged with the transaction id and swallowed. The deposit stands.
   */
  private async chainTransferToAccount(tx: TransactionRow): Promise<void> {
    if (!tx.destinationTradingAccountId) return;

    try {
      const transfer = await this.transfers.request({
        userId: tx.userId,
        tradingAccountId: tx.destinationTradingAccountId,
        direction: 'wallet_to_account',
        amount: tx.amount,
        currency: tx.currency,
      });

      /*
       * Executed here rather than left pending, so the common case finishes
       * while the client is still looking at the screen. `execute` is the same
       * call the transfer endpoint makes, and it is idempotent on the transfer
       * id — a retry cannot move the money twice.
       */
      await this.transferExecutor.execute(transfer.id);

      this.logger.log(
        `Deposit ${tx.id} chained transfer ${transfer.id}: ${tx.amount} ${tx.currency} ` +
          `to trading account ${tx.destinationTradingAccountId}`,
      );
    } catch (error) {
      this.logger.error(
        `Deposit ${tx.id} settled but its onward transfer to trading account ` +
          `${tx.destinationTradingAccountId} could not be made: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'The money is credited to the wallet and can be transferred from there.',
      );
    }
  }

  async getById(id: string) {
    const [tx] = await this.db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    if (!tx) throw new NotFoundError('Transaction not found.');
    return tx;
  }

  /**
   * A person reconciled a payment only a person could — clear its attention
   * flag, in one transaction with whatever the caller records beside it.
   *
   * CONDITIONAL on the flag, so a double click or two operators racing resolve
   * it once and the loser learns it was already done. Clearing the flag is what
   * ends the matching admin tasks for everyone — the `transactions` trigger
   * (migration 0140) — so this is the finish line an anomaly never had: no
   * event path ever cleared it for a deposit.
   */
  async resolveAttention(id: string, withinTx: (tx: Executor) => Promise<void>): Promise<boolean> {
    return this.db.transaction(async (dbTx) => {
      const [cleared] = await dbTx
        .update(transactions)
        .set({ rivalNeedsAttention: false, rivalAttentionReason: null })
        .where(and(eq(transactions.id, id), eq(transactions.rivalNeedsAttention, true)))
        .returning({ id: transactions.id });
      if (!cleared) return false;
      await withinTx(dbTx);
      return true;
    });
  }

  /**
   * Every state transition that moves money uses the §8.7 conditional update:
   * UPDATE ... WHERE id = ? AND state = <expected>, then check the rowcount.
   * A zero rowcount means someone else already transitioned it — abort rather
   * than act twice. This is what stops a double-clicked button paying twice.
   */
  private async transition(
    id: string,
    from: string,
    patch: Record<string, unknown>,
    executor?: Executor,
  ) {
    const [row] = await (executor ?? this.db)
      .update(transactions)
      .set(patch)
      .where(and(eq(transactions.id, id), eq(transactions.state, from as 'pending')))
      .returning();
    return row;
  }

  /**
   * Approve a withdrawal. Whether that also PAYS it depends on who pays.
   *
   * ## Two lifecycles, and the rule that picks between them
   *
   * - **A desk payout is one step.** `pending → success`. An operator approving a
   *   withdrawal they are about to send by hand has already done the only other
   *   thing that was ever going to happen, so a separate `settle` click was an
   *   operator confirming to the system what the system had just told them to do.
   *   What that produced in practice was a queue of `approved` rows already paid in
   *   the real world and never marked, and two states a desk reconciled by memory.
   *
   * - **A provider payout is two steps.** `pending → approved → success`. Here
   *   something really does happen in between: the row is submitted to the payout
   *   rail, and the provider's own event is what says the money left. Collapsing
   *   these would mark a withdrawal PAID before anybody had been asked to pay it —
   *   and since the client's balance is debited at request time, nothing would look
   *   wrong until they asked where their money was.
   *
   * The caller states which, because the caller is what knows about payout rails;
   * this service must not. `admin-money.service.ts` asks
   * `RivalWithdrawalsService.willPayOut()`, whose conditions are pinned to the
   * claim that does the submitting.
   *
   * ## Neither step moves money
   *
   * That is the point of debiting on request: the wallet changed when the client
   * asked. Approval authorises, settlement records. `reject` and `markFailed` are
   * the paths that give money back.
   *
   * ## The control that replaced the two-person rule
   *
   * The permission, not the step count. The controller gates this on
   * `withdrawals.settle` rather than `withdrawals.approve`: holding the weaker
   * permission does not let anybody release funds. Segregation of duties is gone;
   * authority over payout is not, and that is recorded as a real reduction.
   *
   * Still the §8.7 conditional transition from `pending`, so a double-clicked
   * button cannot pay twice.
   */
  async approve(
    id: string,
    adminId: string,
    options: ApproveWithdrawalOptions,
    withinTx?: WithinTransaction,
  ) {
    // Wrapped in a transaction it did not previously need, so `withinTx` — the
    // admin audit row — commits with the state change or not at all (R-6.5).
    return this.db.transaction(async (dbTx) => {
      const now = new Date();
      const row = await this.transition(
        id,
        'pending',
        options.awaitsProviderPayout
          ? {
              /*
               * AUTHORISED, not paid. `settledAt` stays null because nothing has
               * settled: the payout rail has not been asked yet. Leaving it null is
               * what makes "approved but never submitted" visible to the
               * reconciler rather than indistinguishable from a completed payout.
               */
              state: 'approved',
              reviewedBy: adminId,
              reviewedAt: now,
            }
          : {
              /* Paid by hand. Approval records what the operator has done. */
              state: 'success',
              reviewedBy: adminId,
              reviewedAt: now,
              settledAt: now,
            },
        dbTx,
      );
      if (!row) {
        const current = await this.getById(id);
        throw new MoneyRuleError(
          `Only a pending withdrawal can be approved; this one is ${current.state}.`,
        );
      }
      await withinTx?.(dbTx, row);
      return row;
    });
  }

  async reject(id: string, adminId: string, reason: string, withinTx?: WithinTransaction) {
    /*
     * One transaction: the state change and the REFUND commit together, so a
     * failure can never leave a rejected withdrawal with the client's money
     * still debited — which would be permanent, since 'rejected' is terminal.
     */
    return this.db.transaction(async (dbTx) => {
      const row = await this.transition(
        id,
        'pending',
        { state: 'rejected', rejectionReason: reason, reviewedBy: adminId, reviewedAt: new Date() },
        dbTx,
      );
      if (!row) {
        const current = await this.getById(id);
        throw new MoneyRuleError(
          `Only a pending withdrawal can be rejected; this one is ${current.state}.`,
        );
      }
      await this.refund(row, dbTx);
      await withinTx?.(dbTx, row);
      return row;
    });
  }

  /**
   * Give back the money a refused withdrawal debited on request.
   *
   * ## A COMPENSATING ENTRY, never an edit — §6.4
   *
   * "No UPDATE, no DELETE on ledger_entries. If a balance is wrong, write a new
   * offsetting row." The original debit stays exactly as it was posted, and
   * this credit sits beside it; the pair reads as what actually happened rather
   * than as a withdrawal that was quietly unwritten.
   *
   * ## The `:refund` suffix is load-bearing
   *
   * `ledger_entries_wallet_reference_uq` is on (wallet, reference_type,
   * reference_id). Without the suffix this credit carries the SAME reference as
   * the debit it reverses, so the unique index absorbs it as a replay, ON
   * CONFLICT returns the original debit, and the client is silently never
   * refunded — with `post()` reporting success.
   *
   * With the suffix it is idempotent in its own right: rejecting twice cannot
   * refund twice, which matters because `transition` already refuses the second
   * attempt but a retry that raced it would otherwise get through.
   */
  private async refund(row: typeof transactions.$inferSelect, executor: Executor): Promise<void> {
    await this.wallets.post(
      {
        userId: row.userId,
        currency: row.currency,
        amount: toDecimal(row.amount),
        // `adjustment`, not `deposit`: no money entered the platform. A report
        // summing deposits would otherwise count every refused withdrawal as
        // one.
        entryType: 'adjustment',
        referenceType: LEDGER_REFERENCE.transaction,
        referenceId: `${row.id}:refund`,
      },
      executor,
    );
  }

  /** Provider confirmed: close the transaction. The debit posted at request. */
  async settle(id: string, adminId: string, providerRef: string, withinTx?: WithinTransaction) {
    /*
     * NO BALANCE CHANGE HERE any more, and that is the whole point of debiting
     * on request: by the time an admin settles, the money left the balance when
     * the client asked for it. Settlement records that the provider paid out.
     *
     * The version this replaces posted the debit and released the hold here, in
     * one transaction with the state change — because three separate commits
     * had left a row marked 'success' with no debit posted, which duplicated
     * money unrecoverably. That failure mode is gone with the step itself.
     */
    return this.db.transaction(async (dbTx) => {
      const row = await this.transition(
        id,
        'approved',
        { state: 'success', providerRef, settledAt: new Date(), reviewedBy: adminId },
        dbTx,
      );
      if (!row) {
        const current = await this.getById(id);
        throw new MoneyRuleError(
          `Only an approved withdrawal can be settled; this one is ${current.state}.`,
        );
      }

      await withinTx?.(dbTx, row);
      return row;
    });
  }

  /**
   * Provider failed after approval: refund, exactly as a rejection does.
   *
   * Takes an `actor` and an audit hook for the same reason approve/reject/settle
   * do — R-4.3 and R-6.5. This had neither: no actor, no assertion, no audit
   * row, and no callers, which is exactly the shape a provider-callback job will
   * reach for once the Whish and USDT integrations land. A money state change
   * nobody is accountable for is easier to prevent now than to explain later.
   *
   * Background work passes SYSTEM_ACTOR, which is a named principal rather than
   * an implicit bypass — a callback IS the system acting, and the audit row
   * should say so.
   */
  async markFailed(id: string, reason: string, actor: Actor, withinTx?: WithinTransaction) {
    // Failing a withdrawal RETURNS the money to the client, so it belongs with
    // settlement rather than with approval — it is the settle step's error
    // path, and whoever may complete a payout may also unwind one (R-5.4).
    assertActorCan(actor, 'withdrawals.settle', 'mark a withdrawal failed');
    return this.db.transaction(async (dbTx) => {
      const row = await this.transition(
        id,
        'approved',
        { state: 'failure', rejectionReason: reason, settledAt: new Date() },
        dbTx,
      );
      if (!row) {
        const current = await this.getById(id);
        throw new MoneyRuleError(
          `Only an approved withdrawal can be marked failed; this one is ${current.state}.`,
        );
      }
      await this.refund(row, dbTx);
      await withinTx?.(dbTx, row);
      return row;
    });
  }

  /**
   * A client DECLARES a deposit they are about to send — CORE-06.
   *
   * This is not `creditDeposit` below and must never become it. Nothing is
   * credited here: the row is `pending`, the wallet is untouched, and the money
   * only lands when an operator confirms the transfer actually arrived.
   *
   * ## Why this exists when the payment providers do not
   *
   * The deposit screen said "waiting on backend endpoints" and named
   * `POST /payments/deposits` and a provider webhook. Both were blocked on
   * Whish/USDT credentials (§12.5, D-05) — but only the AUTOMATED flow was.
   * The flow every broker runs regardless needs no third-party credential: the
   * client says what they are sending, quotes a reference, and the operator
   * reconciles it against the bank statement.
   *
   * So the endpoint the screen was waiting for is still unbuilt, and this is a
   * different endpoint for a flow that was available all along.
   *
   * ## The reference
   *
   * The response's whole point. An operator working through a bank statement
   * has an amount and a name, and both repeat across clients; the reference is
   * what ties one incoming payment to one declared deposit without a phone
   * call. It doubles as the row's `providerRef`, so the UNIQUE(provider,
   * provider_ref) index that makes provider callbacks idempotent also
   * guarantees no two declarations can ever share a reference.
   */
  async requestDeposit(params: {
    userId: number;
    amount: string;
    currency: Currency;
    method: string;
    /** Set when the client chose to fund a trading account rather than the wallet. */
    destinationTradingAccountId?: string;
    /*
     * The receipt for an OFFLINE deposit — the stored `<uuid>.jpg`, already
     * written to DEPOSIT_PROOF_BUCKET by the caller.
     *
     * Passed in rather than uploaded here because this service does not touch
     * files: the controller writes the object, then hands over a name. The two
     * are tied together by the caller's rollback — if this method throws, the
     * object it just wrote is removed.
     */
    proofFilename?: string;
    /*
     * The client's answers to the method's `proofFields` (0162), as submitted —
     * `details[<fieldId>]` parts of the offline form. Judged here against the
     * fields the method asks NOW; see `readProofDetails`.
     */
    details?: unknown;
  }) {
    const amount = toDecimal(params.amount);
    // `lessThanOrEqualTo(0)`, NOT `!isPositive()` — see the withdrawal guard
    // above: decimal.js gives ZERO a sign of 1, so the obvious spelling is a
    // no-op for zero and the refusal arrives from the ledger instead.
    if (amount.lessThanOrEqualTo(0)) throw new ValidationError('Deposit amount must be positive.');

    /*
     * The METHOD decides the currency, and is checked before it.
     *
     * `assertUsable` refuses one that is unknown, disabled, or has no pay-to
     * details configured — a client cannot deposit through an account nobody
     * has set up. It returns the row, so the currency and the per-method bounds
     * come back without a second read.
     *
     * This replaced an `@IsIn(DEPOSIT_METHODS)` over a hardcoded two-element
     * union. Methods are operator data now: adding one is a row, and disabling
     * one when a provider goes down does not need a deploy.
     */
    const paymentMethod = await this.paymentMethods.assertUsable(params.method);

    /*
     * The method's currency wins over whatever the client sent.
     *
     * A Whish deposit is a USD deposit — that is a property of the method, not
     * a choice. Taking the caller's currency here would let a request name a
     * method denominated in one currency and a wallet in another, and the money
     * would land somewhere the operator never agreed to receive it.
     */
    const { code: currency, decimals } = await this.currencies.assertUsableDetail(
      paymentMethod.currency,
    );

    /*
     * Does this deposit go through a hosted payment page, or is it a declaration
     * an operator confirms by hand?
     *
     * Asked of `PaymentGateways` rather than read off the row. The `kind` column
     * went in migration 0043: it claimed to say how a method behaved, while the
     * real answer is whether THIS BUILD has an implementation for the key —
     * which is what is asked here, and what `PaymentMethodsService` was already
     * overriding the column with on every read.
     *
     * `isImplemented`, not `isConfigured`. By this point `assertUsable` has
     * already refused a gateway whose credentials are missing, and treating one
     * as manual here would file a bank-transfer declaration against a provider
     * with no bank account.
     */
    const isGateway = this.gateways.isImplemented(paymentMethod.key);

    /*
     * ── OFFLINE METHODS: the receipt is not optional ────────────────────────
     *
     * `requires_proof` is the method saying "the client pays outside this
     * system, so the only evidence anybody will ever have is the image". The
     * check lives HERE, not in a DTO, because it is a property of the method
     * the client chose and DTO validation cannot see the row.
     *
     * Both directions are refused, and each closes a real door:
     *
     *   proof missing on an offline method — the JSON route has no file field
     *   at all, so this is what stops a client bypassing the multipart door and
     *   filing a declaration with nothing attached. Without it the desk gets a
     *   queue of rows it cannot act on.
     *
     *   proof present on a method that did not ask for one — a gateway deposit
     *   is settled by the provider's webhook, so an attached image is evidence
     *   of nothing and would sit beside a payment this platform never handled.
     *
     * A method configured as BOTH a gateway and requires_proof is a
     * contradiction, and it is refused rather than resolved: guessing which half
     * the operator meant is how money ends up on a rail nobody chose.
     */
    if (paymentMethod.requiresProof && isGateway) {
      throw new ValidationError(
        `Payment method "${paymentMethod.key}" is configured to need a receipt and is also a ` +
          'hosted gateway. Those cannot both be true — fix the method before taking deposits on it.',
      );
    }
    if (paymentMethod.requiresProof && !params.proofFilename) {
      throw new ValidationError(
        'This payment method needs a picture of your transfer receipt. Please attach one.',
      );
    }
    if (!paymentMethod.requiresProof && params.proofFilename) {
      throw new ValidationError(`Payment method "${paymentMethod.key}" does not take a receipt.`);
    }
    /*
     * The details that identify the payment — the phone it was sent from, a
     * transfer code — judged before anything is written, so a refusal leaves
     * nothing behind (the controller removes the receipt it stored). Only an
     * offline method asks; a gateway deposit never carries any.
     */
    const proofDetails = paymentMethod.requiresProof
      ? readProofDetails(paymentMethod.proofFields, true, params.details)
      : [];

    // Per-method bounds AND the platform's own, because neither is derivable
    // from the other — a provider may refuse under $20 while the platform's
    // floor is $10.
    /*
     * Same two-scale rule as a withdrawal (D-77), and the deposit side is the
     * one where it bites harder.
     *
     * A deposit CREDITS `tx.amount` while the payment link is created at the
     * rail's scale (`quantiseIn`), so an amount with more places than the rail
     * can handle asks the client to pay one figure and credits them another.
     * Money-in rounds to NEAREST rather than down, so it can credit MORE than
     * was collected — the broker pays the difference, on every such deposit.
     *
     * Bounded by the SMALLER of the currency's decimals and the rail's scale,
     * for the reason the withdrawal path spells out: `currencies.decimals` is
     * operator data accepting 0 to 8, so checking it alone leaves the whole rule
     * inert the moment a currency is configured past what the rail supports.
     *
     * A MANUAL method has no rail and is bounded by the currency alone — an
     * operator reconciling a bank statement can handle whatever it expresses.
     */
    const railScale = this.gateways.settlementScale(paymentMethod.key);
    const payableDecimals = railScale === null ? decimals : Math.min(decimals, railScale);
    if (amount.decimalPlaces() > payableDecimals) {
      /*
       * HALF-UP, and this was wrong the other way round for a while.
       *
       * It rounded DOWN "for consistency with the withdrawal message", which
       * sounded reasonable and put two different numbers on one screen: the pay
       * button renders the amount through the portal's `formatMoney`, which
       * rounds HALF-UP for display, so `50.129` produced a button promising
       * "Pay $50.13" beside this message saying "Try 50.12 USD" — and clicking
       * the button failed.
       *
       * Consistency with the OTHER endpoint's wording mattered far less than
       * consistency with the number the client is looking at. A deposit also has
       * no balance to overshoot: the client is paying, so there is nothing to
       * protect by rounding down, and half-up is what they meant by 50.129.
       *
       * A WITHDRAWAL still floors, for the reason that does not apply here —
       * suggesting more than the client holds trades one refusal for another.
       */
      throw new ValidationError(
        `${paymentMethod.name} takes ${currency} to ${payableDecimals} decimal ` +
          `${payableDecimals === 1 ? 'place' : 'places'}. Use ` +
          `${amount.toDecimalPlaces(payableDecimals, Decimal.ROUND_HALF_UP).toFixed(payableDecimals)} ` +
          `${currency} instead.`,
      );
    }

    /*
     * The method's resolved range: the tighter of its CURRENCY's deposit limits
     * and its own optional one (0162). The platform-wide pair this used to
     * re-check here is gone — it was one USD-sized number for every currency.
     */
    this.paymentMethods.assertAmountWithin(paymentMethod, amount);

    /*
     * The chosen trading account, validated NOW rather than at settlement.
     *
     * The alternative — storing whatever id arrived and checking when the
     * operator confirms the payment — means the client's money has already been
     * received before anybody discovers the destination is a demo account, a
     * deleted one, or somebody else's. At that point the deposit cannot be
     * completed as declared and someone has to unpick it by hand.
     *
     * `userId` in the WHERE clause, so not-found and not-yours are the same
     * answer: an equality check after the fetch is one refactor away from being
     * dropped, and the consequence is funding a stranger's account.
     */
    if (params.destinationTradingAccountId) {
      const [account] = await this.db
        .select()
        .from(tradingAccounts)
        .where(
          and(
            eq(tradingAccounts.id, params.destinationTradingAccountId),
            eq(tradingAccounts.userId, params.userId),
          ),
        )
        .limit(1);
      if (!account) throw new NotFoundError('Trading account not found.');
      if (account.environment !== 'live') {
        throw new ValidationError(
          'Only live trading accounts can be funded. Demo accounts trade practice money and are not linked to your wallet.',
        );
      }
    }

    const wallet = await this.wallets.getOrCreateWallet(params.userId, currency);
    const reference = depositReference();

    const [tx] = await this.db
      .insert(transactions)
      .values({
        userId: params.userId,
        walletId: wallet.id,
        direction: 'deposit',
        amount: money(params.amount),
        currency,
        // What the client asked to FUND. The money still lands in the wallet —
        // that is the CRM's ledger — and settlement chains a transfer to move
        // it on. Null for an ordinary wallet deposit.
        destinationTradingAccountId: params.destinationTradingAccountId ?? null,
        // PENDING. The client has promised money, not sent it. Anything else
        // here would credit a balance off an unverified claim.
        state: 'pending',
        /*
         * The method the client chose, as a real foreign key.
         *
         * `provider` keeps the `manual_` prefix beside it: it is what
         * UNIQUE(provider, provider_ref) is scoped on, and keeping manual
         * declarations obviously distinct from a future gateway's rows means a
         * reconciliation job cannot confuse the two. When Whish becomes a
         * `gateway` method its rows will carry `whish` there instead, and the
         * two eras stay tellable apart.
         */
        methodKey: paymentMethod.key,
        /*
         * A GATEWAY row carries the bare provider key; a manual declaration
         * keeps its `manual_` prefix. The comment above records why: the two
         * eras must stay tellable apart in a reconciliation, and
         * UNIQUE(provider, provider_ref) is scoped on this column.
         */
        provider: isGateway ? paymentMethod.key : `manual_${paymentMethod.key}`,
        providerRef: reference,
        // The receipt, or null on every method that does not ask for one.
        proofFilename: params.proofFilename ?? null,
        // Each answer with its label AS ASKED; immutable from here (0162 trigger).
        proofDetails: proofDetails.length > 0 ? proofDetails : null,
      })
      .returning();

    /*
     * A gateway deposit gets a payment LINK; a manual one gets instructions.
     *
     * The row is written FIRST and the provider called second, deliberately. If
     * the call fails, what is left behind is a pending deposit with no link —
     * visible, refusable, and re-startable. The other order risks a payment
     * existing at Whish that this system has no record of, which is money
     * arriving against a reference nobody can reconcile.
     *
     * `reference` is the externalId: it is already unique (the insert above
     * would have failed otherwise), it is what support quotes, and Whish treats
     * a reused one as a replay — so a retried request converges on one payment
     * rather than creating a second.
     *
     * ## ⚠️ WHAT THE ROW MUST SAY IF THE PROVIDER REFUSES
     *
     * Writing first is right and stays. What was wrong is what the row said
     * afterwards: it kept its `pending` state, which the client's transaction
     * list renders as money on its way. So a deposit that never started — the
     * gateway unreachable, credentials rejected, the request refused — sat in
     * the client's own history as processing, indefinitely, with no payment link
     * and nothing to reconcile it against. The client waits for a balance that
     * is not coming, and support has a queue of pending deposits that are not.
     *
     * A definite refusal now marks the row `failure`. It is NOT deleted: the
     * attempt happened, the client made it, and it is the row support quotes
     * when the client says "I tried and it did not work".
     *
     * ## The one case that must STAY pending
     *
     * `PaymentIndeterminateError` — the provider answered "I do not know"
     * (Whish's code `500`). A payment link may exist and may still be paid.
     * Marking that failed would tell a client who went on to pay that their
     * money did not arrive, which is far more expensive than a stale pending
     * row, and the reconciler settles it from `getStatus` either way.
     *
     * Nothing is credited or reversed on this path. It is a state correction on
     * a row that never touched a balance — `requestDeposit` writes no ledger
     * entries at all.
     */
    let paymentUrl: string | null = null;
    if (isGateway) {
      try {
        const started = await this.gateways.startPayment(paymentMethod.key, {
          amount: money(params.amount),
          currency,
          invoice: `Deposit ${reference}`,
          /*
           * Our reference as the idempotency key: a retried request converges
           * on ONE Rival payment. No callback URLs any more — Rival owns the
           * provider relationship and reports back through the signed CRM
           * webhook and the poll backstop, never through an anonymous GET.
           */
          idempotencyKey: reference,
          successRedirectUrl: this.payerRedirectUrl(paymentMethod.key, reference, 'success'),
          failureRedirectUrl: this.payerRedirectUrl(paymentMethod.key, reference, 'failure'),
        });
        paymentUrl = started.paymentUrl;
        /*
         * Rival's externalId, stored the moment it is known. It is the ONLY
         * key inbound webhook events address this payment by (their
         * `transaction.id` is null on pending/failed), so a row without it is
         * invisible to the event stream and settles by poll alone.
         */
        await this.db
          .update(transactions)
          .set({ rivalExternalId: started.rivalExternalId })
          .where(eq(transactions.id, tx.id));
      } catch (error) {
        if (error instanceof PaymentIndeterminateError) {
          /*
           * The create may have landed at Rival without a usable answer. If
           * Rival got far enough to assign an externalId, keep it — the
           * poller can then ask directly; without one, the poller replays the
           * create under the same idempotency key and converges either way.
           */
          const externalId = error.details?.['rivalExternalId'];
          if (typeof externalId === 'string' && externalId.length > 0) {
            await this.db
              .update(transactions)
              .set({ rivalExternalId: externalId })
              .where(eq(transactions.id, tx.id));
          }
        }
        if (!(error instanceof PaymentIndeterminateError)) {
          await this.db
            .update(transactions)
            .set({
              state: 'failure',
              /*
               * The provider's own reason, kept on the row. These messages are
               * already written to be shown to a client, so this leaks nothing
               * — and "the payment provider refused the request" is exactly what
               * support needs when the client asks why, months later, from a row
               * that would otherwise say only `failure`.
               */
              rejectionReason:
                error instanceof Error ? error.message : 'The payment could not be started.',
              settledAt: new Date(),
            })
            .where(eq(transactions.id, tx.id));
        }
        /*
         * Rethrown either way. The client asked to deposit and no deposit is
         * possible; swallowing this would return a confirmation screen for a
         * payment with no link and no chance of arriving.
         */
        throw error;
      }
    }

    /*
     * Ring the bells of whoever will have to ACTION this — manual methods only.
     *
     * A manual declaration ("I sent a bank transfer, reference X") settles by an
     * admin looking at the receipt and approving it — `PATCH
     * /admin/deposits/:id/approve`, gated on `deposits.approve`, which is the
     * permission this rings.
     *
     * It rang `wallets.credit` until the offline deposit desk existed, because
     * there was no deposit approval route at all and the only way to settle one
     * was to type the amount into `POST /admin/wallets/credit` — which minted a
     * SECOND, unrelated row and left the client's declaration pending for ever.
     * Ringing the old key now would page the people who can mint arbitrary
     * credit rather than the people who work this queue. Until somebody looks,
     * the client's money is sitting in a real bank account against a row nobody
     * has been told about — which is exactly the case that used to be found only
     * when the client chased it.
     *
     * A GATEWAY deposit rings nothing, deliberately. It settles from the signed
     * webhook (or the poll backstop) with no human in the path, so a bell would
     * announce a queue item that does not exist and train operators to ignore
     * the ones that do. The client still hears about it — `deposit.succeeded`
     * fires on settlement.
     *
     * Post-write and never-throws, like the withdrawal fan-out above: the row is
     * already committed, and the polled queue badge stays the durable signal.
     * The dedupe key is the transaction id, so a retried request that converged
     * on one row also converges on one bell.
     */
    if (!isGateway) {
      void this.notifications.notifyAdmins({
        kind: 'admin.deposit.submitted',
        params: {
          transactionId: tx.id,
          amount: tx.amount,
          currency: tx.currency,
          // The DESK's name (0161), never the key: this is the sentence an
          // operator reads ("…sent 100 USD by OMT – Hamra"). Snapshot at filing.
          method: paymentMethod.internalLabel,
          reference,
        },
        dedupeKey: `admin.deposit.submitted:${tx.id}`,
        subject: { id: tx.id, clientId: tx.userId },
      });
    }

    return {
      id: tx.id,
      reference,
      amount: tx.amount,
      currency: tx.currency,
      method: paymentMethod.key,
      state: tx.state,
      createdAt: tx.createdAt.toISOString(),
      /*
       * Null for a manual method, and the portal branches on it. A screen that
       * assumed a link would send a bank-transfer client to nowhere; one that
       * assumed instructions would leave a gateway client with an account
       * number that is not how this method works.
       */
      paymentUrl,
    };
  }

  /** Where the CLIENT's browser lands after paying. The portal, not the API. */
  private redirectUrl(method: string, reference: string, outcome: 'success' | 'failure'): string {
    const base = (this.config.get<string>('PORTAL_URL') ?? '').replace(/\/+$/, '');
    /*
     * `method` travels too, and its absence was a latent bug.
     *
     * The landing page settles by calling
     * `GET /payments/deposits/:reference/status?method=…`, and that query
     * matches on `transactions.provider` — so the method has to be right or the
     * lookup finds nothing. Only `reference` was sent, so the portal defaulted
     * to `whish` and documented itself as reading the method "from the query
     * when present". It was never present.
     *
     * With one gateway that was invisible. The day a second one is added, every
     * redirect from it would settle against `whish`, miss, and leave the client
     * on "not confirmed yet" for a payment that had gone through — while the
     * comment claimed the case was handled.
     */
    return (
      `${base}/deposit/${outcome}` +
      `?reference=${encodeURIComponent(reference)}&method=${encodeURIComponent(method)}`
    );
  }

  /**
   * The redirect URL the PROVIDER gets — the API's return bounce when the API
   * has a public address, the portal directly as a fallback, or nothing.
   *
   * Preference order, and why (tech lead's direction):
   *
   *  1. `API_PUBLIC_URL` + the `PaymentsReturnController` bounce. The provider
   *     only ever sees the API origin — which is public anyway, for webhooks —
   *     and the API 302s the payer on to wherever `PORTAL_URL` points, even a
   *     localhost portal in dev (the payer's browser IS the dev machine).
   *  2. The portal directly, when no `API_PUBLIC_URL` is set but the portal
   *     address is itself payer-reachable.
   *  3. Omitted. Rival refuses localhost/loopback redirect URLs at create time
   *     (its rule is measured against live Whish, which 403s them), so sending
   *     one would fail EVERY deposit. Omitted, Rival serves its own platform
   *     result pages; settlement never depended on the redirect (webhook +
   *     poll own it).
   */
  private payerRedirectUrl(
    method: string,
    reference: string,
    outcome: 'success' | 'failure',
  ): string | undefined {
    const apiBase = (this.config.get<string>('API_PUBLIC_URL') ?? '').replace(/\/+$/, '');
    if (apiBase) {
      const bounce =
        `${apiBase}/v1/payments/deposits/${encodeURIComponent(reference)}` +
        `/return/${outcome}?method=${encodeURIComponent(method)}`;
      if (isPayerReachableUrl(bounce)) return bounce;
    }
    const direct = this.redirectUrl(method, reference, outcome);
    return isPayerReachableUrl(direct) ? direct : undefined;
  }

  /**
   * Settle a gateway deposit by ASKING THE PLATFORM, never by trusting the
   * trigger.
   *
   * ## Still the security boundary, with a stronger trigger
   *
   * The old trigger was Whish's unauthenticated GET; today it is either the
   * client's browser landing on the portal, Rival's SIGNED webhook, or the
   * poll backstop. The webhook is cryptographically verified — but this method
   * keeps the ask-don't-trust shape anyway, because it costs one cheap read of
   * Rival's stored state and means every trigger, however authenticated,
   * converges on the same authoritative answer. Money is credited on Rival's
   * status, never on the shape of whatever prompted the question.
   *
   * Safe to call repeatedly, and called from three places for that reason.
   * Whichever arrives first settles it; the rest are no-ops.
   *
   * Idempotency is the DATABASE's, twice over: the state transition is
   * conditional on the row still being pending, and `WalletService.post` is
   * guarded by `ledger_entries_wallet_reference_uq`. Neither is a
   * check-then-insert, because every check-then-insert loses under concurrency.
   */
  /**
   * The deposit's CURRENT state, for the owner only — reads nothing from the
   * provider and changes nothing. The GET the portal polls used to be
   * `settleGatewayDeposit`, i.e. a state change (and a wallet credit) behind a
   * GET, outside the anti-forgery guard, reachable by a prefetcher, a link
   * scanner or the back button. Settling is `POST …/settle` now; this is what
   * a GET is allowed to be.
   */
  async gatewayDepositState(
    method: string,
    reference: string,
    ownerId: number,
  ): Promise<{ state: string }> {
    const [tx] = await this.db
      .select({ state: transactions.state, userId: transactions.userId })
      .from(transactions)
      .where(and(eq(transactions.provider, method), eq(transactions.providerRef, reference)))
      .limit(1);
    if (!tx || tx.userId !== ownerId) throw new NotFoundError('No deposit matches that reference.');
    return { state: tx.state };
  }

  /**
   * APPROVE an offline deposit: the client says they sent money, an operator has
   * seen the receipt, and this is the credit.
   *
   * ## It is `settleGatewayDeposit` with a person where the webhook was
   *
   * Identical write, same order, same guarantees — the only difference is what
   * authorises it. A gateway deposit is settled by the provider confirming the
   * payment; an offline deposit is settled by somebody looking at an image and
   * their own bank statement. Everything after that decision is the same money
   * movement, which is why this method mirrors that one rather than inventing a
   * second way to credit a wallet.
   *
   * ## What makes a double-click safe — three layers, and the middle one carries it
   *
   *   1. `@Idempotent()` on the route: a replayed HTTP request never reaches here.
   *   2. The §8.7 conditional transition. The loser of a race throws, and because
   *      the throw happens INSIDE this transaction its own `wallets.post` is
   *      rolled back with it. This is the layer that actually stops a second
   *      credit.
   *   3. `ledger_entries_wallet_reference_uq` on (wallet, 'transaction', id).
   *      Even if two credits somehow committed, the second returns the existing
   *      entry and the balance does not move.
   *
   * ## Credit first, then transition
   *
   * The order `settleGatewayDeposit` uses. Correctness is identical either way
   * inside one transaction, so the reason is serialisation: `post` takes
   * `SELECT … FOR UPDATE` on the wallet, and taking it first means two approvals
   * for one client queue on the wallet in a consistent order rather than
   * deadlocking against each other.
   */
  async approveDeposit(id: string, adminId: string, withinTx?: WithinTransaction) {
    const tx = await this.getById(id);
    if (tx.direction !== 'deposit') {
      throw new ValidationError('That transaction is not a deposit.');
    }
    /*
     * ⚠️ A GATEWAY DEPOSIT MAY NEVER BE CREDITED BY HAND.
     *
     * Its money arrives through the provider and is confirmed by the webhook. An
     * operator approving one here would credit a client for a payment the
     * platform has no confirmation of — and the webhook would then settle it
     * again, which the ledger constraint absorbs silently, leaving a credited
     * deposit nobody can trace to a payment.
     *
     * `manual_` is the prefix `requestDeposit` writes for every non-gateway
     * method, and UNIQUE(provider, provider_ref) is scoped on that column, so it
     * is the reliable marker rather than a guess from the method key.
     */
    if (!tx.provider.startsWith('manual_')) {
      throw new MoneyRuleError(
        'That deposit settles from the payment provider, not by hand. Nothing was credited.',
      );
    }

    const row = await this.db.transaction(async (dbTx) => {
      await this.wallets.post(
        {
          userId: tx.userId,
          currency: tx.currency,
          amount: tx.amount,
          entryType: 'deposit',
          referenceType: LEDGER_REFERENCE.transaction,
          // NO suffix: this IS the deposit, not a compensation for one. The
          // reference is what ties the ledger entry to the row an operator
          // approved, and what makes a second credit impossible.
          referenceId: tx.id,
        },
        dbTx,
      );

      const now = new Date();
      const updated = await this.transition(
        id,
        'pending',
        /*
         * `settledAt` is set here, unlike an approved WITHDRAWAL, and the
         * difference is real rather than an oversight: a withdrawal waits for a
         * payout rail to move the money, so approval and settlement are two
         * events. Here the operator confirming IS the settlement — no second
         * event is coming, and the money is in the wallet the moment this
         * commits.
         */
        { state: 'success', reviewedBy: adminId, reviewedAt: now, settledAt: now },
        dbTx,
      );
      if (!updated) {
        const current = await this.getById(id);
        throw new MoneyRuleError(
          `Only a pending deposit can be approved; this one is ${current.state}.`,
        );
      }

      /*
       * The client is told in the SAME transaction as the credit, so money can
       * never be credited with the client untold (FR-CORE-07). `deposit.succeeded`
       * is the kind the portal already renders — an offline deposit reaching the
       * wallet is the same fact as a Whish one, and the client does not care that
       * an operator was involved.
       */
      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: tx.userId },
          kind: 'deposit.succeeded',
          params: { transactionId: tx.id, amount: tx.amount, currency: tx.currency },
          dedupeKey: `deposit.succeeded:${tx.id}`,
        },
        dbTx,
      );

      // The admin audit row, written by the caller inside this transaction (R-6.5):
      // if it cannot be written, the money does not move.
      await withinTx?.(dbTx, updated);
      return updated;
    });

    void this.sendDepositOutcomeEmail(tx.userId, 'succeeded', tx.amount, tx.currency);

    /*
     * A deposit aimed at a trading account becomes TWO movements, and this is the
     * second — the same call `settleGatewayDeposit` makes, so both deposit paths
     * end in the same place. POST-COMMIT and reached only by the winner of the
     * conditional transition above, which is what stops one deposit chaining two
     * transfers. It keeps its own catch: an MT5 outage must not fail an approval
     * whose ledger entry is already committed.
     */
    await this.chainTransferToAccount(tx);
    return row;
  }

  /**
   * REJECT an offline deposit — the receipt does not match, is unreadable, or
   * the money never arrived.
   *
   * ## ⚠️ THERE IS NO REFUND HERE, AND THAT IS NOT AN OMISSION
   *
   * The symmetry with `reject` for a withdrawal is a trap, because the two mean
   * opposite things. A withdrawal is DEBITED when the client asks, so refusing
   * it must post a compensating credit or the client is permanently short —
   * `rejected` is terminal.
   *
   * A deposit debits nothing. `requestDeposit` writes no ledger entry at all: it
   * records a claim that money is coming. So there is nothing to give back, and
   * posting a credit here would CREATE money the platform never received — a
   * refused deposit would become a free balance, which is the one outcome this
   * whole approval step exists to prevent.
   *
   * What the client is owed instead is an EXPLANATION, and possibly their money
   * back from wherever they actually sent it — which is support's job, not the
   * ledger's. The notification, the email and the admin copy all say so.
   *
   * `settledAt` stays null: nothing settled.
   */
  async rejectDeposit(id: string, adminId: string, reason: string, withinTx?: WithinTransaction) {
    const tx = await this.getById(id);
    if (tx.direction !== 'deposit') {
      throw new ValidationError('That transaction is not a deposit.');
    }
    if (!tx.provider.startsWith('manual_')) {
      throw new MoneyRuleError(
        'That deposit settles from the payment provider, so it cannot be rejected by hand.',
      );
    }

    const row = await this.db.transaction(async (dbTx) => {
      const rejected = await this.transition(
        id,
        'pending',
        { state: 'rejected', rejectionReason: reason, reviewedBy: adminId, reviewedAt: new Date() },
        dbTx,
      );
      if (!rejected) {
        const current = await this.getById(id);
        throw new MoneyRuleError(
          `Only a pending deposit can be rejected; this one is ${current.state}.`,
        );
      }

      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: tx.userId },
          kind: 'deposit.rejected',
          // The REASON travels with it. A client told only that their deposit was
          // refused, after they have already sent money, has nothing to act on.
          params: {
            transactionId: tx.id,
            amount: tx.amount,
            currency: tx.currency,
            reason,
          },
          dedupeKey: `deposit.rejected:${tx.id}`,
        },
        dbTx,
      );

      await withinTx?.(dbTx, rejected);
      return rejected;
    });

    /*
     * POST-COMMIT, like every decision mail. Inside the transaction it would go
     * out before the rejection was durable — and a client told their deposit was
     * refused by a transaction that then rolled back is worse than a late email.
     */
    void this.sendDepositOutcomeEmail(tx.userId, 'rejected', tx.amount, tx.currency, reason);
    return row;
  }

  async settleGatewayDeposit(
    method: string,
    reference: string,
    /**
     * The client asking, when one is. The provider callback and the poller
     * pass nothing; the portal's own call MUST, or the route is an oracle for
     * — and a way to drive the settlement of — anybody else's payment. A
     * mismatch is a 404, never a 403: the difference is an existence oracle.
     */
    opts: { ownerId?: number } = {},
  ): Promise<{ state: string }> {
    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.provider, method), eq(transactions.providerRef, reference)))
      .limit(1);

    // Not found is not an error worth shouting about: a status poll for a
    // reference this system never issued is noise, not an incident.
    if (!tx) throw new NotFoundError('No deposit matches that reference.');
    if (opts.ownerId !== undefined && tx.userId !== opts.ownerId) {
      throw new NotFoundError('No deposit matches that reference.');
    }

    // Already settled — nothing to ask, nothing to do.
    if (tx.state !== 'pending') return { state: tx.state };

    /*
     * No Rival externalId means the create never confirmed — the row exists
     * here and MAY exist at Rival. Nothing can be asked yet; the poller
     * replays the create under the same idempotency key, which either adopts
     * the orphan or mints the payment, and settlement proceeds from there.
     */
    if (!tx.rivalExternalId) return { state: tx.state };

    const result = await this.gateways.checkPayment(method, tx.rivalExternalId);

    if (!result.settled) {
      /*
       * Still payable. `pending` at Whish INCLUDES "the client tried and
       * failed" — the link stays live until it is paid or expires — so a
       * failure callback must not mark the deposit failed. Doing so would tell a
       * client their payment did not work while the link they are still looking
       * at continues to accept money.
       */
      return { state: tx.state };
    }

    if (!result.paid) {
      const updated = await this.db
        .update(transactions)
        .set({ state: 'failure', settledAt: new Date() })
        .where(and(eq(transactions.id, tx.id), eq(transactions.state, 'pending')))
        .returning();
      if (updated[0]?.state === 'failure') {
        // FR-CORE-13: the client is told the outcome. Post-write and deduped —
        // a replayed callback that lost the conditional UPDATE race lands here
        // with zero rows and says nothing.
        void this.notifications.notify({
          recipient: { kind: 'client', id: tx.userId },
          kind: 'deposit.failed',
          params: { transactionId: tx.id, amount: tx.amount, currency: tx.currency },
          dedupeKey: `deposit.failed:${tx.id}`,
        });
        void this.sendDepositOutcomeEmail(tx.userId, 'failed', tx.amount, tx.currency);
      }
      return { state: updated[0]?.state ?? tx.state };
    }

    /*
     * PAID — but check WHAT was paid before crediting it.
     *
     * The amount credited is `tx.amount`, the figure this system recorded when
     * it created the payment link, and that is correct: a Whish link is
     * fixed-amount, so the client cannot pay a different sum. What was missing
     * is any confirmation that the provider AGREES — its answer carries the
     * amount and currency, and both were being read and thrown away.
     *
     * The two have never diverged here, and this is defence rather than a
     * repair. But the failure it guards is the worst shape a deposit can take:
     * a mismatch means crediting a client money nobody paid in, silently, with
     * the ledger perfectly self-consistent afterwards and nothing to reconcile
     * against except the provider's dashboard months later. Divergence needs
     * only a re-used external id, a link edited on the provider side, or a
     * future rail whose amount is chosen by the PAYER rather than by us.
     *
     * So it REFUSES rather than guessing — the same choice `reversed` above
     * makes, and the same one `checkPlausible` makes in the commission engine.
     * Crediting the smaller figure would be inventing a business rule nobody
     * agreed to; crediting the larger gives money away. The row stays
     * `pending`, which is the only state that keeps every option open: it can
     * still be settled by hand once a human has decided what actually happened.
     */
    const claimed = result.amount;
    if (claimed !== undefined && !toDecimal(claimed).equals(toDecimal(tx.amount))) {
      const reason =
        `The payment platform reports ${claimed} ${result.currency ?? tx.currency} for this ` +
        `deposit, but it was created for ${tx.amount} ${tx.currency}. Nothing has been ` +
        'credited — confirm which figure is real before settling this by hand.';
      await this.db
        .update(transactions)
        .set({ rivalNeedsAttention: true, rivalAttentionReason: reason })
        .where(eq(transactions.id, tx.id));
      raiseAlert(
        this.logger,
        ALERT_KINDS.PAYMENT_STATE_MISMATCH,
        'page',
        'A settled deposit does not match the amount the payment platform reports. NOTHING ' +
          'was credited. Reconcile against the platform before settling it by hand.',
        {
          transactionId: tx.id,
          expected: tx.amount,
          reported: claimed,
          currency: tx.currency,
          // The alert context takes string|number; the gateway's currency is
          // optional, and a rail that reports an amount without one is telling
          // us so rather than erroring.
          reportedCurrency: result.currency ?? '(not reported)',
        },
      );
      this.announceDepositAttention(tx, 'amount_mismatch');
      return { state: tx.state };
    }

    /*
     * The credit and the state change share one transaction, so a deposit
     * marked success with no ledger entry behind it — or a credit with no
     * transaction pointing at it — is a state this system cannot reach.
     */
    const transitioned = await this.db.transaction(async (dbTx) => {
      await this.wallets.post(
        {
          userId: tx.userId,
          currency: tx.currency,
          amount: tx.amount,
          entryType: 'deposit',
          referenceType: LEDGER_REFERENCE.transaction,
          referenceId: tx.id,
        },
        dbTx,
      );

      const updated = await dbTx
        .update(transactions)
        .set({ state: 'success', settledAt: new Date() })
        .where(and(eq(transactions.id, tx.id), eq(transactions.state, 'pending')))
        .returning({ id: transactions.id });

      /*
       * FR-CORE-07: "the client is notified of the outcome." In the SAME
       * transaction as the credit, so a deposit can never be credited with the
       * client untold — and deduped on the transaction id, because provider
       * callbacks are at-least-once and two replays racing past the
       * `state !== 'pending'` check above must still converge on one row.
       */
      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: tx.userId },
          kind: 'deposit.succeeded',
          params: { transactionId: tx.id, amount: tx.amount, currency: tx.currency },
          dedupeKey: `deposit.succeeded:${tx.id}`,
        },
        dbTx,
      );

      /*
       * THE AUDIT ROW, IN THE SAME TRANSACTION AS THE CREDIT.
       *
       * Every OTHER way money enters a wallet writes one: `deposit.approve`
       * for an offline deposit a person credited, `wallet.credit` for a hand
       * adjustment. The gateway path — the one a client actually uses — wrote
       * nothing at all, so eight settled deposits totalling 3,190.12 existed in
       * the ledger with no entry in the trail. The ledger says money arrived;
       * only this says on whose authority, against which provider reference.
       *
       * `actorKind: 'system'` because a provider callback IS the system
       * acting, and recording it as an unknown admin would be a false statement
       * in the one record that must not contain any. The withdrawal side
       * already settles this way (`withdrawal.settle`, SYSTEM_ACTOR); this is
       * the deposit half of the same pattern.
       *
       * ⚠️ `details.userId` IS LOAD-BEARING, not decoration. The audit scope
       * predicate resolves a `transaction` row's client from exactly that key,
       * and a row it cannot resolve is KEPT for every reader — so omitting it
       * would publish each settled deposit to desks holding no territory over
       * that client.
       *
       * Written only when the conditional UPDATE actually won. This method is
       * deliberately reachable twice at once (provider callback plus the
       * client's browser landing), and the loser of that race must not add a
       * second row for one payment.
       */
      const settled = updated.length > 0;
      if (settled) {
        await this.auditLog.record(
          {
            actorId: SYSTEM_ACTOR.id,
            actorEmail: SYSTEM_ACTOR.email,
            actorKind: 'system',
            action: 'deposit.settle',
            subjectType: 'transaction',
            subjectId: tx.id,
            details: {
              userId: tx.userId,
              amount: tx.amount,
              currency: tx.currency,
              method: tx.methodKey ?? tx.provider,
              providerRef: tx.providerRef,
            },
          },
          dbTx,
        );
      }

      return settled;
    });

    /*
     * The outcome EMAIL, post-commit and fire-and-forget like every decision
     * mail — and gated on the transition ACTUALLY happening. This method is
     * deliberately reachable twice at once (provider callback + the client's
     * browser landing); the loser of that race is absorbed idempotently by the
     * ledger constraint and the bell dedupe, and it must not mail a second
     * "Deposit Confirmed" for the same money.
     */
    if (transitioned) {
      void this.sendDepositOutcomeEmail(tx.userId, 'succeeded', tx.amount, tx.currency);

      /*
       * A deposit aimed at a trading account becomes TWO movements, and this is
       * the second one. Gated on `transitioned` for the same reason the mail is:
       * this method is deliberately reachable twice at once — the provider
       * callback and the client's browser landing race each other — and only the
       * winner of the conditional UPDATE gets here. That is what stops one
       * deposit chaining two transfers.
       */
      await this.chainTransferToAccount(tx);
    }

    /*
     * NO COMMISSION IS ACCRUED HERE, and it must not be re-added as a share.
     *
     * A deposit is not revenue. The money still belongs to the client and is a
     * liability against it, so paying a partner a percentage handed them the
     * BROKER's funds — $700 on a $1,000 deposit at 70%, while the client kept
     * the right to withdraw all $1,000. Unbounded, and it scaled with volume.
     *
     * Partners are paid on CLOSED POSITIONS, from the broker’s own earning on
     * the trade. See `CommissionService.accrueForClosedPosition`.
     */

    return { state: 'success' };
  }

  /**
   * Recover the Rival externalId for a pending deposit whose create never
   * confirmed — the poller's repair for the indeterminate-create case.
   *
   * The create is REPLAYED under the same idempotency key (our reference).
   * Rival's documented replay semantics make this converge: an existing
   * payment is returned unchanged, a linkless orphan is re-minted, and only if
   * nothing exists is a fresh payment created. No client-visible effect either
   * way — the row stays pending and simply becomes addressable.
   */
  async recoverRivalExternalId(txId: string): Promise<boolean> {
    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, txId))
      .limit(1);
    if (!tx || tx.state !== 'pending' || tx.rivalExternalId || !tx.providerRef) return false;
    if (tx.direction !== 'deposit' || !this.gateways.isImplemented(tx.provider)) return false;

    try {
      const started = await this.gateways.startPayment(tx.provider, {
        amount: tx.amount,
        currency: tx.currency,
        invoice: `Deposit ${tx.providerRef}`,
        idempotencyKey: tx.providerRef,
        successRedirectUrl: this.payerRedirectUrl(tx.provider, tx.providerRef, 'success'),
        failureRedirectUrl: this.payerRedirectUrl(tx.provider, tx.providerRef, 'failure'),
      });
      await this.db
        .update(transactions)
        .set({ rivalExternalId: started.rivalExternalId })
        .where(and(eq(transactions.id, tx.id), isNull(transactions.rivalExternalId)));
      return true;
    } catch (error) {
      if (error instanceof PaymentIndeterminateError) {
        const externalId = error.details?.['rivalExternalId'];
        if (typeof externalId === 'string' && externalId.length > 0) {
          await this.db
            .update(transactions)
            .set({ rivalExternalId: externalId })
            .where(and(eq(transactions.id, tx.id), isNull(transactions.rivalExternalId)));
          return true;
        }
      }
      this.logger.warn(
        `Could not recover a Rival externalId for deposit ${txId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Apply one verified Rival deposit event — the webhook's and the poller's
   * entry point, mapping the event onto the state machine and DELEGATING every
   * actual settlement to `settleGatewayDeposit`, so there is exactly one code
   * path that credits a deposit no matter which trigger fired.
   *
   * The return value is for the webhook's response mapping; every outcome
   * except `unknown-reference` (503, Rival retries — the create/webhook race)
   * and `pending` (also 503: the event says settled, Rival's stored state does
   * not agree YET) answers 200.
   *
   * ## The two cases that flag a human instead of moving money
   *
   *  - `completed` against a TERMINALLY FAILED row: Rival holds the client's
   *    money, our row says the deposit failed. Auto-crediting would resurrect
   *    a terminal state; silently ignoring would strand real money. The row is
   *    flagged and someone is paged.
   *  - `reversed`, in any state: a reversal of settled client funds is a
   *    compensating-entry decision a HUMAN makes (§6.4 — the ledger is
   *    append-only and corrections are deliberate). The event is recorded, the
   *    ledger is not touched.
   */
  async applyRivalDepositEvent(
    rivalExternalId: string,
    event: 'completed' | 'failed' | 'reversed',
  ): Promise<
    'applied' | 'duplicate' | 'stale' | 'pending' | 'needs-attention' | 'unknown-reference'
  > {
    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(eq(transactions.rivalExternalId, rivalExternalId))
      .limit(1);

    // The create/webhook race: Rival's first delivery can outrun the UPDATE
    // that stores the externalId. Answered as retryable — Rival's 60-second
    // backoff comfortably outruns the race, and the poller sits behind it.
    if (!tx) return 'unknown-reference';

    if (event === 'reversed') {
      await this.db
        .update(transactions)
        .set({
          rivalNeedsAttention: true,
          rivalAttentionReason:
            'The platform REVERSED this deposit after it settled. The client wallet has not ' +
            'been debited — a compensating entry is a human decision (§6.4). Reconcile ' +
            "against the platform's dashboard.",
        })
        .where(eq(transactions.id, tx.id));
      raiseAlert(
        this.logger,
        ALERT_KINDS.PAYMENT_STATE_MISMATCH,
        'page',
        'Rival reversed a deposit. The client wallet has NOT been debited — a compensating ' +
          'entry is a human decision. Reconcile the transaction against the Rival dashboard.',
        { transactionId: tx.id, rivalExternalId, state: tx.state },
      );
      this.announceDepositAttention(tx, 'reversed');
      return 'needs-attention';
    }

    if (tx.state === 'pending') {
      const { state } = await this.settleGatewayDeposit(tx.provider, tx.providerRef ?? '');
      return state === 'pending' ? 'pending' : 'applied';
    }

    if (event === 'completed') {
      if (tx.state === 'success') return 'duplicate';
      /*
       * PAID at Rival, terminal-not-success here. Never resurrected: a state
       * machine that can be argued backwards by an event replay is not a
       * state machine. Flagged for the reconciliation an operator does with
       * both dashboards open.
       */
      await this.db
        .update(transactions)
        .set({
          rivalNeedsAttention: true,
          rivalAttentionReason:
            'The platform reports this deposit PAID, but this side had already recorded it ' +
            'as failed. The money is at the platform and no wallet was credited — ' +
            'reconcile by hand.',
        })
        .where(eq(transactions.id, tx.id));
      raiseAlert(
        this.logger,
        ALERT_KINDS.PAYMENT_STATE_MISMATCH,
        'page',
        'Rival reports a deposit PAID against a CRM row that is terminally failed. The money ' +
          'is at Rival and no wallet was credited — reconcile by hand.',
        { transactionId: tx.id, rivalExternalId, state: tx.state },
      );
      this.announceDepositAttention(tx, 'paid_after_failure');
      return 'needs-attention';
    }

    // A `failed` event against a terminal row: at-least-once delivery echoing
    // history. Never regress a terminal state.
    return 'stale';
  }

  /**
   * Put a deposit only a person can settle in front of the people who can.
   *
   * The pager alert beside each call reaches whoever reads the alert channel
   * — on a deployment with no sink registered, nobody. This is the task on the
   * deposit desk's own bell, scoped to the client's territory like every task.
   * A reason CODE, not the sentence above: the frontends own the copy, and the
   * provider's wording never reaches a bell. Keyed per reason, so a replayed
   * webhook rings once, and resolved when somebody clears the flag ("Mark
   * resolved") or settles the row — migration 0140's trigger, not this code.
   * Post-write and never-throws, like every fan-out.
   */
  private announceDepositAttention(
    tx: { id: string; userId: number; amount: string; currency: string },
    reason: DepositAttentionReason,
  ): void {
    void this.notifications.notifyAdmins({
      kind: 'admin.deposit.attention',
      params: { transactionId: tx.id, amount: tx.amount, currency: tx.currency, reason },
      dedupeKey: `admin.deposit.attention:${tx.id}:${reason}`,
      subject: { id: tx.id, clientId: tx.userId },
    });
  }

  /**
   * The FR-CORE-07 outcome mail, looked up and sent AFTER the outcome is
   * committed. Never throws: the send itself is log-and-swallow inside
   * `EmailService`, and the user lookup here gets the same treatment — this
   * helper is `void`-dispatched, so a rejection would surface as an unhandled
   * rejection about a courtesy.
   */
  private async sendDepositOutcomeEmail(
    userId: number,
    outcome: 'succeeded' | 'failed' | 'rejected',
    amount: string,
    currency: string,
    reason?: string,
  ): Promise<void> {
    try {
      const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) return;
      await this.email.sendDepositOutcomeEmail(
        user.email,
        user.firstName,
        outcome,
        amount,
        currency,
        reason,
      );
    } catch (error) {
      this.logger.warn(
        `Could not send the deposit ${outcome} email for transaction owner ${userId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Deposit credit — the §8.3 callback path. Idempotent twice over: the
   * transaction row on UNIQUE(provider, provider_ref) and the ledger entry on
   * (wallet, reference). Used by the provider webhook when credentials land.
   */
  async creditDeposit(params: {
    userId: number;
    amount: string;
    currency: Currency;
    provider: string;
    providerRef: string;
  }) {
    const wallet = await this.wallets.getOrCreateWallet(params.userId, params.currency);
    const [tx] = await this.db
      .insert(transactions)
      .values({
        userId: params.userId,
        walletId: wallet.id,
        direction: 'deposit',
        amount: money(params.amount),
        currency: params.currency,
        state: 'success',
        provider: params.provider,
        providerRef: params.providerRef,
        settledAt: new Date(),
      })
      .onConflictDoNothing({ target: [transactions.provider, transactions.providerRef] })
      .returning();

    if (!tx) {
      // Replayed callback — the original transaction and credit stand.
      const [existing] = await this.db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.provider, params.provider),
            eq(transactions.providerRef, params.providerRef),
          ),
        )
        .limit(1);
      return { transaction: existing, replayed: true as const };
    }

    await this.wallets.post({
      userId: params.userId,
      currency: params.currency,
      amount: params.amount,
      entryType: 'deposit',
      referenceType: LEDGER_REFERENCE.transaction,
      referenceId: tx.id,
    });

    /*
     * NO COMMISSION IS ACCRUED HERE, and it must not be re-added as a share.
     *
     * A deposit is not revenue. The money still belongs to the client and is a
     * liability against it, so paying a partner a percentage handed them the
     * BROKER's funds — $700 on a $1,000 deposit at 70%, while the client kept
     * the right to withdraw all $1,000. Unbounded, and it scaled with volume.
     *
     * Partners are paid on CLOSED POSITIONS, from the broker’s own earning on
     * the trade. See `CommissionService.accrueForClosedPosition`.
     */

    return { transaction: tx, replayed: false as const };
    // NOTE: kept as two steps deliberately — the credit is idempotent on
    // (wallet, 'transaction', id) and the transaction row is idempotent on
    // (provider, provider_ref), so a retry of the whole call converges. See
    // creditDepositAtomic() below for the transactional variant used by the
    // provider webhook once one exists.
  }
}

/**
 * A short reference a human can read down a phone line and type into a bank
 * form.
 *
 * Crockford's base32 — no I, L, O or U — because this string is transcribed by
 * people: `0`/`O` and `1`/`I` are the transcription errors that turn a
 * reconciled payment into a support ticket, and U is dropped so the alphabet
 * cannot spell anything unfortunate.
 *
 * Six characters is ~1.07 billion values. It is NOT a secret and does not need
 * to be — quoting somebody else's reference on your own transfer credits THEIR
 * declaration with YOUR money, which is a strange attack to mount. Collisions
 * are what matter, and the UNIQUE(provider, provider_ref) index turns one into
 * a failed insert rather than two clients sharing a reference.
 */
function depositReference(): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(6);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `OX-${out}`;
}
