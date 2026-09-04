import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { asc, count, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { ibAccounts, ibLevels } from '../../database/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import { AppSettingsStore } from '../../store/app-settings.store';
import { DEFAULT_REVENUE_BASIS } from '../../common/revenue-basis';
import { tradingTermsFrom } from '../../common/trading-terms';
import { ABSOLUTE_IB_MAX_LEVELS } from '../../common/ib-levels';
import type {
  CreateIbLevelDto,
  IbLevelDto,
  IbPayoutMode,
  UpdateIbLevelDto,
} from './dto/ib-level.dto';

type Db = ReturnType<typeof getDb>;

/**
 * The most of one trade's revenue a single RUNG may hand out.
 *
 * Its commission and its rebate are shares of the same number, so they add.
 *
 * ⚠️ This bounds ONE RUNG, which is narrower than it looks. On a single trade
 * the earners stand on DIFFERENT rungs — the introducer's, their parent's — so
 * no per-rung rule can bound what one trade pays out in total. That guarantee is
 * `checkPlausible` in the engine, which REFUSES an accrual set exceeding the
 * revenue. This is the configuration-time floor: it catches the operator typing
 * 70 at every rung, while they can still fix it.
 */
const MAX_TOTAL_SHARE = new Decimal(100);

/**
 * The columns a term actually reads, from its mode — mirrors
 * `ib_levels_commission_shape` and `ib_levels_rebate_shape`.
 *
 * The constraint requires exactly the column the mode reads and FORBIDS the
 * other, so the unused one is NULLed explicitly rather than left to a default:
 * an update switching a rung from percent to per-lot has to clear the rate it is
 * no longer paid on, or the row is refused.
 *
 * The unused RATE is zeroed rather than kept for the same reason a per-lot rate
 * is not stored: a live-looking percentage sitting beside the amount that
 * actually pays is how somebody reads the wrong number off the row later, and it
 * would also inflate `ib_levels_share_fits` with a figure nobody is paid.
 */
function payoutColumns(
  mode: IbPayoutMode,
  rate: string,
  amountPerLot: string | null | undefined,
): { mode: IbPayoutMode; rate: string; amountPerLot: string | null } {
  if (mode === 'per_lot') {
    return { mode: 'per_lot', rate: '0', amountPerLot: amountPerLot ?? '0' };
  }
  return { mode: 'percent', rate, amountPerLot: null };
}

/**
 * The commission ladder — one row per RUNG of the partner tree (0112).
 *
 * ## What replaced the programme catalogue, and why
 *
 * A programme was a card assigned to a partner, keyed on DEPTH: how many hops
 * the trade sat below the earner. A level is keyed on the earner's own POSITION:
 * a partner dealing with the broker directly is level 1, a partner they recruit
 * is level 2. The business asked for a static per-lot figure for the main
 * partner and a percentage for the partner beneath them, with a sub-partner
 * earning nothing from their parent's clients while the parent still earns from
 * clients under the sub-partner — and that asymmetry is a property of the tree,
 * so it belongs to where somebody stands rather than to what they hold.
 *
 * The chain walk is unchanged. `resolveChain` still climbs `parent_ib_user_id`
 * upward from the client's introducer, so a sub-partner never appears in their
 * parent's own clients' chains at all — the first rule holds by construction
 * rather than by a rate.
 *
 * ## Nothing here edits money already earned
 *
 * A rate change applies to the NEXT trade. Accruals record the rate AND the
 * rung that priced them (`ib_accruals.rate_value`, `ib_accruals.level_id`), so
 * re-reading a level can never restate what a partner was already paid — which
 * is why editing one is an ordinary update rather than something that has to
 * reason about history.
 *
 * ## Reads are `ib.view`, writes are `ib.levels.*`
 *
 * An operator trusted to READ the ladder is not automatically trusted to change
 * what every partner on it earns.
 */
@Injectable()
export class IbLevelsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
    /*
     * The ladder ceiling. Read fresh on every save rather than cached: an
     * operator who has just raised it should see the next rung accept, not wait
     * out a TTL on the one screen where the refusal is the whole feedback.
     */
    private readonly settings: AppSettingsStore,
  ) {}

  /** The configured ceiling, or the committed two. */
  private async maxLevels(): Promise<number> {
    return tradingTermsFrom(await this.settings.getTrading()).ibMaxLevels;
  }

  /**
   * The whole ladder, shallowest rung first, with how many partners stand on
   * each.
   *
   * The count is part of the row rather than a second call: it is what makes a
   * delete refusable in the UI before the database refuses it, and what tells an
   * operator how many people a rate change is about to affect.
   */
  async listAll(): Promise<IbLevelDto[]> {
    return this.db
      .select({
        id: ibLevels.id,
        level: ibLevels.level,
        name: ibLevels.name,
        enabled: ibLevels.enabled,
        commissionMode: ibLevels.commissionMode,
        commissionRate: ibLevels.commissionRate,
        commissionAmountPerLot: ibLevels.commissionAmountPerLot,
        rebateMode: ibLevels.rebateMode,
        rebateRate: ibLevels.rebateRate,
        rebateAmountPerLot: ibLevels.rebateAmountPerLot,
        revenueBasis: ibLevels.revenueBasis,
        createdAt: ibLevels.createdAt,
        updatedAt: ibLevels.updatedAt,
        partnerCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${ibAccounts} WHERE ${ibAccounts.level} = ${ibLevels.level}
        )`,
      })
      .from(ibLevels)
      .orderBy(asc(ibLevels.level));
  }

  /**
   * What a screen must know before it draws the ladder controls.
   *
   * Read rather than assumed by the console: a hardcoded copy is the drift this
   * setting exists to prevent.
   */
  async limits(): Promise<{ maxLevels: number; absoluteMaxLevels: number }> {
    return { maxLevels: await this.maxLevels(), absoluteMaxLevels: ABSOLUTE_IB_MAX_LEVELS };
  }

  async findOne(level: number): Promise<IbLevelDto | null> {
    const rows = await this.listAll();
    return rows.find((row) => row.level === level) ?? null;
  }

  /**
   * A rung must fit under the ceiling the broker agreed to.
   *
   * `ib_levels_level_range` is deliberately wider at 10, so raising how deep a
   * broker pays is a form somebody fills in rather than a migration somebody
   * writes. This is the number an operator is actually held to.
   *
   * The message names the ceiling AND where to change it, because "at most 2
   * levels" with no source reads as a hard product limit somebody would file a
   * bug about rather than a setting they already control.
   */
  private assertLevelFitsCeiling(level: number, maxLevels: number): void {
    if (level > maxLevels) {
      throw new ValidationError(
        `The ladder reaches ${maxLevels} level(s) and level ${level} is deeper than that. Raise ` +
          '"Maximum commission levels" on the Trading settings tab if the broker has agreed to ' +
          'pay deeper.',
      );
    }
  }

  /**
   * Refuse terms that hand out more of a trade than the broker earned.
   *
   * Named separately from `ib_levels_share_fits` because a constraint violation
   * reaches an operator as a 500 with a Postgres string in it. This one says
   * which numbers were involved and what they add up to.
   *
   * PERCENTAGES only. "These add up to more than 100% of the revenue" is a
   * statement about shares, and a per-lot term is not a share of anything: $10 a
   * lot has no meaningful sum with 30%. Per-lot legs are bounded instead at
   * ACCRUAL time by `ib_max_payout_per_lot`, where the lot count is known.
   */
  private assertShareFits(
    commission: { mode: IbPayoutMode; rate: string },
    rebate: { mode: IbPayoutMode; rate: string },
  ): void {
    const commissionShare =
      commission.mode === 'percent' ? new Decimal(commission.rate) : new Decimal(0);
    const rebateShare = rebate.mode === 'percent' ? new Decimal(rebate.rate) : new Decimal(0);
    const total = commissionShare.plus(rebateShare);

    if (total.greaterThan(MAX_TOTAL_SHARE)) {
      throw new ValidationError(
        `These terms pay out ${total.toString()}% of the broker's revenue on a trade — ` +
          `${commissionShare.toString()}% to the partner and ${rebateShare.toString()}% back to ` +
          'the client. Both are a share of the same revenue, so they add up; the total cannot ' +
          'exceed 100%.',
      );
    }
  }

  async create(dto: CreateIbLevelDto, actor: Actor): Promise<IbLevelDto> {
    this.assertLevelFitsCeiling(dto.level, await this.maxLevels());

    const commission = payoutColumns(
      dto.commissionMode ?? 'percent',
      dto.commissionRate ?? '0',
      dto.commissionAmountPerLot,
    );
    const rebate = payoutColumns(
      dto.rebateMode ?? 'percent',
      dto.rebateRate ?? '0',
      dto.rebateAmountPerLot,
    );
    this.assertShareFits(commission, rebate);

    if (await this.findOne(dto.level)) {
      throw new ConflictError(
        `Level ${dto.level} already exists. A level IS its number, so edit that one rather than ` +
          'adding a second.',
      );
    }

    const [created] = await this.db
      .insert(ibLevels)
      .values({
        level: dto.level,
        name: dto.name,
        commissionMode: commission.mode,
        commissionRate: commission.rate,
        commissionAmountPerLot: commission.amountPerLot,
        rebateMode: rebate.mode,
        rebateRate: rebate.rate,
        rebateAmountPerLot: rebate.amountPerLot,
        /*
         * Defaulted to the charges basis rather than to whatever was last used:
         * the other two can only pay LESS on a deployment whose spread markups
         * are unset, and a rung quietly pricing on an unpopulated markup pays
         * nothing on every deal it touches.
         */
        revenueBasis: dto.revenueBasis ?? DEFAULT_REVENUE_BASIS,
        enabled: dto.enabled ?? true,
      })
      .returning();

    this.audit.record(actor.id, 'ib_level.create', 'ib_level', created.id, {
      level: created.level,
      name: created.name,
      commissionMode: created.commissionMode,
      commissionRate: created.commissionRate,
      commissionAmountPerLot: created.commissionAmountPerLot,
      rebateMode: created.rebateMode,
      rebateRate: created.rebateRate,
      rebateAmountPerLot: created.rebateAmountPerLot,
      revenueBasis: created.revenueBasis,
      enabled: created.enabled,
    });

    return { ...created, partnerCount: 0 };
  }

  async update(level: number, dto: UpdateIbLevelDto, actor: Actor): Promise<IbLevelDto> {
    const current = await this.findOne(level);
    if (!current) throw new NotFoundError(`Level ${level} does not exist.`);

    /*
     * The mode falls back to what is STORED, not to `percent`. A PATCH that
     * changes only the name must not quietly re-price a per-lot rung back onto a
     * percentage nobody configured.
     */
    const commission = payoutColumns(
      dto.commissionMode ?? current.commissionMode,
      dto.commissionRate ?? current.commissionRate,
      dto.commissionAmountPerLot ?? current.commissionAmountPerLot ?? undefined,
    );
    const rebate = payoutColumns(
      dto.rebateMode ?? current.rebateMode,
      dto.rebateRate ?? current.rebateRate,
      dto.rebateAmountPerLot ?? current.rebateAmountPerLot ?? undefined,
    );
    this.assertShareFits(commission, rebate);

    /*
     * DISABLING a rung partners stand on is refused.
     *
     * A disabled rung pays nothing, so this would stop every partner on it
     * earning — silently, from their side, with their referral links still
     * working. Move them first; the refusal says how many there are.
     */
    if (dto.enabled === false && current.enabled && current.partnerCount > 0) {
      throw new ConflictError(
        `${current.partnerCount} partner(s) stand on level ${level}, and a disabled level stops ` +
          'paying. Move them to another level first.',
      );
    }

    const [updated] = await this.db
      .update(ibLevels)
      .set({
        name: dto.name ?? current.name,
        commissionMode: commission.mode,
        commissionRate: commission.rate,
        commissionAmountPerLot: commission.amountPerLot,
        rebateMode: rebate.mode,
        rebateRate: rebate.rate,
        rebateAmountPerLot: rebate.amountPerLot,
        /* Omitted means LEAVE IT — re-pricing a rung is never something an
         * operator did by not mentioning it. */
        revenueBasis: dto.revenueBasis ?? current.revenueBasis,
        enabled: dto.enabled ?? current.enabled,
        updatedAt: new Date(),
      })
      .where(eq(ibLevels.level, level))
      .returning();

    this.audit.record(actor.id, 'ib_level.update', 'ib_level', updated.id, {
      before: {
        name: current.name,
        commissionMode: current.commissionMode,
        commissionRate: current.commissionRate,
        commissionAmountPerLot: current.commissionAmountPerLot,
        rebateMode: current.rebateMode,
        rebateRate: current.rebateRate,
        rebateAmountPerLot: current.rebateAmountPerLot,
        revenueBasis: current.revenueBasis,
        enabled: current.enabled,
      },
      after: {
        name: updated.name,
        commissionMode: updated.commissionMode,
        commissionRate: updated.commissionRate,
        commissionAmountPerLot: updated.commissionAmountPerLot,
        rebateMode: updated.rebateMode,
        rebateRate: updated.rebateRate,
        rebateAmountPerLot: updated.rebateAmountPerLot,
        revenueBasis: updated.revenueBasis,
        enabled: updated.enabled,
      },
    });

    return { ...updated, partnerCount: current.partnerCount };
  }

  /**
   * Remove a rung.
   *
   * Refused while anybody stands on it: those partners would be left reading
   * terms that no longer exist, which `calculate` treats as "not configured" and
   * pays nothing on.
   *
   * Level 1 is refused outright. Every chain starts there — a partner dealing
   * with the broker directly is level 1 by definition — so deleting it stops the
   * whole ladder paying rather than shortening it.
   *
   * `ib_accruals.level_id` is ON DELETE RESTRICT, so a rung that has ever paid
   * anybody cannot be deleted at all. That refusal reaches an operator as a
   * 500, which is why the two checks above catch the cases somebody can act on.
   */
  async remove(level: number, actor: Actor) {
    const current = await this.findOne(level);
    if (!current) throw new NotFoundError(`Level ${level} does not exist.`);

    if (level === 1) {
      throw new ConflictError(
        'Level 1 cannot be removed — every partner chain starts there, so the ladder would stop ' +
          'paying entirely. Disable it if the broker has suspended partner commission.',
      );
    }

    if (current.partnerCount > 0) {
      throw new ConflictError(
        `${current.partnerCount} partner(s) stand on level ${level}. Move them to another level ` +
          'before deleting it.',
      );
    }

    const [{ value: deeper }] = await this.db
      .select({ value: count() })
      .from(ibLevels)
      .where(sql`${ibLevels.level} > ${level}`);

    if (deeper > 0) {
      throw new ConflictError(
        `Level ${level} sits above ${deeper} deeper level(s). Removing it would leave a gap, and ` +
          'the ladder has to run 1, 2, 3 … with none — delete the deepest level first.',
      );
    }

    await this.db.delete(ibLevels).where(eq(ibLevels.level, level));

    this.audit.record(actor.id, 'ib_level.delete', 'ib_level', current.id, {
      level: current.level,
      name: current.name,
      commissionMode: current.commissionMode,
      commissionRate: current.commissionRate,
      commissionAmountPerLot: current.commissionAmountPerLot,
      rebateMode: current.rebateMode,
      rebateRate: current.rebateRate,
      rebateAmountPerLot: current.rebateAmountPerLot,
    });

    return { deleted: true };
  }
}
