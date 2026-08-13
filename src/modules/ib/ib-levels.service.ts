import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { asc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { ibLevels } from '../../database/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import type { CreateIbLevelDto, UpdateIbLevelDto } from './dto/ib-level.dto';

type Db = ReturnType<typeof getDb>;

/** The ceiling on a revenue-share ladder. Percentages of one pool. */
const MAX_TOTAL_SHARE = new Decimal(100);

@Injectable()
export class IbLevelsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
  ) {}

  /** The whole ladder, shallowest first. Level 1 is closest to the broker. */
  listAll() {
    return this.db.select().from(ibLevels).orderBy(asc(ibLevels.level));
  }

  /** Only the levels a partner may currently be placed at. */
  listEnabled() {
    return this.db
      .select()
      .from(ibLevels)
      .where(eq(ibLevels.enabled, true))
      .orderBy(asc(ibLevels.level));
  }

  async findOne(level: number) {
    const [row] = await this.db.select().from(ibLevels).where(eq(ibLevels.level, level)).limit(1);
    return row ?? null;
  }

  /**
   * How deep the payout chain runs — the count of enabled levels.
   *
   * The one number the future commission engine needs from this table, and the
   * one the approval flow needs today: a partner cannot be placed below the
   * deepest enabled level, because nothing would ever pay them.
   */
  async depth(): Promise<number> {
    const enabled = await this.listEnabled();
    return enabled.length;
  }

  /** One below the deepest rung, or 1 on an empty ladder. */
  private async nextLevel(): Promise<number> {
    const [row] = await this.db
      .select({ deepest: sql<number | null>`max(${ibLevels.level})` })
      .from(ibLevels);
    return (row?.deepest ?? 0) + 1;
  }

  async create(dto: CreateIbLevelDto, actor: Actor) {
    /*
     * OMITTED means "append to the bottom", which is what the console now sends.
     *
     * `max(level) + 1` over every row rather than `count + 1`: a ladder with a
     * gap in it — level 3 deleted from 1,2,3,4 — would otherwise re-mint a
     * number that is already taken and fail on the primary key. Reusing the gap
     * deliberately is still possible by passing `level` explicitly.
     */
    const level = dto.level ?? (await this.nextLevel());

    const existing = await this.findOne(level);
    if (existing) throw new ConflictError(`Level ${level} already exists.`);

    const enabled = dto.enabled ?? true;

    this.assertRateIsSane(dto.rateValue);
    if (enabled) await this.assertShareFits(dto.rateValue, null);

    const [row] = await this.db
      .insert(ibLevels)
      .values({
        level,
        name: dto.name.trim(),
        rateValue: dto.rateValue,
        enabled,
      })
      .returning();

    /*
     * `rateValue` is logged as the STRING it arrived as — §6.1. This is the
     * number that decides what every partner on this rung is paid, and passing
     * it through `Number()` on the way into the log would make the record of a
     * commission rate differ from the commission rate.
     */
    this.audit.record(actor.id, 'ib_level.create', 'ib_level', String(row.level), {
      name: row.name,
      rateValue: row.rateValue,
      enabled: row.enabled,
    });
    return row;
  }

  async update(level: number, dto: UpdateIbLevelDto, actor: Actor) {
    const current = await this.findOne(level);
    if (!current) throw new NotFoundError(`Level ${level} does not exist.`);

    const rateValue = dto.rateValue ?? current.rateValue;
    const enabled = dto.enabled ?? current.enabled;

    this.assertRateIsSane(rateValue);
    if (enabled) await this.assertShareFits(rateValue, level);

    const [row] = await this.db
      .update(ibLevels)
      .set({
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.rateValue !== undefined ? { rateValue: dto.rateValue } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(ibLevels.level, level))
      .returning();

    /*
     * BEFORE and AFTER, for the fields that actually moved.
     *
     * "Who lowered level 3 last quarter" is the question this table's log
     * exists to answer, and the current value answers none of it — by the time
     * anybody asks, the row has been overwritten. Only changed fields are
     * recorded, so a reader is not left comparing eight identical pairs to find
     * the one that moved.
     *
     * `rateValue` is a decimal string on both sides (§6.1).
     */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of ['name', 'rateValue', 'enabled'] as const) {
      if (current[field] !== row[field]) {
        changed[field] = { before: current[field], after: row[field] };
      }
    }
    this.audit.record(actor.id, 'ib_level.update', 'ib_level', String(level), { changed });
    return row;
  }

  /**
   * Remove a level.
   *
   * ⚠️ UNGUARDED AGAINST PARTNERS, temporarily. `ib_accounts` does not exist
   * yet, so there is nothing to check and nothing to orphan. The moment it
   * lands this must refuse a level that partners are placed at — the same shape
   * of guard `CurrenciesService.remove()` needs back, and for the same reason:
   * a delete that succeeds while rows reference it is how a partner loses their
   * position in the ladder silently.
   */
  async remove(level: number, actor: Actor) {
    const current = await this.findOne(level);
    if (!current) throw new NotFoundError(`Level ${level} does not exist.`);

    /*
     * The ladder cannot be emptied. A platform with no levels can approve no
     * partner — the approval flow has nowhere to place them — so this refuses
     * rather than leaving the feature silently inoperable.
     */
    const [{ count }] = await this.db
      .select({ count: countRows() })
      .from(ibLevels)
      .where(ne(ibLevels.level, level));
    if (count === 0) {
      throw new ValidationError(
        'The last level cannot be removed — a platform with no levels can approve no partners.',
      );
    }

    await this.db.delete(ibLevels).where(eq(ibLevels.level, level));

    /*
     * The whole row, because after the DELETE there is nowhere else to read it
     * from. A create can be reconstructed from the current table; a delete
     * cannot be reconstructed from anything.
     */
    this.audit.record(actor.id, 'ib_level.delete', 'ib_level', String(level), {
      name: current.name,
      rateValue: current.rateValue,
      enabled: current.enabled,
    });
    return { level, deleted: true };
  }

  /**
   * Reorder the ladder — the drag-and-drop on the admin screen.
   *
   * ## Why this is two phases rather than n UPDATEs
   *
   * `level` is the PRIMARY KEY, so "swap 1 and 2" renumbers keys rather than
   * changing a sort column, and setting level 2 → 1 while level 1 still exists
   * violates that key. So the rows are first parked in a range nothing else
   * occupies (negatives — the column has no CHECK, and the DTO's `@Min(1)`
   * keeps them unreachable through the API), then brought back down to their
   * new numbers.
   *
   * Partners follow their rung automatically: `ib_accounts.level` is
   * `ON UPDATE CASCADE` (migration 0031) precisely so this is possible. It was
   * written here as an explicit remap first, and there is no statement order
   * that works — the level cannot move while a partner references it, and the
   * partner cannot move to a number that does not exist yet. The database is
   * the only place that can do both at once.
   *
   * One transaction, because a half-applied renumber is a ladder whose rungs do
   * not match the partners standing on them.
   */
  async reorder(order: number[], actor: Actor) {
    const rows = await this.listAll();

    if (order.length !== rows.length) {
      throw new ValidationError(
        `The new order must list every level exactly once — ${rows.length} exist, ${order.length} were given.`,
      );
    }
    const existing = new Set(rows.map((r) => r.level));
    const seen = new Set<number>();
    for (const level of order) {
      if (!existing.has(level)) throw new ValidationError(`Level ${level} does not exist.`);
      if (seen.has(level)) throw new ValidationError(`Level ${level} was listed twice.`);
      seen.add(level);
    }

    // Already in this order: nothing to write, and no reason to churn every
    // partner's FK to produce the state we are in. No audit row either — a log
    // that records a renumber which did not happen describes events that did
    // not occur, which is the same defect as not recording one that did.
    if (order.every((level, index) => level === index + 1)) return this.listAll();

    /*
     * The ladder BEFORE, captured while it still exists.
     *
     * A renumber moves every partner with it (`ib_accounts.level` is ON UPDATE
     * CASCADE), so "which rung was this partner on in March" is answerable only
     * from the old numbering. Read here rather than after the transaction,
     * where it is already gone.
     */
    const before = rows.map((r) => ({ level: r.level, name: r.name, rateValue: r.rateValue }));

    const reordered = await this.db.transaction(async (tx) => {
      // Phase 1 — park every level out of the way, keeping its identity in the
      // sign-flipped number so phase 2 can find it. Partner placements follow
      // via ON UPDATE CASCADE; nothing here touches ib_accounts.
      for (const level of order) {
        await tx.update(ibLevels).set({ level: -level }).where(eq(ibLevels.level, level));
      }

      // Phase 2 — bring them down to their new positions, 1..n in the order
      // given.
      for (const [index, level] of order.entries()) {
        await tx
          .update(ibLevels)
          .set({ level: index + 1, updatedAt: new Date() })
          .where(eq(ibLevels.level, -level));
      }

      return tx.select().from(ibLevels).orderBy(asc(ibLevels.level));
    });

    /*
     * One row for the whole act, not one per rung. The reorder is a single
     * decision an operator made on the ladder — see the PATCH-on-the-collection
     * note above — and n rows would read as n separate edits.
     *
     * The subject is the ladder itself rather than any one level, because every
     * level's number changed.
     */
    this.audit.record(actor.id, 'ib_level.reorder', 'ib_level', 'ladder', {
      before,
      after: reordered.map((r) => ({ level: r.level, name: r.name, rateValue: r.rateValue })),
    });
    return reordered;
  }

  /**
   * A rate must be positive and, under revenue_share, at most 100 on its own.
   *
   * Separate from the cross-level check below because the messages differ: "150%
   * is not a percentage" and "these four levels add up to 130%" are different
   * mistakes, and one message covering both explains neither.
   */
  private assertRateIsSane(rateValue: string): void {
    const rate = new Decimal(rateValue);
    if (rate.isNegative()) throw new ValidationError('A rate cannot be negative.');

    /*
     * Unconditional since 0055. This used to fire only for `revenue_share`,
     * because a per-lot rate is an AMOUNT and 150 per lot is not absurd. Every
     * rate is a percentage now, so a value above 100 is a unit error every
     * time — the operator meant 70, not 7000.
     */
    if (rate.greaterThan(MAX_TOTAL_SHARE)) {
      throw new ValidationError(
        `A revenue share cannot exceed 100% — ${rate.toString()} was given.`,
      );
    }
  }

  /**
   * The enabled revenue_share levels must total at most 100 between them.
   *
   * Here rather than in a database CHECK because a row-level constraint cannot
   * see the other rows, and a trigger would put one rule in two places.
   *
   * `per_lot` levels are excluded from the sum entirely rather than treated as
   * zero: they are amounts, not percentages, and adding a $5 rebate to a 70%
   * share produces a number that means nothing. A ladder mixing the two is
   * unusual but legal, and its percentage half is still bounded.
   *
   * The message names the CURRENT TOTAL and the room left, because "that does
   * not fit" without a number sends the operator to a spreadsheet.
   */
  private async assertShareFits(rateValue: string, excludeLevel: number | null): Promise<void> {
    /*
     * EVERY enabled level counts toward the total since 0055. This used to
     * exempt per-lot rungs — they took no share of the pool, so they could not
     * exhaust it — and with the model gone there is nothing to exempt.
     */
    const others = (await this.listEnabled()).filter((l) => l.level !== excludeLevel);
    const used = others.reduce((sum, l) => sum.plus(new Decimal(l.rateValue)), new Decimal(0));
    const total = used.plus(new Decimal(rateValue));

    if (total.greaterThan(MAX_TOTAL_SHARE)) {
      const room = MAX_TOTAL_SHARE.minus(used);
      throw new ValidationError(
        `The enabled revenue-share levels would total ${total.toString()}%. ` +
          `${used.toString()}% is already allocated, so at most ${room.toString()}% is available.`,
      );
    }
  }
}

/**
 * `count(*)` as an integer.
 *
 * Postgres returns `count` as bigint, which node-postgres hands back as a
 * STRING to avoid a precision loss that cannot happen on a row count. Casting
 * in SQL keeps the comparison above a number comparison rather than `'0' === 0`.
 */
function countRows() {
  return sql<number>`count(*)::int`;
}
