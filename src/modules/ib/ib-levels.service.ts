import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { asc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { ibLevels } from '../../database/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import type { CreateIbLevelDto, UpdateIbLevelDto } from './dto/ib-level.dto';

type Db = ReturnType<typeof getDb>;

/** The ceiling on a revenue-share ladder. Percentages of one pool. */
const MAX_TOTAL_SHARE = new Decimal(100);

@Injectable()
export class IbLevelsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

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

  async create(dto: CreateIbLevelDto) {
    const existing = await this.findOne(dto.level);
    if (existing) throw new ConflictError(`Level ${dto.level} already exists.`);

    const payoutModel = dto.payoutModel ?? 'revenue_share';
    const enabled = dto.enabled ?? true;

    this.assertRateIsSane(payoutModel, dto.rateValue);
    if (enabled) await this.assertShareFits(payoutModel, dto.rateValue, null);

    const [row] = await this.db
      .insert(ibLevels)
      .values({
        level: dto.level,
        name: dto.name.trim(),
        payoutModel,
        rateValue: dto.rateValue,
        maxDirectPartners: dto.maxDirectPartners ?? null,
        enabled,
      })
      .returning();
    return row;
  }

  async update(level: number, dto: UpdateIbLevelDto) {
    const current = await this.findOne(level);
    if (!current) throw new NotFoundError(`Level ${level} does not exist.`);

    const payoutModel = dto.payoutModel ?? current.payoutModel;
    const rateValue = dto.rateValue ?? current.rateValue;
    const enabled = dto.enabled ?? current.enabled;

    this.assertRateIsSane(payoutModel, rateValue);
    if (enabled) await this.assertShareFits(payoutModel, rateValue, level);

    const [row] = await this.db
      .update(ibLevels)
      .set({
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.payoutModel !== undefined ? { payoutModel: dto.payoutModel } : {}),
        ...(dto.rateValue !== undefined ? { rateValue: dto.rateValue } : {}),
        ...(dto.maxDirectPartners !== undefined
          ? { maxDirectPartners: dto.maxDirectPartners }
          : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(ibLevels.level, level))
      .returning();
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
  async remove(level: number) {
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
    return { level, deleted: true };
  }

  /**
   * A rate must be positive and, under revenue_share, at most 100 on its own.
   *
   * Separate from the cross-level check below because the messages differ: "150%
   * is not a percentage" and "these four levels add up to 130%" are different
   * mistakes, and one message covering both explains neither.
   */
  private assertRateIsSane(payoutModel: string, rateValue: string): void {
    const rate = new Decimal(rateValue);
    if (rate.isNegative()) throw new ValidationError('A rate cannot be negative.');

    if (payoutModel === 'revenue_share' && rate.greaterThan(MAX_TOTAL_SHARE)) {
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
  private async assertShareFits(
    payoutModel: string,
    rateValue: string,
    excludeLevel: number | null,
  ): Promise<void> {
    if (payoutModel !== 'revenue_share') return;

    const others = (await this.listEnabled()).filter(
      (l) => l.payoutModel === 'revenue_share' && l.level !== excludeLevel,
    );
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
