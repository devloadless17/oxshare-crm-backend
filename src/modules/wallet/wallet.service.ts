import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, count, desc, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { getDb } from '../../database/db';
import {
  currencies,
  ledgerEntries,
  transactions,
  transfers,
  users,
  walletKindEnum,
  wallets,
} from '../../database/schema';
import { available, money, MoneyInput, toDecimal } from './money';
import { displayMoney } from '../../common/money-display';
import { clientIdentitySearch } from '../../store/users.store';
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
    /*
     * THE DATABASE OWNS THIS RULE — this check only reports it in time.
     *
     * `PostParams` carried an `allowOverdraft?: boolean` until 11 Sep 2026,
     * honoured right here: it skipped this refusal, and it read exactly like
     * the supported way to permit a negative balance. Its docblock even named
     * a use — "corrections may (compensating entries)".
     *
     * It could never work. `wallets_balance_non_negative` is a CHECK CONSTRAINT
     * (`CHECK (balance >= 0)`), unconditional and on every row, so the UPDATE at
     * the end of this method is refused by Postgres whatever the flag said. The
     * flag therefore did not grant an overdraft — it replaced this clean, mapped
     * `MoneyRuleError` with a raw `DrizzleQueryError`, turning a 4xx into a 500
     * on the money path, and only at the moment somebody most needed a legible
     * answer. Measured before removal, not assumed.
     *
     * Two callers already knew and said so in comments beside themselves
     * (`ib-wallet.service.ts`, `commission.service.ts`: "the database would
     * reject the row"). The knowledge sat next to the call sites while the
     * parameter sat in the signature inviting the next caller to try it.
     *
     * A negative wallet is a debt this CRM can neither collect nor display, so
     * there is no overdraft to grant. A correction is a compensating ENTRY,
     * which is an ordinary credit and needs no escape hatch.
     */
    if (newBalance.lessThan(0)) {
      throw new MoneyRuleError(
        // Said as a person reads money — "$0.00", not "0.00000000 … -10.00000000".
        // The portal leaves the balance check to the server, so a client who
        // asks for more than they hold reads this sentence as it is.
        `Insufficient balance: the wallet holds ${displayMoney(wallet.balance, currency)}, ` +
          `and this needs ${displayMoney(amount.abs().toString(), currency)}.`,
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

    /*
     * `FOR NO KEY UPDATE`, not `FOR UPDATE` (found by load test, 26 Sep 2026).
     *
     * Every money path inserts a row that REFERENCES the wallet before it posts
     * — a withdrawal its `transactions` row, a transfer its `transfers` row —
     * and a foreign-key check takes a KEY SHARE lock on the wallet row. FOR
     * UPDATE conflicts with KEY SHARE, so two requests on one wallet each held
     * a KEY SHARE the other's FOR UPDATE waited on: "deadlock detected", one
     * killed a second — 28 of 30 simultaneous withdrawals answered 500.
     *
     * NO KEY UPDATE is the lock for changing a row's non-key columns — which is
     * all a balance update is (the UPDATE below takes it anyway). It still
     * conflicts with itself, so balance writers stay strictly one at a time
     * (§6.2's read-modify-write is still serialised); it just does not conflict
     * with a foreign-key check. Pinned by `withdrawal-flow.spec.ts`.
     */
    const [wallet] = await tx
      .select()
      .from(wallets)
      .where(
        and(eq(wallets.userId, userId), eq(wallets.currency, currency), eq(wallets.kind, kind)),
      )
      .for('no key update')
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
    /*
     * `lessThanOrEqualTo(0)`, NOT `!isPositive()` — this guard read correctly
     * and admitted zero until 11 Sep 2026. decimal.js gives ZERO a sign of 1, so
     * `new Decimal(0).isPositive()` is TRUE and `!isPositive()` never fired for
     * '0'. Measured: `isPositive()` is true for `0` and `0.00000000`, and false
     * for `-0`, because it reads the SIGN rather than the value.
     *
     * `ib-wallet.service.ts` and `commission.ts` had already learned this and
     * written it down three times between them. The idiom survived here because
     * it propagates by imitation — a reader copies the line that looks right.
     */
    if (value.lessThanOrEqualTo(0)) throw new ValidationError('Hold amount must be positive.');
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

  /**
   * Release a hold — on rejection, or after the matching debit is posted.
   *
   * ⚠️ THE POSITIVE CHECK IS LOAD-BEARING, AND IT WAS MISSING UNTIL 11 Sep 2026.
   *
   * This is the mirror of `hold`, which has always opened with the same guard.
   * `release` had none, and its arithmetic is `on_hold - value` — so a NEGATIVE
   * release INCREASED the hold.
   *
   * It did not crash. `wallets_hold_within_balance` (`on_hold <= balance`)
   * accepts the result whenever the increase stays inside the balance, so the
   * wallet ended up with MORE money frozen and every screen reported success.
   * Measured on a 100.00 balance with 50.00 held: `release(-50)` resolved
   * normally and left `on_hold = 100.00000000` — the client's ENTIRE balance
   * frozen, available zero, by a method called "release". That is worse than an
   * error, because nothing anywhere says it happened.
   *
   * It is an easy call to get wrong rather than a theoretical one: in
   * `transfers.service.ts` the line immediately after `release(..., amount)` is
   * `post({ amount: amount.negated() })`. The negated value sits one line below,
   * waiting to be passed to the wrong one of the pair.
   *
   * ZERO is refused too, matching `hold` exactly rather than diverging from it:
   * releasing nothing is a caller that has computed the wrong amount, and the
   * two halves of one pairing should not disagree about what a valid amount is.
   */
  async release(userId: string, currency: Currency, amount: MoneyInput, executor?: Executor) {
    const value = toDecimal(amount);
    // `lessThanOrEqualTo(0)`, for the decimal.js reason documented on `hold`.
    if (value.lessThanOrEqualTo(0)) throw new ValidationError('Release amount must be positive.');
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
        .set({ onHold: money(remaining.lessThan(0) ? '0' : remaining) })
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
      .select({ wallet: wallets })
      .from(wallets)
      .innerJoin(currencies, eq(currencies.code, wallets.currency))
      .where(
        and(
          eq(wallets.userId, userId),
          eq(wallets.kind, kind),
          /*
           * A DISABLED currency's wallet is shown only while it holds money.
           *
           * Clients open wallets with a click (`openOwnWallet`) and registration
           * opens every enabled currency, so disabling one would otherwise leave
           * an empty card for a currency the platform no longer offers — on the
           * wallet screen and on the deposit and transfer pickers that read this
           * list. A wallet with a balance or funds on hold stays visible: that
           * money is the client's.
           */
          or(
            eq(currencies.enabled, true),
            sql`${wallets.balance} <> 0`,
            sql`${wallets.onHold} <> 0`,
          ),
        ),
      );
    return rows.map(({ wallet: w }) => ({
      ...w,
      balance: money(w.balance),
      onHold: money(w.onHold),
      available: available(w.balance, w.onHold),
    }));
  }

  /**
   * Open a wallet in an OFFERED currency for this user, on their own request —
   * the portal's "Open wallet" card (owner, 26 Sep 2026).
   *
   * Adding a currency opens nothing for anybody: a write per client for every
   * currency an operator adds does not scale. Instead every enabled currency a
   * client does not hold is shown as a card they can open, and this writes the
   * one row for the one person who asked. `kind` is `commission` when a partner
   * opens a commission wallet the same way (`IbWalletService`).
   *
   * Refused for a currency that does not exist or is disabled — the card is only
   * offered for enabled ones, so reaching this means a hand-made request or a
   * currency disabled while the page was open.
   *
   * IDEMPOTENT: a second click, or a wallet the client already holds, returns
   * that wallet unchanged. `getOrCreateWallet` never touches an existing
   * balance.
   */
  async openOwnWallet(userId: string, code: string, kind: WalletKind = DEFAULT_KIND) {
    const currency = code.trim().toUpperCase();
    const [offered] = await this.db
      .select({ enabled: currencies.enabled })
      .from(currencies)
      .where(eq(currencies.code, currency))
      .limit(1);
    if (!offered?.enabled) {
      throw new ValidationError(`${currency} is not a currency this platform offers.`);
    }

    await this.getOrCreateWallet(userId, currency, kind);
    const opened = (await this.listWallets(userId, kind)).find(
      (wallet) => wallet.currency === currency,
    );
    if (!opened) throw new NotFoundError('Wallet not found.');
    return opened;
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
    q?: string;
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
    /*
     * The owner, by what the screen now SHOWS. This list gained a named Client
     * column and kept a uuid-only filter, so half the screen spoke in names and
     * the other half in ids — the same defect as the wallets desk, left behind
     * on the first pass.
     *
     * ⚠️ The expression is character-for-character the one `users.store.ts`
     * searches on, and must stay that way: a leading wildcard cannot use a
     * b-tree, so this is served by the pg_trgm GIN index, and Postgres uses that
     * index ONLY when the query matches what it was built on.
     *
     * ⚠️⚠️ `isNotNull(users.id)` IS NOT REDUNDANT, and leaving it out cost the
     * index. This join is LEFT — an entry whose client row has gone must still
     * appear, because `ledger_entries` is append-only and a reconciliation that
     * silently drops rows is worse than one naming an id it cannot resolve.
     *
     * Postgres will convert a LEFT join to an INNER one, and so start from the
     * trigram index on `users`, only when it can PROVE the filter rejects a
     * NULL-extended row. The expression above is `coalesce`d, so for a missing
     * client it evaluates to `'  '` — a real string, not NULL — and the proof
     * fails. The plan then hash-joins every user in the table and filters
     * afterwards: measured on 20,000 clients, 40,065 buffers and a full pass,
     * against five matching rows.
     *
     * This says the thing the coalesce hid. A search by name cannot match an
     * entry with no client anyway, so it changes no result — it only tells the
     * planner what is already true. `test/search-at-scale.spec.ts` is what
     * caught it and is what will catch its removal.
     */
    if (filter.q?.trim()) {
      conditions.push(isNotNull(users.id));
      conditions.push(clientIdentitySearch(filter.q));
    }

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
        /*
         * The raw sort value for the cursor, as TEXT — see `buildCursorPage`.
         *
         * The driver hands a `timestamptz` back as a JS Date, which holds
         * milliseconds while the column holds microseconds, so a cursor minted
         * from the Date skips every row sharing the boundary row's millisecond.
         * On a LEDGER that is the reconciliation screen quietly missing
         * movements — this list orders by `created_at` only, and ledger rows
         * written inside one transaction share it exactly.
         *
         * Stripped before the row becomes a response.
         */
        cursorValue: sql<string>`${ledgerEntries.createdAt}::text`,
        id: ledgerEntries.id,
        walletId: ledgerEntries.walletId,
        walletNumber: wallets.walletNumber,
        amount: ledgerEntries.amount,
        balanceAfter: ledgerEntries.balanceAfter,
        entryType: ledgerEntries.entryType,
        referenceType: ledgerEntries.referenceType,
        referenceId: ledgerEntries.referenceId,
        createdAt: ledgerEntries.createdAt,
        currency: wallets.currency,
        userId: wallets.userId,
        /*
         * WHO THE ROW BELONGS TO, in words.
         *
         * The ledger carried `userId` alone, so ADM-13 rendered a raw uuid in
         * its "Client" column — on the screen an operator opens precisely to
         * ask *whose money is this*. Its sibling screens (`/wallets`,
         * `/trading-accounts`) have shown a named Owner all along, so this was
         * an inconsistency rather than a decision.
         *
         * A LEFT join, not an inner one: `wallets.user_id` has no FK to a
         * deleted user in every historical row, and the ledger is append-only —
         * an entry whose client row has gone must still appear, because a
         * reconciliation that silently drops rows is worse than one naming an
         * id. The DTO's fields are nullable for the same reason.
         *
         * The identity is MASKED automatically: `FieldMaskInterceptor` reads
         * the route's declared response type and strips every `@ClientField` an
         * actor's mask hides. That is why these come back as plain columns and
         * nothing here calls a mask — the shape carries the rule.
         */
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userEmail: users.email,
        // The identifier a masked reader still gets — see `users.portal_id`.
        userPortalId: users.portalId,
      })
      .from(ledgerEntries)
      .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
      .leftJoin(users, eq(users.id, wallets.userId))
      .where(where)
      .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
      .limit(limit + 1)
      .offset(usingCursor ? 0 : (page - 1) * limit);

    /*
     * The SAME joins as the rows query above, `users` included. The count runs
     * the same WHERE — so once that WHERE could reference `users` (the client
     * search), a count without the join was a 500 on every filtered page. It
     * failed loudly and immediately, which is the good version of this mistake;
     * the bad version is a count over a DIFFERENT row set than the page, which
     * reports a total nobody can page to.
     */
    const [{ value: total }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(ledgerEntries)
      .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
      .leftJoin(users, eq(users.id, wallets.userId))
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
