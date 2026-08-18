import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../database/db';
import {
  ledgerEntries,
  transactions,
  transfers,
  walletKindEnum,
  wallets,
} from '../../database/schema';
import { available, money, MoneyInput, toDecimal } from './money';
import {
  ConflictError,
  MoneyRuleError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DRIZZLE_DB } from '../../database/database.module';
import { buildCursorPage, pageSize, type CursorPosition } from '../../common/pagination';
import {
  clientScopePredicate,
  UNRESTRICTED,
  type ClientScope,
} from '../../common/security/client-scope';

/**
 * A database handle: either the pool or an open transaction.
 *
 * Every money method accepts one. Passing a transaction lets a CALLER compose
 * several money operations atomically — which is what `settle()` and
 * `confirmMatured()` need. Omitting it keeps the single-operation behaviour,
 * where the method opens its own transaction.
 *
 * Derived from Drizzle's own signature rather than hand-written, so it cannot
 * drift from the driver.
 */
type Db = ReturnType<typeof getDb>;
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * A currency CODE — 'USD', 'USDT', or whatever the operator has added.
 *
 * This was the union `'USD' | 'USDT'`, and it stopped being one when currencies
 * became operator data in a table (see `currencies` in schema.ts). A union
 * cannot express a set the database owns at runtime, and pretending otherwise
 * would mean every new currency needs a code change — which is the exact thing
 * moving them into a table was meant to end.
 *
 * WHAT WAS LOST, stated plainly: the compiler no longer catches
 * `getOrCreateWallet(id, 'USDD')`. That check has moved to runtime, where the
 * answer actually lives — `CurrenciesService.assertUsable()` refuses an unknown
 * or disabled code, and the `wallets_currency_currencies_code_fk` foreign key
 * refuses it again at the database if a caller ever skips the service. Two
 * runtime gates on the write path is a stronger guarantee than one compile-time
 * gate over a hardcoded list that was wrong the day the operator added EUR.
 *
 * Aliased rather than written as bare `string` so the intent stays greppable
 * and the signatures still read as money code.
 */
export type Currency = string;
export type LedgerEntryType =
  | 'deposit'
  | 'withdrawal'
  | 'commission'
  | 'rebate'
  | 'payout'
  | 'adjustment'
  // Wallet <-> MT5 trading account; see the `transfers` table. Its own type so
  // reports that sum the ledger by type do not count an internal move as a
  // deposit AND a withdrawal.
  | 'transfer';

/**
 * WHICH of a client's wallets in a currency — see `walletKindEnum` in schema.ts.
 *
 * Re-exported from the schema rather than restated as a literal union, so the
 * two cannot drift: adding a kind to the enum makes every exhaustive read of
 * this type a compile error instead of a branch that silently never runs.
 */
export type WalletKind = (typeof walletKindEnum.enumValues)[number];

/**
 * The default EVERYWHERE, and it is load-bearing rather than a convenience.
 *
 * Deposits, withdrawals, holds and trading-account transfers all resolve the
 * main wallet, and none of them takes a kind — so a caller cannot aim any of
 * those rails at a commission wallet even by mistake. A commission wallet is
 * reached only by naming it, which two places do: the commission confirm loop
 * and `IbWalletService`.
 */
const DEFAULT_KIND: WalletKind = 'main';

export interface PostParams {
  userId: string;
  currency: Currency;
  /** Which wallet in that currency. Defaults to `main` — see DEFAULT_KIND. */
  kind?: WalletKind;
  /** Signed: positive credits, negative debits. String or Decimal — never a number. */
  amount: MoneyInput;
  entryType: LedgerEntryType;
  /** What caused this movement, e.g. 'transaction' / 'deal' / 'payout'. */
  referenceType: string;
  referenceId: string;
  /** Debits normally cannot overdraw; corrections may (compensating entries). */
  allowOverdraft?: boolean;
}

/**
 * The money primitive. Every balance change in the system goes through post().
 *
 * ARCHITECTURE §6.2 — the ledger write, verbatim:
 *
 *   BEGIN
 *     SELECT * FROM wallets WHERE id = ? FOR UPDATE
 *     compute new balance
 *     INSERT INTO ledger_entries (..., balance_after)
 *     UPDATE wallets SET balance = ?
 *   COMMIT
 *
 * Why the lock: `balance_after` is a running balance. Two concurrent credits
 * without the lock both read the same prior balance and one write is lost —
 * "the single most likely money bug in the system".
 *
 * Why ON CONFLICT: idempotency lives in the database (§6.3). A replayed cause
 * (same wallet + reference) is a no-op that returns the original entry and
 * leaves the balance untouched — never a second credit.
 */
@Injectable()
export class WalletService {
  /**
   * The db is injected, not fetched from the module-level singleton.
   *
   * `this.db` and the DRIZZLE_DB provider return the *same* lazy instance
   * (see database.module.ts), so this is behaviour-identical — but a declared
   * dependency can be seen, and reaching for a global from inside a money method
   * could not. `executor ?? this.db` still lets a caller pass a transaction
   * handle so a method joins their transaction (§6.2).
   */
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /** Create-if-absent without locking. Callers that will move money should use
   *  post()/hold()/release(), which lock as part of their transaction.
   *
   *  `kind` sits BEFORE `executor` deliberately. Appending it instead would have
   *  left every existing call site compiling untouched — including the four that
   *  pass a transaction — and a money path that keeps compiling silently is
   *  exactly the one you want the compiler to make you look at when its meaning
   *  changes. */
  async getOrCreateWallet(
    userId: string,
    currency: Currency,
    kind: WalletKind = DEFAULT_KIND,
    executor?: Executor,
  ) {
    const db = executor ?? this.db;
    await db
      .insert(wallets)
      .values({ userId, currency, kind })
      /* The conflict target must MATCH `wallets_user_currency_kind_uq` exactly.
         A target naming no unique index fails at RUNTIME, not at compile time —
         on the path that opens a client's wallet. */
      .onConflictDoNothing({ target: [wallets.userId, wallets.currency, wallets.kind] });
    const [wallet] = await db
      .select()
      .from(wallets)
      .where(
        and(eq(wallets.userId, userId), eq(wallets.currency, currency), eq(wallets.kind, kind)),
      )
      .limit(1);
    return wallet;
  }

  async post(params: PostParams, executor?: Executor) {
    // With a caller-supplied transaction we join it; without one we open our
    // own. Either way the lock, the ledger insert and the balance update share
    // a single atomic scope.
    if (executor) return this.postWithin(executor, params);
    return this.db.transaction((tx) => this.postWithin(tx, params));
  }

  private async postWithin(tx: Executor, params: PostParams) {
    const { userId, currency, entryType, referenceType, referenceId } = params;
    const kind = params.kind ?? DEFAULT_KIND;
    const amount = toDecimal(params.amount);
    if (amount.isZero()) {
      throw new ValidationError('A ledger entry must move a non-zero amount.');
    }

    // 1. Ensure the wallet exists and lock it — both inside this transaction,
    //    so creation and the lock cannot be separated by a concurrent writer.
    const wallet = await this.lockWallet(tx, userId, currency, kind);

    // 2. Compute the new balance with decimal.js — never bare arithmetic.
    const newBalance = toDecimal(wallet.balance).plus(amount);
    if (newBalance.isNegative() && !params.allowOverdraft) {
      throw new MoneyRuleError(
        `Insufficient balance: ${money(wallet.balance)} ${currency} cannot absorb ${money(amount)}.`,
      );
    }

    // 3. Append the ledger entry. A conflict means this cause already posted.
    const [entry] = await tx
      .insert(ledgerEntries)
      .values({
        walletId: wallet.id,
        amount: money(amount),
        balanceAfter: money(newBalance),
        entryType,
        referenceType,
        referenceId,
      })
      .onConflictDoNothing({
        target: [ledgerEntries.walletId, ledgerEntries.referenceType, ledgerEntries.referenceId],
      })
      .returning();

    if (!entry) {
      // Idempotent replay: return the original entry, balance untouched.
      const [existing] = await tx
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.walletId, wallet.id),
            eq(ledgerEntries.referenceType, referenceType),
            eq(ledgerEntries.referenceId, referenceId),
          ),
        )
        .limit(1);
      return { entry: existing, wallet, replayed: true as const };
    }

    // 4. Move the wallet to the balance this entry recorded.
    const [updated] = await tx
      .update(wallets)
      .set({ balance: money(newBalance) })
      .where(eq(wallets.id, wallet.id))
      .returning();

    return { entry, wallet: updated, replayed: false as const };
  }

  /**
   * Create-if-absent and lock, in one scope. Previously wallet creation ran
   * before the transaction opened and the locked SELECT was destructured
   * without a null check — a missing row crashed with a TypeError mid-payment.
   */
  private async lockWallet(
    tx: Executor,
    userId: string,
    currency: Currency,
    kind: WalletKind = DEFAULT_KIND,
  ) {
    await tx
      .insert(wallets)
      .values({ userId, currency, kind })
      .onConflictDoNothing({ target: [wallets.userId, wallets.currency, wallets.kind] });

    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(
        and(eq(wallets.userId, userId), eq(wallets.currency, currency), eq(wallets.kind, kind)),
      )
      .for('update')
      .limit(1);

    if (!wallet) {
      // Not a money rule and not the caller's fault: the upsert above just ran,
      // so an absent row means the database is in a state we do not understand.
      // A plain Error becomes a 500 with the stack logged and nothing leaked.
      throw new Error(
        `The ${kind} ${currency} wallet for user ${userId} could not be created or locked.`,
      );
    }
    return wallet;
  }

  /**
   * Reserve funds without moving the balance (§8.4 withdrawal, §8.7 payout).
   * on_hold is not a balance change, so it writes no ledger entry — the debit
   * is posted only when the provider confirms.
   */
  async hold(userId: string, currency: Currency, amount: MoneyInput, executor?: Executor) {
    const value = toDecimal(amount);
    if (!value.isPositive()) throw new ValidationError('Hold amount must be positive.');
    if (executor) return this.holdWithin(executor, userId, currency, value);
    return this.db.transaction((tx) => this.holdWithin(tx, userId, currency, value));
  }

  private async holdWithin(tx: Executor, userId: string, currency: Currency, value: Decimal) {
    {
      const wallet = await this.lockWallet(tx, userId, currency);

      const availableNow = toDecimal(available(wallet.balance, wallet.onHold));
      if (availableNow.lessThan(value)) {
        throw new MoneyRuleError(
          `Insufficient available balance: ${money(availableNow)} ${currency} available, ${money(value)} requested.`,
        );
      }

      const [updated] = await tx
        .update(wallets)
        .set({ onHold: money(toDecimal(wallet.onHold).plus(value)) })
        .where(eq(wallets.id, wallet.id))
        .returning();
      return updated;
    }
  }

  /** Release a hold — on rejection, or after the matching debit is posted. */
  async release(userId: string, currency: Currency, amount: MoneyInput, executor?: Executor) {
    const value = toDecimal(amount);
    if (executor) return this.releaseWithin(executor, userId, currency, value);
    return this.db.transaction((tx) => this.releaseWithin(tx, userId, currency, value));
  }

  private async releaseWithin(tx: Executor, userId: string, currency: Currency, value: Decimal) {
    {
      const wallet = await this.lockWallet(tx, userId, currency);

      // Never let on_hold go negative, whatever the caller asks for.
      const remaining = toDecimal(wallet.onHold).minus(value);
      const [updated] = await tx
        .update(wallets)
        .set({ onHold: money(remaining.isNegative() ? '0' : remaining) })
        .where(eq(wallets.id, wallet.id))
        .returning();
      return updated;
    }
  }

  /**
   * A client's wallets of ONE kind, `main` unless asked otherwise.
   *
   * Filtered SERVER-SIDE rather than returned whole for the caller to sift.
   * `GET /wallet` is what the portal's wallet screen, the deposit screen and the
   * withdraw screen all read, and none of them may offer a commission wallet as
   * a source — a commission balance leaves through `POST /ib/wallet/transfer`
   * and nowhere else. Making that a filter in one UI would leave the other two
   * to remember it; making it the shape of the response means they cannot get
   * it wrong.
   */
  async listWallets(userId: string, kind: WalletKind = DEFAULT_KIND) {
    const rows = await this.db
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.kind, kind)));
    return rows.map((w) => ({
      ...w,
      balance: money(w.balance),
      onHold: money(w.onHold),
      available: available(w.balance, w.onHold),
    }));
  }

  /** One wallet by id, or undefined. For the admin lifecycle methods below. */
  async findById(id: string) {
    const [row] = await this.db.select().from(wallets).where(eq(wallets.id, id)).limit(1);
    return row;
  }

  /**
   * Close an EMPTY, UNUSED wallet.
   *
   * ## ⚠️ Four refusals, and each one is a different mistake
   *
   * A wallet is not a row an operator should be able to make disappear. It is
   * the anchor every ledger entry and every transaction for that currency points
   * at, so the checks below are ordered by how expensive the mistake would be:
   *
   *  1. NOT FOUND — nothing to do, said plainly rather than as a silent success.
   *  2. A BALANCE — deleting this would be deleting the client's money. The
   *     message names the figure, because "cannot delete" without it invites the
   *     operator to try again rather than to go and look.
   *  3. FUNDS ON HOLD — the balance can read zero while a transfer is in flight
   *     against it. Checked separately for that reason: a wallet with 0 balance
   *     and 200 held is not an empty wallet, and treating it as one would strand
   *     the transfer's release with nowhere to land.
   *  4. HISTORY — any ledger entry, transaction or transfer. The three foreign
   *     keys are RESTRICT, so the database refuses this anyway; doing it here
   *     turns a driver-level constraint error into a sentence that says which
   *     kind of history exists and how much of it.
   *
   * What survives all four is a wallet that was opened and never used — which is
   * the only wallet whose deletion loses nothing.
   */
  async deleteEmptyWallet(id: string): Promise<void> {
    const wallet = await this.findById(id);
    if (!wallet) throw new NotFoundError('Wallet not found.');

    if (!toDecimal(wallet.balance).isZero()) {
      throw new ConflictError(
        `This wallet holds ${money(wallet.balance)} ${wallet.currency}. Move the balance out before closing it.`,
      );
    }
    if (!toDecimal(wallet.onHold).isZero()) {
      throw new ConflictError(
        `This wallet has ${money(wallet.onHold)} ${wallet.currency} on hold against a pending transfer. It cannot be closed until that settles.`,
      );
    }

    /*
     * One query per referencing table rather than a join: they are three
     * independent reasons, and the operator is told WHICH one applies. A single
     * "it has history" would leave them guessing where to look.
     */
    const [entries, txs, moves] = await Promise.all([
      this.db.select({ n: count() }).from(ledgerEntries).where(eq(ledgerEntries.walletId, id)),
      this.db.select({ n: count() }).from(transactions).where(eq(transactions.walletId, id)),
      this.db.select({ n: count() }).from(transfers).where(eq(transfers.walletId, id)),
    ]);
    const history = (entries[0]?.n ?? 0) + (txs[0]?.n ?? 0) + (moves[0]?.n ?? 0);
    if (history > 0) {
      throw new ConflictError(
        `This wallet has ${history} historical record(s) against it and cannot be deleted. A wallet is the anchor its ledger entries point at; closing it would orphan them.`,
      );
    }

    await this.db.delete(wallets).where(eq(wallets.id, id));
  }

  /** ADM-13 ledger view — filterable for reconciliation. */
  async listEntries(filter: {
    walletId?: string;
    userId?: string;
    entryType?: LedgerEntryType;
    /** Row-level visibility. Admin callers pass the actor's; defaults to open. */
    scope?: ClientScope;
    page?: number;
    /**
     * Accepts the raw query string as well as a number: `pageSize()` already
     * clamps either, so a caller that has a string has no reason to parse it
     * first. Parsing at the edge is how a caller ends up writing
     * `parseInt(x) || 50`, which turns a typo into a silently different page
     * size instead of a clamped one.
     */
    limit?: string | number;
    /** Keyset position — R-2.4. When present, `page` is ignored. */
    cursor?: CursorPosition;
  }) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = pageSize(filter.limit);
    const db = this.db;

    const conditions = [];
    if (filter.walletId) conditions.push(eq(ledgerEntries.walletId, filter.walletId));
    if (filter.entryType) conditions.push(eq(ledgerEntries.entryType, filter.entryType));
    if (filter.userId) conditions.push(eq(wallets.userId, filter.userId));

    // In the WHERE clause. The ADM-13 ledger is the screen used FOR
    // reconciliation, so a row silently excluded after the fact would be worse
    // here than almost anywhere — the predicate goes into the query itself.
    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, wallets.userId);
    if (scoped) conditions.push(scoped);
    /*
     * Keyset seek — R-2.4. The ledger is append-only and never stops growing, so
     * it reaches OFFSET depth faster than any other list here. It is also the
     * one used FOR reconciliation (ADM-13): a page that silently skips an entry
     * while new ones are written is a reconciliation that balances against the
     * wrong set of rows.
     */
    if (filter.cursor) {
      conditions.push(
        sql`(${ledgerEntries.createdAt}, ${ledgerEntries.id}) < (${filter.cursor.value}::timestamptz, ${filter.cursor.id}::uuid)`,
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const usingCursor = Boolean(filter.cursor) || page <= 1;

    const rows = await db
      .select({
        id: ledgerEntries.id,
        walletId: ledgerEntries.walletId,
        amount: ledgerEntries.amount,
        balanceAfter: ledgerEntries.balanceAfter,
        entryType: ledgerEntries.entryType,
        referenceType: ledgerEntries.referenceType,
        referenceId: ledgerEntries.referenceId,
        createdAt: ledgerEntries.createdAt,
        currency: wallets.currency,
        userId: wallets.userId,
      })
      .from(ledgerEntries)
      .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
      .where(where)
      .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
      .limit(limit + 1)
      .offset(usingCursor ? 0 : (page - 1) * limit);

    const [{ value: total }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(ledgerEntries)
      .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
      .where(where);

    return { ...buildCursorPage(rows, limit, total), page, limit };
  }

  /**
   * §11 reconciliation: the sum of a wallet's ledger entries must equal its
   * balance, to the cent. Exposed so the admin ledger view and CI can both
   * assert it.
   */
  async reconcile(walletId: string) {
    const db = this.db;
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, walletId)).limit(1);
    // An unknown id used to reach `money(wallet.balance)` and throw a TypeError,
    // which the filter answers as a 500 with a stack in the log — a caller's
    // typo reported as a server fault. lockWallet() a few lines up already
    // handles exactly this case correctly.
    if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found.`);
    const [{ total }] = await db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, walletId));

    const balance = money(wallet.balance);
    const ledgerSum = money(total);
    return { walletId, balance, ledgerSum, balanced: balance === ledgerSum };
  }
}
