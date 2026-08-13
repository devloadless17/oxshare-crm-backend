import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import { WalletsStore } from '../../store/wallets.store';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { currencies } from '../../database/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import type { CreateCurrencyDto, UpdateCurrencyDto } from './dto/currency.dto';

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
    /*
     * Opens the new currency's wallet on every existing client.
     *
     * The STORE, not `WalletProvisioningService` and not the provisioning port.
     * `WalletModule` imports this module, so depending on anything it binds
     * closes a cycle — and that cycle does not throw, it HANGS Nest's
     * bootstrap. See the note at the foot of `wallet-provisioning.port.ts`.
     *
     * `StoreModule` is @Global and is depended upon by modules rather than the
     * reverse, so this adds no edge. Same route `AuthService` takes to IbStore.
     */
    private readonly walletsStore: WalletsStore,
  ) {}

  private readonly logger = new Logger(CurrenciesService.name);

  /**
   * Give every existing client a wallet in a currency that has just started
   * being offered.
   *
   * Swallows and logs, and that is the whole reason this wrapper exists. The
   * currency write it follows is ALREADY COMMITTED — telling an operator their
   * enable failed would invite them to do it again, which changes nothing
   * (the currency is already enabled) and backfills nothing. A log line naming
   * the currency is actionable; a 500 on a successful write is not.
   */
  private async backfillWallets(code: string): Promise<void> {
    try {
      const opened = await this.walletsStore.openForAllClients(code);
      this.logger.log(`Opened ${opened} ${code} wallet(s) for existing clients.`);
    } catch (error) {
      this.logger.error(
        `${code} is enabled but its wallets could not be backfilled: ${String(error)}. ` +
          'Existing clients will get one on the next money path that touches it.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

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
    const db = executor ?? this.db;
    const normalised = this.normalise(code);
    const [row] = await db
      .select({ enabled: currencies.enabled })
      .from(currencies)
      .where(eq(currencies.code, normalised))
      .limit(1);

    if (!row) throw new NotFoundError(`Unknown currency ${normalised}.`);
    if (!row.enabled) {
      throw new ValidationError(`${normalised} is not currently available on this platform.`);
    }
    return normalised;
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
          sortOrder: dto.sortOrder ?? 0,
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

    /*
     * A currency created ALREADY ENABLED — which is the default — is offered
     * from this moment, so existing clients get their wallet now rather than
     * only the clients who register after it.
     *
     * Created disabled, nothing happens: enabling it later goes through
     * `update`, which backfills there. The two paths cover the same rule from
     * both directions, which is why neither says "and the other one handles it".
     */
    if (row.enabled) {
      await this.backfillWallets(row.code);
    }
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
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(eq(currencies.code, normalised))
        .returning();
      return updated;
    });

    /*
     * A currency that has just BECOME enabled gets a wallet on every existing
     * client — the moment the platform starts offering it is the moment the
     * promise is made.
     *
     * Guarded on the TRANSITION, not on `row.enabled`: a rename or a sort-order
     * nudge on an already-enabled currency must not re-run this. It is
     * idempotent, so a repeat would be harmless, but it would also be a full
     * table scan on every edit of an unrelated field.
     *
     * Outside the transaction above, and after it: the backfill is a large
     * insert and holding the currency row's lock across it would block every
     * concurrent read of the catalogue for its duration. It cannot fail the
     * update either — see the port's contract.
     */
    if (!current.enabled && row.enabled) {
      await this.backfillWallets(normalised);
    }

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
    return row;
  }

  /**
   * Delete a currency.
   *
   * ⚠️ THIS IS TEMPORARILY UNGUARDED, and that is a known gap rather than a
   * simplification. It used to count `wallets` in this currency first and
   * refuse with a 409 naming the number, because the `ON DELETE RESTRICT`
   * foreign keys would refuse anyway and a raw FK violation surfaces as a 500
   * with a Postgres string in it.
   *
   * The `wallets` table is gone with the money teardown, so there is nothing
   * left to count and nothing left referencing `currencies.code`. Deleting a
   * currency right now is genuinely safe — there are no balances to orphan.
   *
   * WHEN MONEY RETURNS, this check must return with it. A currency delete that
   * silently succeeds while wallets hold it is how a balance loses its unit.
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

    await this.db.delete(currencies).where(eq(currencies.code, normalised));

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
