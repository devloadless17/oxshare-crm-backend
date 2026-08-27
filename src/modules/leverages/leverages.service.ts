import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { leverages, tradingAccounts } from '../../database/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { DEFAULT_LEVERAGES } from '../../common/trading-terms';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import { placeInOrder } from '../../common/ordering';
import type { CreateLeverageDto, UpdateLeverageDto } from './dto/leverage.dto';

type Db = ReturnType<typeof getDb>;

/**
 * The leverage ladder a client may open an account on.
 *
 * ## Why this is a table and not `trading_settings.leverages`
 *
 * It was a CSV in a singleton row — `50,100,200,500` — and the column's own
 * note argued that was enough because nothing queried into it. That held until
 * an operator needed to WITHDRAW a rung: deleting a number from a string says
 * nothing about the accounts already opened on it, and a delimited list has
 * nowhere to put `enabled`, so "we never offered 1000:1" and "we stopped
 * offering it" were the same state.
 *
 * Same argument `currencies` and `ib_levels` already settled, and this service
 * is deliberately shaped like `CurrenciesService` for that reason.
 *
 * ## Three invariants live here rather than in the controllers
 *
 *   1. A ratio is a POSITIVE INTEGER. 500 means 500:1; zero and negatives are
 *      not leverage, and a fraction is not a ratio MT5 accepts.
 *   2. A rung IN USE cannot be deleted — disable it instead. Deleting it would
 *      leave `trading_accounts.leverage` pointing at a ratio the ladder no
 *      longer explains, on accounts that are still trading at it.
 *   3. The last ENABLED rung cannot be disabled. An empty ladder is not a
 *      configuration, it is an account-opening form with no options and a
 *      client who cannot proceed.
 */
@Injectable()
export class LeveragesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
  ) {}

  /** Everything, operator order first. The admin screen's list. */
  listAll() {
    return this.db.select().from(leverages).orderBy(asc(leverages.sortOrder), asc(leverages.ratio));
  }

  /**
   * What a CLIENT may choose, in the operator's order.
   *
   * Disabled rungs are absent rather than flagged: a client has no use for
   * "you cannot pick this", and a portal that received them would have to
   * remember to filter — which is the kind of thing one screen forgets.
   *
   * Falls back to `DEFAULT_LEVERAGES` when the table is EMPTY, which is a
   * platform mid-setup rather than a deliberate choice. An empty ladder would
   * otherwise render an account-opening form with no options, and the client
   * cannot fix that from where they are standing.
   */
  async listEnabled(): Promise<number[]> {
    const rows = await this.db
      .select({ ratio: leverages.ratio })
      .from(leverages)
      .where(eq(leverages.enabled, true))
      .orderBy(asc(leverages.sortOrder), asc(leverages.ratio));

    return rows.length > 0 ? rows.map((row) => row.ratio) : [...DEFAULT_LEVERAGES];
  }

  async findOne(ratio: number) {
    const [row] = await this.db.select().from(leverages).where(eq(leverages.ratio, ratio)).limit(1);
    return row ?? null;
  }

  /**
   * Is this ratio one a client may currently be given?
   *
   * The runtime gate on the account-opening path, in the same shape as
   * `CurrenciesService.assertUsable` — and for the same reason: the ladder is
   * operator data, so a compile-time union cannot express it and the check has
   * to happen where the answer lives.
   *
   * Refuses DISABLED as well as unknown. A withdrawn rung must not be openable
   * by a client who kept the form in a tab.
   */
  async assertUsable(ratio: number): Promise<number> {
    const row = await this.findOne(ratio);
    if (!row) throw new ValidationError(`${ratio}:1 is not a leverage this platform offers.`);
    if (!row.enabled) {
      throw new ValidationError(`${ratio}:1 is not currently available on this platform.`);
    }
    return ratio;
  }

  async create(dto: CreateLeverageDto, actor: Actor) {
    this.assertRatio(dto.ratio);

    const existing = await this.findOne(dto.ratio);
    if (existing) throw new ConflictError(`${dto.ratio}:1 is already on the ladder.`);

    /*
     * TRANSACTIONAL, because placing this rung renumbers the ones it displaces.
     * A failure between the renumber and the insert would leave the ladder with
     * a hole where this rung was going to sit.
     */
    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(leverages)
        .values({
          ratio: dto.ratio,
          label: dto.label?.trim() || null,
          enabled: dto.enabled ?? true,
          /*
           * `nextSortOrder()` used to sit here — max + 10, which appended
           * correctly but left gaps of ten that no screen explained and no
           * control could close. Worse, an explicit `dto.sortOrder` was stored
           * RAW, so typing a number another rung already held produced a tie
           * and the ladder fell back to ordering by ratio.
           */
          sortOrder: await this.placeOrder(tx, dto.ratio, dto.sortOrder),
        })
        .returning();
      return row;
    });

    this.audit.record(actor.id, 'leverage.create', 'leverages', String(created.ratio), {
      ratio: created.ratio,
    });
    return created;
  }

  async update(ratio: number, dto: UpdateLeverageDto, actor: Actor) {
    const current = await this.findOne(ratio);
    if (!current) throw new NotFoundError(`No leverage ${ratio}:1.`);

    /*
     * Refusing to disable the LAST enabled rung.
     *
     * Checked on the transition rather than on the resulting value, so
     * re-saving an already-disabled row is not blocked by a rule about a change
     * it is not making.
     */
    if (current.enabled && dto.enabled === false) {
      const enabled = await this.db
        .select({ ratio: leverages.ratio })
        .from(leverages)
        .where(eq(leverages.enabled, true));

      if (enabled.length <= 1) {
        throw new ValidationError(
          'This is the only leverage on offer. Enable another before disabling this one — ' +
            'an empty ladder leaves clients an account-opening form with no options.',
        );
      }
    }

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(leverages)
        .set({
          ...(dto.label !== undefined ? { label: dto.label?.trim() || null } : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          ...(dto.sortOrder !== undefined
            ? { sortOrder: await this.placeOrder(tx, ratio, dto.sortOrder) }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(leverages.ratio, ratio))
        .returning();
      return row;
    });

    /* Only the fields that MOVED, with what they were — the same shape every
       other settings audit row in this codebase takes. */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of ['label', 'enabled', 'sortOrder'] as const) {
      if (current[key] !== updated[key]) {
        changed[key] = { before: current[key], after: updated[key] };
      }
    }
    if (Object.keys(changed).length > 0) {
      this.audit.record(actor.id, 'leverage.update', 'leverages', String(ratio), changed);
    }
    return updated;
  }

  /**
   * Delete a rung, unless an account is standing on it.
   *
   * `trading_accounts.leverage` carries no foreign key onto this table — MT5 is
   * the system of record for what an account actually runs at, and it may
   * report a ratio this ladder never offered. So the guard is here rather than
   * in the database, and it is a REFUSAL with a reason rather than a cascade:
   * an operator wanting the rung off the menu wants `enabled: false`, which
   * leaves those accounts alone.
   */
  async remove(ratio: number, actor: Actor) {
    const current = await this.findOne(ratio);
    if (!current) throw new NotFoundError(`No leverage ${ratio}:1.`);

    const [inUse] = await this.db
      .select({ id: tradingAccounts.id })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.leverage, ratio))
      .limit(1);

    if (inUse) {
      throw new ConflictError(
        `Accounts are open at ${ratio}:1, so it cannot be deleted. Disable it instead — ` +
          'that takes it off the menu and leaves those accounts trading.',
      );
    }

    await this.db.delete(leverages).where(eq(leverages.ratio, ratio));
    this.audit.record(actor.id, 'leverage.delete', 'leverages', String(ratio), {
      ratio,
      label: current.label,
    });
  }

  /** Appended to the end of the operator's order, in tens so a later insert fits between. */
  /**
   * Give this rung the position asked for, moving whoever is in the way.
   *
   * Replaced `nextSortOrder()` — max + 10 — which appended correctly and left
   * gaps of ten behind. The ladder is `0,1,2 …` now, so the number in the form
   * is the position on the screen rather than a spacing convention.
   *
   * Keyed on the RATIO, which is this table's primary key. `placeInOrder` takes
   * string ids, so the ratio is stringified on the way in and parsed back out —
   * a rung is `500:1`, and there is no separate surrogate to use instead.
   */
  private async placeOrder(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    ratio: number,
    desired: number | undefined,
  ): Promise<number> {
    const rows = await tx
      .select({ ratio: leverages.ratio, sortOrder: leverages.sortOrder })
      .from(leverages);

    const changes = placeInOrder(
      rows.map((row) => ({ id: String(row.ratio), sortOrder: row.sortOrder })),
      String(ratio),
      desired,
    );

    let position = rows.find((row) => row.ratio === ratio)?.sortOrder ?? 0;

    for (const change of changes) {
      if (change.id === String(ratio)) {
        position = change.sortOrder;
        continue;
      }
      await tx
        .update(leverages)
        .set({ sortOrder: change.sortOrder })
        .where(eq(leverages.ratio, Number(change.id)));
    }

    return position;
  }

  private assertRatio(ratio: number): void {
    if (!Number.isInteger(ratio) || ratio <= 0) {
      throw new ValidationError('A leverage is a positive whole number — 500 means 500:1.');
    }
  }
}
