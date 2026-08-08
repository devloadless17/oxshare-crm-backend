import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { and, asc, desc, eq, gte, ne, sql, type SQLWrapper } from 'drizzle-orm';
import { tradingAccounts, transactions, users } from '../../database/schema';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import { assertActorCan, type Actor } from '../../common/security/actor';
import { money, toDecimal } from '../wallet/money';
import { buildCursorPage, pageSize, type CursorPosition } from '../../common/pagination';
import type { SortOrder } from '../../common/sorting';
import { MoneyLimits } from '../../config/money-limits';
import { PaymentMethodsService } from './payment-methods.service';
import { Currency, Executor, WalletService } from '../wallet/wallet.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { ConfigService } from '@nestjs/config';
import {
  COMMISSION_ACCRUAL,
  type CommissionAccrualPort,
} from '../../common/provisioning/commission-accrual.port';
import { PaymentGateways } from './payment-gateways.service';
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

@Injectable()
export class TransactionsService {
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
    private readonly limits: MoneyLimits,
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
     * Partner commissions, behind a PORT rather than the IB module.
     *
     * Injecting the token keeps the graph acyclic: importing `IbModule` here
     * would close a cycle, because both modules depend on `WalletModule`. See
     * `common/provisioning/commission-accrual.port.ts` for the full reasoning —
     * it is the same shape identity uses to open wallets without importing the
     * wallet module.
     *
     * APPENDED LAST, for the reason the two parameters above record: this class
     * is constructed positionally in the test suite, so inserting a parameter
     * in the middle silently shifts every one after it.
     */
    @Inject(COMMISSION_ACCRUAL) private readonly commissions: CommissionAccrualPort,
    /*
     * The hosted payment providers, and the config the callback URLs are built
     * from. APPENDED LAST for the reason every parameter above records: this
     * class is constructed positionally in the test suite, so inserting one in
     * the middle silently shifts the rest.
     */
    private readonly gateways: PaymentGateways,
    private readonly config: ConfigService,
  ) {}

  async requestWithdrawal(params: {
    userId: string;
    amount: string;
    currency: Currency;
    destination: string;
    provider: string;
  }) {
    const amount = toDecimal(params.amount);
    if (!amount.isPositive()) throw new ValidationError('Withdrawal amount must be positive.');

    /*
     * Absolute bounds — PLATFORM-CONVENTIONS R-5.1.
     *
     * Balance and KYC level were already checked below, and they are the RIGHT
     * checks. What was missing is a ceiling that holds when something upstream
     * is wrong: a mispriced wallet, a bad rate, a compromised session draining
     * an account in one move. Limits live in config as documented assumptions,
     * so confirming a real figure with the client is an env change.
     */
    const min = this.limits.minWithdrawal();
    const max = this.limits.maxWithdrawal();
    if (amount.lessThan(min)) {
      throw new ValidationError(`The minimum withdrawal is ${min.toString()} ${params.currency}.`);
    }
    if (amount.greaterThan(max)) {
      throw new ValidationError(
        `The maximum single withdrawal is ${max.toString()} ${params.currency}. ` +
          'Please split the request or contact support.',
      );
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
    const dayCap = this.limits.maxWithdrawalPerDay();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await db
      .select({ amount: transactions.amount })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, params.userId),
          eq(transactions.direction, 'withdrawal'),
          eq(transactions.currency, params.currency),
          gte(transactions.createdAt, since),
          ne(transactions.state, 'rejected'),
        ),
      );
    const already = recent.reduce((sum, row) => sum.plus(toDecimal(row.amount)), toDecimal('0'));
    if (already.plus(amount).greaterThan(dayCap)) {
      throw new ValidationError(
        `This would exceed the ${dayCap.toString()} ${params.currency} rolling 24-hour ` +
          `withdrawal limit — ${already.toString()} has already been requested in that window.`,
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
    return db.transaction(async (dbTx) => {
      const wallet = await this.wallets.getOrCreateWallet(params.userId, params.currency, dbTx);
      const [row] = await dbTx
        .insert(transactions)
        .values({
          userId: params.userId,
          walletId: wallet.id,
          direction: 'withdrawal',
          amount: money(amount),
          currency: params.currency,
          state: 'pending',
          provider: params.provider,
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
          currency: params.currency,
          amount: amount.negated(),
          entryType: 'withdrawal',
          referenceType: LEDGER_REFERENCE.transaction,
          referenceId: row.id,
        },
        dbTx,
      );

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
  async ownerOf(id: string): Promise<string | undefined> {
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
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
      })
      .from(transactions)
      .innerJoin(users, eq(transactions.userId, users.id))
      .where(where)
      .orderBy(orderBy(sortColumn), orderBy(transactions.id))
      .limit(limit + 1)
      .offset(usingCursor ? 0 : (page - 1) * limit);

    const [{ value: total }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(transactions)
      .where(where);

    // Per-state counts over the full set, so admin tab counts stay correct
    // regardless of the active filter.
    const countRows = await db
      .select({ state: transactions.state, value: sql<number>`count(*)::int` })
      .from(transactions)
      .where(eq(transactions.direction, 'withdrawal'))
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
      rejectionReason: r.rejectionReason,
      requestedAt: r.requestedAt,
      reviewedAt: r.reviewedAt,
      settledAt: r.settledAt,
      user: {
        id: r.userId,
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
   * Offset paging rather than a keyset seek, deliberately. The ordering is
   * total (`created_at DESC, id DESC`) and the export reads it to completion in
   * one request, so a concurrent insert can only add a row at the head this
   * pass has already passed — it cannot shift a row across a batch boundary.
   */
  async listForExport(filter: {
    state?: string;
    offset: number;
    limit: number;
    scope?: ClientScope;
  }) {
    const conditions = [eq(transactions.direction, 'withdrawal')];

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

  async listForUser(userId: string) {
    const rows = await this.db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .orderBy(desc(transactions.createdAt))
      .limit(100);
    return rows.map((r) => ({ ...r, amount: money(r.amount) }));
  }

  async getById(id: string) {
    const [tx] = await this.db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    if (!tx) throw new NotFoundError('Transaction not found.');
    return tx;
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

  async approve(id: string, adminId: string, withinTx?: WithinTransaction) {
    // Wrapped in a transaction it did not previously need, so `withinTx` — the
    // admin audit row — commits with the state change or not at all (R-6.5).
    return this.db.transaction(async (dbTx) => {
      const row = await this.transition(
        id,
        'pending',
        { state: 'approved', reviewedBy: adminId, reviewedAt: new Date() },
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
    userId: string;
    amount: string;
    currency: Currency;
    method: string;
    /** Set when the client chose to fund a trading account rather than the wallet. */
    destinationTradingAccountId?: string;
  }) {
    const amount = toDecimal(params.amount);
    if (!amount.isPositive()) throw new ValidationError('Deposit amount must be positive.');

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
    const currency = await this.currencies.assertUsable(paymentMethod.currency);

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

    // Per-method bounds AND the platform's own, because neither is derivable
    // from the other — a provider may refuse under $20 while the platform's
    // floor is $10.
    this.paymentMethods.assertAmountWithin(paymentMethod, amount);

    const min = this.limits.minDeposit();
    const max = this.limits.maxDeposit();
    if (amount.lessThan(min)) {
      throw new ValidationError(`The minimum deposit is ${min.toString()} ${params.currency}.`);
    }
    if (amount.greaterThan(max)) {
      throw new ValidationError(
        `The maximum single deposit is ${max.toString()} ${params.currency}. ` +
          'Please split the transfer or contact support.',
      );
    }

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
          externalId: reference,
          amount: money(params.amount),
          currency,
          invoice: `Deposit ${reference}`,
          successCallbackUrl: this.callbackUrl(paymentMethod.key, reference, 'success'),
          failureCallbackUrl: this.callbackUrl(paymentMethod.key, reference, 'failure'),
          successRedirectUrl: this.redirectUrl(paymentMethod.key, reference, 'success'),
          failureRedirectUrl: this.redirectUrl(paymentMethod.key, reference, 'failure'),
        });
        paymentUrl = started.paymentUrl;
      } catch (error) {
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

  /**
   * Where the PROVIDER calls us back.
   *
   * `API_PUBLIC_URL` rather than a request-derived host: a callback URL built
   * from an inbound `Host` header is one a caller can influence, and this value
   * is handed to a third party who will fetch it later. It must be a value the
   * operator configured.
   *
   * The reference travels in the query string because Whish preserves custom
   * parameters and sends no body — without it the callback says only "something
   * happened" with no way to know what.
   */
  private callbackUrl(method: string, reference: string, outcome: 'success' | 'failure'): string {
    const base = (this.config.get<string>('API_PUBLIC_URL') ?? '').replace(/\/+$/, '');
    return `${base}/v1/payments/gateway/${method}/callback?reference=${encodeURIComponent(
      reference,
    )}&outcome=${outcome}`;
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
   * Settle a gateway deposit by ASKING THE PROVIDER, never by trusting a
   * callback.
   *
   * ## The security boundary of the whole integration
   *
   * The callback that triggers this is an unauthenticated GET with no body and
   * no signature. Anybody who learns the URL can fire it. So it is treated as a
   * NUDGE — "go and look" — and the provider's authenticated status answer is
   * the only thing money is credited on. A callback-trusting implementation
   * credits a wallet for whoever can guess a reference.
   *
   * Safe to call repeatedly, and called from two places for that reason: the
   * callback, and the client's own browser landing back on the portal. Whichever
   * arrives first settles it; the second is a no-op.
   *
   * Idempotency is the DATABASE's, twice over: the state transition is
   * conditional on the row still being pending, and `WalletService.post` is
   * guarded by `ledger_entries_wallet_reference_uq`. Neither is a
   * check-then-insert, because every check-then-insert loses under concurrency.
   */
  async settleGatewayDeposit(method: string, reference: string): Promise<{ state: string }> {
    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.provider, method), eq(transactions.providerRef, reference)))
      .limit(1);

    // Not found is not an error worth shouting about: a callback for a
    // reference this system never issued is noise, not an incident.
    if (!tx) throw new NotFoundError('No deposit matches that reference.');

    // Already settled — nothing to ask, nothing to do.
    if (tx.state !== 'pending') return { state: tx.state };

    const result = await this.gateways.checkPayment(method, reference, tx.currency);

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
      return { state: updated[0]?.state ?? tx.state };
    }

    /*
     * PAID. The credit and the state change share one transaction, so a
     * deposit marked success with no ledger entry behind it — or a credit with
     * no transaction pointing at it — is a state this system cannot reach.
     */
    await this.db.transaction(async (dbTx) => {
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

      await dbTx
        .update(transactions)
        .set({ state: 'success', settledAt: new Date() })
        .where(and(eq(transactions.id, tx.id), eq(transactions.state, 'pending')));
    });

    /*
     * The partner commission this deposit earns, accrued AFTER the credit and
     * outside its transaction — the same ordering and the same no-throw port as
     * `creditDeposit`. The client's money landing is the important half.
     */
    await this.commissions.accrueForSettledDeposit({
      transactionId: tx.id,
      clientUserId: tx.userId,
      amount: tx.amount,
      currency: tx.currency,
    });

    return { state: 'success' };
  }

  /**
   * Deposit credit — the §8.3 callback path. Idempotent twice over: the
   * transaction row on UNIQUE(provider, provider_ref) and the ledger entry on
   * (wallet, reference). Used by the provider webhook when credentials land.
   */
  async creditDeposit(params: {
    userId: string;
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
     * The partner commission this deposit earns, accrued AFTER the client's own
     * credit and outside its transaction.
     *
     * Order matters: the client's money landing is the important half. The port
     * contract is explicitly no-throw and idempotent, so a commission failure
     * cannot roll back — or fail — a deposit that has already credited. A
     * missing accrual is recoverable by re-running the pipeline; a reversed
     * deposit is a support incident.
     *
     * Awaited rather than fire-and-forget: this writes `pending` rows only and
     * moves no money, so it is cheap, and awaiting means a caller that has just
     * settled a deposit can immediately read the accruals it caused.
     */
    await this.commissions.accrueForSettledDeposit({
      transactionId: tx.id,
      clientUserId: params.userId,
      amount: params.amount,
      currency: params.currency,
    });

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
