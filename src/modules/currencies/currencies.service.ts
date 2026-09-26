import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, eq, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { currencies, wallets } from '../../database/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import { placeInOrder } from '../../common/ordering';
import type { CreateCurrencyDto, UpdateCurrencyDto } from './dto/currency.dto';
import { WalletsStore } from '../../store/wallets.store';

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
  private readonly logger = new Logger(CurrenciesService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
    /*
     * Opens the wallets when a currency goes live — see `openWalletsFor`.
     * From the @Global() StoreModule, which adds no module edge (the note in
     * `wallets.store.ts` records why the provisioning SERVICE cannot be
     * injected here). OPTIONAL and appended last: the many specs that build
     * this service positionally for other reasons keep working, and without it
     * nothing is opened.
     */
    private readonly walletsStore?: WalletsStore,
  ) {}

  /*
   * ── A CURRENCY THAT GOES LIVE OPENS ITS WALLETS (owner, 26 Sep 2026) ────────
   *
   * Adding an ENABLED currency, or enabling one, opens a wallet in it for every
   * client and a commission wallet for every partner — the same set a client
   * who registers afterwards gets, so every wallet screen lists every currency
   * the platform offers. See `openWalletsFor`.
   *
   * This was tried once before and removed, for two costs that are now handled
   * rather than accepted:
   *
   *   - A write per client INSIDE the request that saved the form. It now runs
   *     AFTER the save commits and the response is not held for it: one
   *     set-based INSERT per wallet kind, which adds only the missing rows.
   *   - A currency added to try out became permanent the moment it had wallets.
   *     `remove` now deletes the wallets that were opened and never used, so an
   *     unused currency can still be deleted; one that has seen money cannot.
   *
   * Disabling a currency keeps its wallets — a balance is the client's — and
   * `WalletService.listWallets` stops showing the EMPTY ones.
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
  ): Promise<{ code: string; decimals: number }> {
    const db = executor ?? this.db;
    const normalised = this.normalise(code);
    const [row] = await db
      .select({ enabled: currencies.enabled, decimals: currencies.decimals })
      .from(currencies)
      .where(eq(currencies.code, normalised))
      .limit(1);

    if (!row) throw new NotFoundError(`Unknown currency ${normalised}.`);
    if (!row.enabled) {
      throw new ValidationError(`${normalised} is not currently available on this platform.`);
    }
    return { code: normalised, decimals: row.decimals };
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
          symbol: dto.symbol.trim(),
          decimals: dto.decimals ?? 2,
          enabled: dto.enabled ?? true,
          isDefault: dto.isDefault ?? false,
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
      symbol: row.symbol,
      decimals: row.decimals,
      enabled: row.enabled,
      isDefault: row.isDefault,
    });

    // After the commit, and not awaited — see `openWalletsFor`.
    if (row.enabled) void this.openWalletsFor(row.code);

    return row;
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

    const row = await this.db.transaction(async (tx) => {
      if (dto.isDefault && !current.isDefault) await this.clearDefaultWithin(tx);

      const [updated] = await tx
        .update(currencies)
        .set({
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.symbol !== undefined ? { symbol: dto.symbol.trim() } : {}),
          ...(dto.decimals !== undefined ? { decimals: dto.decimals } : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
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
      'symbol',
      'decimals',
      'enabled',
      'isDefault',
      'sortOrder',
    ] as const) {
      if (current[field] !== row[field])
        changed[field] = { before: current[field], after: row[field] };
    }
    this.audit.record(actor.id, 'currency.update', 'currency', normalised, { changed });

    // Switched ON: open its wallets, after the commit and not awaited.
    if (!current.enabled && row.enabled) void this.openWalletsFor(row.code);

    return row;
  }

  /**
   * Open a wallet in this currency for every client, and a commission wallet
   * for every partner. Returns how many of each were added.
   *
   * ## After the save, never inside it
   *
   * Called without `await` once the currency row has committed, so the operator
   * is not kept waiting on a write per client. Two set-based statements, each
   * adding only the rows that are missing (`ON CONFLICT DO NOTHING`), so running
   * it again — a re-enable, two instances, a retry — changes nothing and never
   * touches a balance.
   *
   * ## Never throws
   *
   * The currency is already saved. A failure here is LOGGED with the currency's
   * code, and nothing is lost by it: every money path opens the wallet it needs
   * on first use (`getOrCreateWallet`), and `scripts/backfill-wallets.mjs`
   * repairs the list by hand.
   */
  async openWalletsFor(code: string): Promise<{ clients: number; partners: number }> {
    if (!this.walletsStore) return { clients: 0, partners: 0 };
    try {
      const clients = await this.walletsStore.openForAllClients(code);
      const partners = await this.walletsStore.openCommissionForAllPartners(code);
      this.logger.log(
        `Opened ${code} wallets: ${clients} for clients, ${partners} commission wallet(s) for partners.`,
      );
      return { clients, partners };
    } catch (error) {
      this.logger.error(
        `Could not open ${code} wallets for existing clients and partners: ${String(error)}. ` +
          'They open on first use, or run scripts/backfill-wallets.mjs.',
        error instanceof Error ? error.stack : undefined,
      );
      return { clients: 0, partners: 0 };
    }
  }

  /**
   * Delete a currency — possible only while it has never held money.
   *
   * ## The wallets opened for it go with it, if they were never used
   *
   * Adding an enabled currency opens a wallet in it for every client and
   * partner (see `openWalletsFor`). Those EMPTY, UNUSED wallets are deleted with
   * the currency, in one transaction, so a currency added by mistake or to try
   * out can still be removed.
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
