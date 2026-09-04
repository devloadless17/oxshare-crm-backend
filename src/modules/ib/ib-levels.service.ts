import { Inject, Injectable } from '@nestjs/common';
import { asc, count, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { ibAccounts, ibLevels } from '../../database/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import { DEFAULT_REVENUE_BASIS } from '../../common/revenue-basis';
import { ABSOLUTE_IB_MAX_LEVELS } from '../../common/ib-levels';
import type {
  CreateIbLevelDto,
  IbLevelDto,
  IbPayoutMode,
  UpdateIbLevelDto,
} from './dto/ib-level.dto';

type Db = ReturnType<typeof getDb>;
/*
 * `MAX_TOTAL_SHARE` is GONE (0117).
 *
 * It was the configuration-time floor under `checkPlausible`, catching an
 * operator who typed 70 at every rung while they could still fix it. Both
 * retired modes were percentages of ONE revenue figure, so their sum meant
 * something; per-lot amounts are not shares of anything and cannot be summed
 * against a percentage ceiling.
 *
 * The ceiling that still applies is `ib_max_payout_per_lot`, enforced by
 * `checkPlausible` at ACCRUAL time — where the trade's volume is known, which
 * is what a per-lot bound has to compare against.
 */

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
function payoutColumns(amountPerLot: string | null | undefined): {
  mode: IbPayoutMode;
  rate: string;
  amountPerLot: string;
} {
  /*
   * ONE SHAPE since 0117: every rung is a flat amount per standard lot.
   *
   * The `rate` column is still written, as ZERO. It holds the percentage the
   * two retired modes were paid on, and a live-looking percentage sitting
   * beside the amount that actually pays is how somebody reads the wrong number
   * off the row later.
   */
  return { mode: 'per_lot', rate: '0', amountPerLot: amountPerLot ?? '0' };
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
     * `AppSettingsStore` stood here for the ladder ceiling, read fresh on every
     * save so an operator who had just raised it saw the next rung accept. The
     * ceiling went in 0113 and nothing on this service reads a setting now —
     * how deep the ladder goes is decided by the rows in it.
     */
  ) {}

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
        description: ibLevels.description,
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
  limits(): { maxLevels: number; absoluteMaxLevels: number } {
    /*
     * ── THERE IS NO CEILING ANY MORE (0113) ──────────────────────────────
     *
     * `ib_max_levels` capped this and defaulted to 2, so adding a third rung
     * meant first raising a number on the Trading settings tab. This page is
     * the only thing that decides depth now, which is what was asked for.
     *
     * The SHAPE is kept — both numbers still answered, both equal to the
     * structural bound — so the form keeps one contract for "how deep may I
     * go" rather than branching on whether a ceiling exists. It is what the
     * database CHECK and the chain walk actually permit.
     */
    return { maxLevels: ABSOLUTE_IB_MAX_LEVELS, absoluteMaxLevels: ABSOLUTE_IB_MAX_LEVELS };
  }

  async findOne(level: number): Promise<IbLevelDto | null> {
    const rows = await this.listAll();
    return rows.find((row) => row.level === level) ?? null;
  }

  /**
   * A rung must be one the engine can actually pay on.
   *
   * This used to enforce `ib_max_levels`, a configurable ceiling that defaulted
   * to 2 — removed in 0113, because it put a second screen between an operator
   * and a third level for no benefit this page does not already give.
   *
   * What is left is the STRUCTURAL bound, and it is not a commercial one: the
   * chain walk stops at `MAX_CHAIN_DEPTH`, so a rung deeper than that is one no
   * trade could ever reach. Saving it would be accepting a rate that silently
   * pays nobody. (A true cycle in the tree is caught separately by
   * `resolveChain`'s `seen` set, which is independent of any depth number.)
   */
  private assertLevelIsReachable(level: number): void {
    if (level > ABSOLUTE_IB_MAX_LEVELS) {
      throw new ValidationError(
        `Level ${level} is deeper than the commission engine walks (${ABSOLUTE_IB_MAX_LEVELS}), ` +
          'so nobody standing on it could ever be paid. Partners deeper than this earn nothing ' +
          'and the trade pays the rungs above them.',
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
  /*
   * ── `assertShareFits` IS GONE (0117) ──────────────────────────────────────
   *
   * It bounded commission + rebate to 100% while both were shares of the SAME
   * broker revenue, so they added up. Neither can be a percentage any more, so
   * the check could never fail — and a guard that cannot fail reads to the next
   * person as a protection that is in force.
   *
   * The real ceiling on a per-lot rung is `ib_max_payout_per_lot`, enforced by
   * `checkPlausible` at ACCRUAL time. That is where a per-lot bound belongs: it
   * compares against the trade's VOLUME, which nothing on this form can see.
   *
   * Migration 0117 dropped the matching database constraint for the same
   * reason.
   */

  async create(dto: CreateIbLevelDto, actor: Actor): Promise<IbLevelDto> {
    this.assertLevelIsReachable(dto.level);

    const commission = payoutColumns(dto.commissionAmountPerLot);
    const rebate = payoutColumns(dto.rebateAmountPerLot);

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
        description: dto.description ?? null,
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
     * The amount falls back to what is STORED, so a PATCH that changes only the
     * name leaves the rate alone.
     *
     * ⚠️ A rung still on a RETIRED mode has no stored per-lot amount — its
     * money lived in the rate column — so `?? '0'` inside `payoutColumns` would
     * silently zero it. 0117 converted every such rung, so none exist; this
     * refusal is what makes that a fact the code checks rather than assumes.
     */
    if (current.commissionMode !== 'per_lot' && dto.commissionAmountPerLot === undefined) {
      throw new ValidationError(
        `Level ${level} was priced on a model that has been retired. Set a commission amount ` +
          'per lot to bring it up to date.',
      );
    }
    if (current.rebateMode !== 'per_lot' && dto.rebateAmountPerLot === undefined) {
      throw new ValidationError(
        `Level ${level} was priced on a model that has been retired. Set a rebate amount per ` +
          'lot to bring it up to date.',
      );
    }

    const commission = payoutColumns(
      dto.commissionAmountPerLot ?? current.commissionAmountPerLot ?? undefined,
    );
    const rebate = payoutColumns(dto.rebateAmountPerLot ?? current.rebateAmountPerLot ?? undefined);

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
        /* `undefined` leaves it; an explicit null clears it. */
        description: dto.description === undefined ? current.description : dto.description,
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
