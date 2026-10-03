import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { currencies, wallets } from '../../database/schema';
import {
  ConflictError,
  FieldValidationError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import {
  CURRENCY_LIMIT_FIELDS,
  currencyLimitProblems,
  type CurrencyLimits,
} from '../../common/currency-limits';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import { placeInOrder } from '../../common/ordering';
import type { CreateCurrencyDto, UpdateCurrencyDto } from './dto/currency.dto';
import { arabicText } from '../../common/dto/arabic-text';

type Db = ReturnType<typeof getDb>;
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The currencies the platform supports, and the rules that keep them safe.
 *
 * These used to be a `pgEnum`, which made "what money can this platform hold"
 * a deploy. They are a table now — see `currencies` in schema.ts for why the
 * code is the primary key and why rows are disabled rather than deleted.
 *
 * Three invariants live here rather than in the controllers, because there are
 * two controllers (client and admin) and a service that provisions wallets, and
 * a rule enforced in three places is a rule enforced in two:
 *
 *   1. A code is normalised — upper-cased and trimmed — before it is ever
 *      compared or stored. 'usd' and 'USD' must never become two currencies.
 *   2. Exactly one currency may be the default. Setting a new one clears the
 *      old one in the SAME transaction, because the partial unique index makes
 *      the intermediate state illegal.
 *   3. A currency holding wallets cannot be deleted, and the default cannot be
 *      disabled. Both are refusals with a reason, never silent no-ops.
 */
@Injectable()
export class CurrenciesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
  ) {}

  /*
   * ── ADDING A CURRENCY OPENS NO WALLETS — CLIENTS OPEN THEIR OWN ─────────────
   *
   * A write per client for every currency an operator adds does not scale: a
   * million clients is a million rows written because a form was saved, most of
   * them never used. The owner's call (26 Sep 2026) is the opposite model:
   *
   *   - Adding or enabling a currency only makes it AVAILABLE.
   *   - The portal shows every enabled currency a client does not hold as a card
   *     they can open with one click (`POST /wallet`), and every one a partner
   *     does not hold as a commission wallet they can open
   *     (`POST /ib/wallet/commission`). Each writes ONE row, for the person who
   *     asked.
   *   - Registration still opens every enabled currency for a new client, and
   *     every money path opens the wallet it needs on first use
   *     (`getOrCreateWallet`).
   *
   * `scripts/backfill-wallets.mjs` remains for an operator who wants to open one
   * currency for everybody on purpose.
   */

  /**
   * The single normalisation point.
   *
   * Every path in and out of this service runs a code through here. Without it
   * the API accepts ' eur ' from one caller and 'EUR' from another, the unique
   * primary key sees two different strings, and the platform now has two euros
   * with separate balances — which is unfixable once wallets exist behind both.
   */
  private normalise(code: string): string {
    return code.trim().toUpperCase();
  }

  /** Everything, operator order first. The admin screen's list. */
  listAll() {
    return this.db
      .select()
      .from(currencies)
      .orderBy(asc(currencies.sortOrder), asc(currencies.code));
  }

  /**
   * What a CLIENT may hold, in the operator's order.
   *
   * Disabled currencies are absent rather than flagged: a client has no use for
   * "you cannot open this", and a portal that received them would have to
   * remember to filter — which is the kind of thing one screen forgets.
   */
  listEnabled() {
    return this.db
      .select()
      .from(currencies)
      .where(eq(currencies.enabled, true))
      .orderBy(asc(currencies.sortOrder), asc(currencies.code));
  }

  async findOne(code: string) {
    const [row] = await this.db
      .select()
      .from(currencies)
      .where(eq(currencies.code, this.normalise(code)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The currency a brand-new client's first wallet opens in.
   *
   * Returns null rather than falling back to a hardcoded 'USD'. A platform with
   * no default is misconfigured, and inventing one here would open every new
   * client a wallet in a currency nobody chose — silently, and permanently,
   * because the wallet cannot be deleted once it has a ledger. The caller
   * decides what to do with the absence; `AuthService` logs and opens none.
   */
  async getDefault() {
    const [row] = await this.db
      .select()
      .from(currencies)
      .where(and(eq(currencies.isDefault, true), eq(currencies.enabled, true)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The runtime half of what the `Currency` type used to check at compile time.
   *
   * `wallet.service.ts` explains the trade: currencies are operator data, so a
   * union type could not express them, and the check moved here — in front of
   * every write path — with the `wallets_currency_currencies_code_fk` foreign
   * key behind it as the backstop for any caller that skips this.
   *
   * Refuses DISABLED as well as unknown. A disabled currency's existing wallets
   * stay readable and spendable; what it must not do is accept new money.
   */
  async assertUsable(code: string, executor?: Executor): Promise<string> {
    return (await this.assertUsableDetail(code, executor)).code;
  }

  /**
   * `assertUsable`, plus the currency's declared SCALE.
   *
   * Same query, same refusals — it exists because callers that accept an amount
   * from a client need to know how many decimal places that currency actually
   * has, and re-reading the row to find out would be a second round trip on a
   * money path.
   *
   * `decimals` is documented as DISPLAY precision, and using it to VALIDATE
   * widens that meaning deliberately. The alternative was to hardcode 2, which
   * this project's working agreement forbids ("never hardcode a number nobody
   * gave us") — and the operator has already stated the answer on the currency
   * row. A currency that renders two decimals while accepting eight is not
   * displaying a rounded figure; it is accepting money it cannot pay back.
   */
  async assertUsableDetail(
    code: string,
    executor?: Executor,
  ): Promise<{ code: string; decimals: number; limits: CurrencyLimits }> {
    const db = executor ?? this.db;
    const normalised = this.normalise(code);
    const [row] = await db
      .select({ enabled: currencies.enabled, decimals: currencies.decimals, ...LIMIT_COLUMNS })
      .from(currencies)
      .where(eq(currencies.code, normalised))
      .limit(1);

    if (!row) throw new NotFoundError(`Unknown currency ${normalised}.`);
    if (!row.enabled) {
      throw new ValidationError(`${normalised} is not currently available on this platform.`);
    }
    const { enabled: _enabled, decimals, ...limits } = row;
    return { code: normalised, decimals, limits };
  }

  /**
   * A currency's money limits (0162), enabled or not — for a path that moves
   * money in a currency it has already accepted (an admin credit into an
   * existing wallet), where "is this currency still offered" is not the
   * question. Null for an unknown code.
   */
  async limitsFor(code: string, executor?: Executor): Promise<CurrencyLimits | null> {
    const db = executor ?? this.db;
    const [row] = await db
      .select(LIMIT_COLUMNS)
      .from(currencies)
      .where(eq(currencies.code, this.normalise(code)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Give `code` the position the operator asked for, and move whoever is in the
   * way — see `common/ordering.ts` for why all four catalogues share one rule.
   *
   * Returns the position the caller should STORE for `code`; every other row
   * that has to move is written here, inside the caller's transaction, so a
   * half-renumbered list cannot survive a failure.
   *
   * `undefined` means append. That is the only answer to "no opinion" that does
   * not move somebody else's row.
   */
  private async placeOrder(
    tx: Executor,
    code: string,
    desired: number | undefined,
  ): Promise<number> {
    const rows = await tx
      .select({ code: currencies.code, sortOrder: currencies.sortOrder })
      .from(currencies);

    const changes = placeInOrder(
      rows.map((row) => ({ id: row.code, sortOrder: row.sortOrder })),
      code,
      desired,
    );

    let position = rows.find((row) => row.code === code)?.sortOrder ?? 0;

    for (const change of changes) {
      if (change.id === code) {
        position = change.sortOrder;
        continue;
      }
      await tx
        .update(currencies)
        .set({ sortOrder: change.sortOrder })
        .where(eq(currencies.code, change.id));
    }

    return position;
  }

  async create(dto: CreateCurrencyDto, actor: Actor) {
    const code = this.normalise(dto.code);
    const limits = pickLimits(dto);
    assertLimits(limits);

    const existing = await this.findOne(code);
    if (existing) throw new ConflictError(`Currency ${code} already exists.`);

    const row = await this.db.transaction(async (tx) => {
      // Clear the incumbent FIRST. The partial unique index means two rows with
      // is_default = true cannot coexist even momentarily, so "insert then
      // clear" fails at the insert rather than at the clear.
      if (dto.isDefault) await this.clearDefaultWithin(tx);

      const [created] = await tx
        .insert(currencies)
        .values({
          code,
          name: dto.name.trim(),
          nameAr: arabicText(dto.nameAr),
          symbol: dto.symbol.trim(),
          decimals: dto.decimals ?? 2,
          enabled: dto.enabled ?? true,
          isDefault: dto.isDefault ?? false,
          ...limits,
          /*
           * `?? 0` used to sit here, and it put EVERY new currency at the top
           * of the list — adding AED to a list led by USD moved USD down, with
           * nothing saying so and no way to put it back except renumbering by
           * hand. `placeOrder` appends when no position is asked for and
           * inserts when one is, pushing the rest down instead of tying.
           */
          sortOrder: await this.placeOrder(tx, code, dto.sortOrder),
        })
        .returning();
      return created;
    });

    /*
     * `record`, not `recordWithin`. No balance moves here — adding a currency
     * changes what the platform OFFERS, and losing the audit row should not
     * undo a correct configuration change. The money rule applies to the
     * transitions that move a balance, not to every write inside a transaction.
     */
    this.audit.record(actor.id, 'currency.create', 'currency', row.code, {
      name: row.name,
      nameAr: row.nameAr,
      symbol: row.symbol,
      decimals: row.decimals,
      enabled: row.enabled,
      isDefault: row.isDefault,
      ...pickLimits(row),
    });

    return publicCurrency(row);
  }

  async update(code: string, dto: UpdateCurrencyDto, actor: Actor) {
    const normalised = this.normalise(code);
    const current = await this.findOne(normalised);
    if (!current) throw new NotFoundError(`Unknown currency ${normalised}.`);

    /*
     * The default must stay usable, so it cannot be disabled while it holds the
     * flag. Refused rather than silently un-defaulted: an operator disabling
     * their default currency has either picked the wrong row or needs to
     * nominate a replacement first, and both deserve to be told.
     */
    const willBeDefault = dto.isDefault ?? current.isDefault;
    const willBeEnabled = dto.enabled ?? current.enabled;
    if (willBeDefault && !willBeEnabled) {
      throw new ValidationError(
        `${normalised} is the default currency and cannot be disabled. Make another currency the default first.`,
      );
    }

    /*
     * Clearing the flag without naming a successor would leave the platform
     * with no default, and registration would then open no wallet at all for
     * every client who signed up afterwards. Refuse; nominating the replacement
     * is one request and it moves the flag atomically.
     */
    if (current.isDefault && dto.isDefault === false) {
      throw new ValidationError(
        'A platform must have a default currency. Set another currency as the default instead — that moves the flag.',
      );
    }

    /*
     * The limits are judged MERGED — what the row will hold, not only what was
     * sent — so raising a minimum above the stored maximum is refused even when
     * the request names only the minimum.
     */
    const sentLimits = pickLimits(dto);
    const mergedLimits = { ...pickLimits(current), ...sentLimits };
    if (Object.keys(sentLimits).length > 0) assertLimits(mergedLimits);

    const row = await this.db.transaction(async (tx) => {
      if (dto.isDefault && !current.isDefault) await this.clearDefaultWithin(tx);

      const [updated] = await tx
        .update(currencies)
        .set({
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.nameAr !== undefined ? { nameAr: arabicText(dto.nameAr) } : {}),
          ...(dto.symbol !== undefined ? { symbol: dto.symbol.trim() } : {}),
          ...(dto.decimals !== undefined ? { decimals: dto.decimals } : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
          ...sentLimits,
          ...(dto.sortOrder !== undefined
            ? { sortOrder: await this.placeOrder(tx, normalised, dto.sortOrder) }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(currencies.code, normalised))
        .returning();
      return updated;
    });

    /*
     * Only the fields that MOVED, with what they were.
     *
     * `enabled` and `isDefault` are the two worth attributing: disabling a
     * currency stops every new wallet and deposit in it, and moving the default
     * changes what every subsequent registration opens. Both are quiet — no
     * error, no balance change — and "when did we stop offering EUR" is
     * unanswerable from a row that only holds the current state.
     */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of [
      'name',
      'nameAr',
      'symbol',
      'decimals',
      'enabled',
      'isDefault',
      'sortOrder',
      // A limit moving changes what every client may move — who and when matters.
      ...CURRENCY_LIMIT_FIELDS,
    ] as const) {
      if (current[field] !== row[field])
        changed[field] = { before: current[field], after: row[field] };
    }
    this.audit.record(actor.id, 'currency.update', 'currency', normalised, { changed });
    return publicCurrency(row);
  }

  /**
   * Delete a currency — possible only while it has never held money.
   *
   * ## Empty, unused wallets go with it
   *
   * Clients and partners open wallets in a currency with a click, so a
   * currency added by mistake or to try out can have a few empty wallets by the
   * time somebody deletes it. Those are deleted with the currency, in one
   * transaction, so it can still be removed.
   *
   * ## Refused, with a reason, once money has touched it
   *
   *   - A wallet in it holds a balance or funds on hold: the money is a client's,
   *     and deleting its unit is how a balance loses its meaning.
   *   - A wallet in it has any history (a ledger entry, a transaction, a
   *     transfer): the RESTRICT foreign keys refuse, inside a savepoint, and
   *     that refusal is turned into a sentence.
   *   - Anything else still uses the code (a payment method, a trading account,
   *     a record): the same, from the currency row's own foreign keys.
   *
   * In every refused case NOTHING is deleted — the transaction rolls back, the
   * wallets included. Disabling is the way to stop offering a currency that has
   * been used.
   */
  async remove(code: string, actor: Actor) {
    const normalised = this.normalise(code);
    const current = await this.findOne(normalised);
    if (!current) throw new NotFoundError(`Unknown currency ${normalised}.`);

    if (current.isDefault) {
      throw new ValidationError(
        'The default currency cannot be deleted. Make another currency the default first.',
      );
    }

    await this.db.transaction(async (tx) => {
      const [funded] = await tx
        .select({ n: count() })
        .from(wallets)
        .where(
          and(
            eq(wallets.currency, normalised),
            or(sql`${wallets.balance} <> 0`, sql`${wallets.onHold} <> 0`),
          ),
        );
      if ((funded?.n ?? 0) > 0) {
        throw new ConflictError(
          `${normalised} cannot be deleted: ${funded?.n} wallet(s) in it hold money. Disable it instead.`,
        );
      }

      try {
        await tx.transaction(async (savepoint) => {
          await savepoint.delete(wallets).where(eq(wallets.currency, normalised));
        });
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw new ConflictError(
            `${normalised} cannot be deleted: its wallets have a history of money movements. ` +
              'Disable it instead.',
          );
        }
        throw error;
      }

      try {
        await tx.transaction(async (savepoint) => {
          await savepoint.delete(currencies).where(eq(currencies.code, normalised));
        });
      } catch (error) {
        if (isForeignKeyViolation(error)) {
          throw new ConflictError(
            `${normalised} cannot be deleted: payment methods, trading accounts or records still ` +
              'use it. Disable it instead.',
          );
        }
        throw error;
      }
    });

    // The row as it was, because the DELETE is the last place it existed.
    this.audit.record(actor.id, 'currency.delete', 'currency', normalised, {
      name: current.name,
      symbol: current.symbol,
      decimals: current.decimals,
      enabled: current.enabled,
    });
    return { code: normalised, deleted: true };
  }

  /** Only ever called inside a transaction that is about to set a new default. */
  private async clearDefaultWithin(tx: Executor) {
    await tx
      .update(currencies)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(currencies.isDefault, true), ne(currencies.code, '')));
  }
}

/** A Postgres foreign-key refusal, however the driver wrapped it. */
function isForeignKeyViolation(error: unknown): boolean {
  const wrapped = error as { code?: string; cause?: { code?: string } } | null;
  return (wrapped?.cause?.code ?? wrapped?.code) === '23503';
}

/** The four limit columns, selected under their DTO names. */
const LIMIT_COLUMNS = {
  minDeposit: currencies.minDeposit,
  maxDeposit: currencies.maxDeposit,
  minWithdrawal: currencies.minWithdrawal,
  maxWithdrawal: currencies.maxWithdrawal,
};

/** The limits a write carries — only the ones it names. */
function pickLimits(
  source: Partial<Record<keyof CurrencyLimits, string>>,
): Partial<CurrencyLimits> {
  const picked: Partial<CurrencyLimits> = {};
  for (const field of CURRENCY_LIMIT_FIELDS) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked;
}

/** Refuses a set of limits that does not make sense, each sentence under its field. */
function assertLimits(limits: Partial<CurrencyLimits>): void {
  const problems = currencyLimitProblems(limits as CurrencyLimits);
  if (Object.keys(problems).length > 0) {
    throw new FieldValidationError(Object.values(problems)[0], problems);
  }
}

/**
 * A currency row without its DEAD column (0169) — the daily withdrawal cap is
 * gone, and `CurrencyDto` does not name it.
 */
function publicCurrency<T extends { maxWithdrawalDaily?: unknown }>(
  row: T,
): Omit<T, 'maxWithdrawalDaily'> {
  const { maxWithdrawalDaily: _daily, ...rest } = row;
  return rest;
}
