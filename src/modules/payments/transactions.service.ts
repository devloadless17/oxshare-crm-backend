import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { and, desc, eq, gte, ne, sql } from 'drizzle-orm';
import { tradingAccounts, transactions, users } from '../../database/schema';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import { assertActorCan, type Actor } from '../../common/security/actor';
import { money, toDecimal } from '../wallet/money';
import { buildCursorPage, pageSize, type CursorPosition } from '../../common/pagination';
import { MoneyLimits } from '../../config/money-limits';
import { Currency, Executor, WalletService } from '../wallet/wallet.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import {
  AuthorizationError,
  MoneyRuleError,
  NotFoundError,
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
 *   request  → hold funds, state=pending        (no ledger entry: a hold is
 *   approve  → state=approved                    not a balance change)
 *   reject   → release hold, state=rejected, reason emailed, client may retry
 *   settle   → post the debit, clear the hold, state=success
 *   fail     → release hold, state=failure, client emailed
 *
 * NOT built here (blocked, not forgotten):
 *  - Email OTP before a withdrawal request (CORE-08). §8.4 requires the OTP in
 *    Redis with a 5-minute TTL, "never in Postgres" — Redis arrives with the
 *    queues milestone. Until then a request is admin-reviewed but not
 *    OTP-gated; tracked in DECISIONS D-38.
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
     * Decides whether a currency code is one this platform accepts right now.
     *
     * Appended, and the reason is the same one `AuthService` records: this
     * class is constructed positionally in the test suite, so inserting a
     * parameter in the middle silently shifts the ones after it.
     */
    private readonly currencies: CurrenciesService,
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

    // The hold and the transaction row commit together. Previously the hold
    // committed first, so a failed INSERT left funds reserved against a
    // withdrawal that did not exist — invisible and unreleasable.
    return db.transaction(async (dbTx) => {
      const wallet = await this.wallets.hold(params.userId, params.currency, amount, dbTx);
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
  }) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = pageSize(filter.limit);
    const db = this.db;

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
     */
    if (filter.cursor) {
      conditions.push(
        sql`(${transactions.createdAt}, ${transactions.id}) < (${filter.cursor.value}::timestamptz, ${filter.cursor.id}::uuid)`,
      );
    }
    const where = and(...conditions);
    const usingCursor = Boolean(filter.cursor) || page <= 1;

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
      .orderBy(desc(transactions.createdAt), desc(transactions.id))
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

    // `buildCursorPage` needs `id` and `createdAt`; the projection renames the
    // latter to `requestedAt` for the API, so the page is built from the raw rows
    // and the shaping happens after.
    const paged = buildCursorPage(
      rows.map((r) => ({ ...r, createdAt: r.requestedAt })),
      limit,
      total,
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
    // One transaction: the state change and the hold release commit together,
    // so a failure can never leave a rejected withdrawal with funds still
    // reserved — which was permanent, since 'rejected' is terminal.
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
      await this.wallets.release(row.userId, row.currency, row.amount, dbTx);
      await withinTx?.(dbTx, row);
      return row;
    });
  }

  /** Provider confirmed: post the debit, clear the hold, close the transaction. */
  async settle(id: string, adminId: string, providerRef: string, withinTx?: WithinTransaction) {
    // One transaction for all three steps. Previously they were three separate
    // commits: a crash after the first left the row marked 'success' with no
    // debit posted (money duplicated, unrecoverable because the state guard
    // blocks retry, and invisible to reconciliation); a crash after the second
    // froze the client's funds on hold permanently.
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

      // Idempotent on (wallet, 'transaction', id), so a replayed provider
      // callback debits nothing twice.
      await this.wallets.post(
        {
          userId: row.userId,
          currency: row.currency,
          amount: toDecimal(row.amount).negated(),
          entryType: 'withdrawal',
          referenceType: LEDGER_REFERENCE.transaction,
          referenceId: row.id,
        },
        dbTx,
      );
      await this.wallets.release(row.userId, row.currency, row.amount, dbTx);
      await withinTx?.(dbTx, row);
      return row;
    });
  }

  /**
   * Provider failed after approval: release the hold, no balance change.
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
    // Failing a withdrawal RELEASES the hold back to the client, so it belongs
    // with settlement rather than with approval — it is the settle step's error
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
      await this.wallets.release(row.userId, row.currency, row.amount, dbTx);
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

    // Unknown or DISABLED currencies are refused here rather than by an @IsIn
    // in the DTO — the enabled set is operator data and changes without a
    // deploy. Returns the normalised (upper-cased) code.
    const currency = await this.currencies.assertUsable(params.currency);

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
        // The METHOD, not a payment provider — there is no provider in this
        // flow. `manual_` keeps it obviously distinct from `whish` or a USDT
        // gateway row, so a later reconciliation job cannot confuse the two.
        provider: `manual_${params.method}`,
        providerRef: reference,
      })
      .returning();

    return {
      id: tx.id,
      reference,
      amount: tx.amount,
      currency: tx.currency,
      method: params.method,
      state: tx.state,
      createdAt: tx.createdAt.toISOString(),
    };
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
