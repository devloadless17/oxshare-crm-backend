import { Inject, Injectable } from '@nestjs/common';
import { asc, count, eq, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { ibAccounts, ibLevels } from '../../database/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import {
  describeAcrossTerritory,
  outsideTerritoryRemedy,
  territoryCounts,
  type ClientScope,
} from '../../common/security/client-scope';
import { ABSOLUTE_IB_MAX_LEVELS } from '../../common/ib-levels';
import type { CreateIbLevelDto, IbLevelDto, UpdateIbLevelDto } from './dto/ib-level.dto';

type Db = ReturnType<typeof getDb>;

/**
 * The commission ladder — one row per RUNG of the partner tree (0112), each
 * rung a SHARE of the product's commission type (0140).
 *
 * ## What a rung holds now
 *
 * Two percentages: the partner's share of the traded product's commission per
 * lot, and the client's share of its rebate per lot. The amounts themselves
 * live on `ib_commission_types`, assigned to products — so one ladder prices
 * the whole catalogue, and a rung never has to know which product traded.
 *
 * The shares of the rungs in a chain are paid INDEPENDENTLY (0114's rule,
 * kept): on a sub-partner's client's trade, level 2 takes its share and level
 * 1 takes its own in full. There is deliberately no "the shares must add to
 * 100%" check here — their sum is the broker's cost per lot at full depth, and
 * `ib_max_payout_per_lot` bounds that at accrual time where the lot count is
 * known. What IS bounded here is each share on its own: a fraction of one
 * figure cannot exceed the whole of it.
 *
 * ## Nothing here edits money already earned
 *
 * A share change applies to the NEXT trade. Accruals record the share AND the
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
/** "1 partner stands", "3 partners stand". */
const stand = (n: { inScope: number; outside: number }) =>
  n.inScope + n.outside === 1 ? 'stands' : 'stand';

@Injectable()
export class IbLevelsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
  ) {}

  /** A rung's own row — its terms, with no count of who stands on it. */
  private readonly columns = {
    id: ibLevels.id,
    level: ibLevels.level,
    name: ibLevels.name,
    description: ibLevels.description,
    enabled: ibLevels.enabled,
    commissionShare: ibLevels.commissionShare,
    rebateShare: ibLevels.rebateShare,
    createdAt: ibLevels.createdAt,
    updatedAt: ibLevels.updatedAt,
  };

  /**
   * The whole ladder, shallowest rung first, with how many partners stand on
   * each — split by the READER's territory.
   *
   * The count is part of the row rather than a second call: it is what makes a
   * delete refusable in the UI before the database refuses it, and what tells an
   * operator how many people a share change is about to affect.
   *
   * `partnerCount` is the partners the reader may see; `partnersOutsideScope`
   * the rest, counted and never named (D-81 R2). A platform total alone told a
   * scoped desk "42 partners" and then listed 12 of them; a narrowed total alone
   * would have them try to disable a rung they could not empty.
   *
   * Counted by a separate grouped query and merged, not by a correlated
   * subquery in the select list: inside a select-list `sql` template Drizzle
   * renders a column as its bare name, and `WHERE "level" = "level"` once made
   * every rung report the platform's whole partner count.
   */
  async listAll(scope: ClientScope): Promise<IbLevelDto[]> {
    const counts = territoryCounts(scope, ibAccounts.userId);
    const [levels, standing] = await Promise.all([
      this.db.select(this.columns).from(ibLevels).orderBy(asc(ibLevels.level)),
      this.db
        .select({ level: ibAccounts.level, inScope: counts.inScope, outside: counts.outside })
        .from(ibAccounts)
        .groupBy(ibAccounts.level),
    ]);
    const on = new Map(standing.map((row) => [row.level, row]));
    return levels.map((row) => ({
      ...row,
      partnerCount: on.get(row.level)?.inScope ?? 0,
      partnersOutsideScope: on.get(row.level)?.outside ?? 0,
    }));
  }

  /** One rung's terms, for a caller that needs no count (approval, level changes). */
  async findTerms(level: number) {
    const [row] = await this.db
      .select(this.columns)
      .from(ibLevels)
      .where(eq(ibLevels.level, level))
      .limit(1);
    return row ?? null;
  }

  /**
   * What a screen must know before it draws the ladder controls.
   *
   * There is no configurable ceiling any more (0113): how deep the ladder goes
   * is decided by the rows in it. Both numbers answer the structural bound, so
   * the form keeps one contract for "how deep may I go".
   */
  limits(): { maxLevels: number; absoluteMaxLevels: number } {
    return { maxLevels: ABSOLUTE_IB_MAX_LEVELS, absoluteMaxLevels: ABSOLUTE_IB_MAX_LEVELS };
  }

  async findOne(level: number, scope: ClientScope): Promise<IbLevelDto | null> {
    const rows = await this.listAll(scope);
    return rows.find((row) => row.level === level) ?? null;
  }

  /** Everyone standing on a rung, in and outside the reader's territory. */
  private standing(level: IbLevelDto) {
    return { inScope: level.partnerCount, outside: level.partnersOutsideScope };
  }

  /**
   * A rung must be one the engine can actually pay on.
   *
   * The STRUCTURAL bound, not a commercial one: the chain walk stops at
   * `MAX_CHAIN_DEPTH`, so a rung deeper than that is one no trade could ever
   * reach. Saving it would be accepting a share that silently pays nobody.
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
   * A share is a fraction of ONE figure on the product, so it cannot exceed
   * the whole of it.
   *
   * Named separately from `ib_levels_*_share_range` because a constraint
   * violation reaches an operator as a 500 with a Postgres string in it. This
   * one says which number was too big.
   *
   * Compared with decimal.js, never `Number()`: the value multiplies money one
   * call later (§6.1).
   */
  private assertShareFits(label: string, share: string): void {
    if (new Decimal(share).greaterThan(100)) {
      throw new ValidationError(
        `${label} is ${share}%, and a share of the product's figure cannot exceed 100% of it.`,
      );
    }
  }

  async create(dto: CreateIbLevelDto, actor: Actor): Promise<IbLevelDto> {
    this.assertLevelIsReachable(dto.level);

    const commissionShare = dto.commissionShare ?? '0';
    const rebateShare = dto.rebateShare ?? '0';
    this.assertShareFits('The commission share', commissionShare);
    this.assertShareFits('The rebate share', rebateShare);

    if (await this.findTerms(dto.level)) {
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
        commissionShare,
        rebateShare,
        enabled: dto.enabled ?? true,
      })
      .returning();

    this.audit.record(actor.id, 'ib_level.create', 'ib_level', created.id, {
      level: created.level,
      name: created.name,
      commissionShare: created.commissionShare,
      rebateShare: created.rebateShare,
      enabled: created.enabled,
    });

    return { ...created, partnerCount: 0, partnersOutsideScope: 0 };
  }

  async update(
    level: number,
    dto: UpdateIbLevelDto,
    actor: Actor,
    scope: ClientScope,
  ): Promise<IbLevelDto> {
    const current = await this.findOne(level, scope);
    if (!current) throw new NotFoundError(`Level ${level} does not exist.`);

    /* Omitted means LEAVE IT — a PATCH that changes only the name leaves the
       shares alone. */
    const commissionShare = dto.commissionShare ?? current.commissionShare;
    const rebateShare = dto.rebateShare ?? current.rebateShare;
    this.assertShareFits('The commission share', commissionShare);
    this.assertShareFits('The rebate share', rebateShare);

    /*
     * DISABLING a rung partners stand on is refused.
     *
     * A disabled rung pays nothing, so this would stop every partner on it
     * earning — silently, from their side, with their referral links still
     * working. Move them first; the refusal says how many there are — and how
     * many of them the reader cannot move themselves (D-81 R2).
     */
    const standing = this.standing(current);
    if (dto.enabled === false && current.enabled && standing.inScope + standing.outside > 0) {
      throw new ConflictError(
        `${describeAcrossTerritory(standing, 'partner', 'partners')} ${stand(standing)} on ` +
          `level ${level}, and a disabled level stops paying. Move them to another level first.` +
          outsideTerritoryRemedy(standing.outside),
      );
    }

    const [updated] = await this.db
      .update(ibLevels)
      .set({
        name: dto.name ?? current.name,
        /* `undefined` leaves it; an explicit null clears it. */
        description: dto.description === undefined ? current.description : dto.description,
        commissionShare,
        rebateShare,
        enabled: dto.enabled ?? current.enabled,
        updatedAt: new Date(),
      })
      .where(eq(ibLevels.level, level))
      .returning();

    this.audit.record(actor.id, 'ib_level.update', 'ib_level', updated.id, {
      before: {
        name: current.name,
        commissionShare: current.commissionShare,
        rebateShare: current.rebateShare,
        enabled: current.enabled,
      },
      after: {
        name: updated.name,
        commissionShare: updated.commissionShare,
        rebateShare: updated.rebateShare,
        enabled: updated.enabled,
      },
    });

    return {
      ...updated,
      partnerCount: current.partnerCount,
      partnersOutsideScope: current.partnersOutsideScope,
    };
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
  async remove(level: number, actor: Actor, scope: ClientScope) {
    const current = await this.findOne(level, scope);
    if (!current) throw new NotFoundError(`Level ${level} does not exist.`);

    if (level === 1) {
      throw new ConflictError(
        'Level 1 cannot be removed — every partner chain starts there, so the ladder would stop ' +
          'paying entirely. Disable it if the broker has suspended partner commission.',
      );
    }

    const standing = this.standing(current);
    if (standing.inScope + standing.outside > 0) {
      throw new ConflictError(
        `${describeAcrossTerritory(standing, 'partner', 'partners')} ${stand(standing)} on ` +
          `level ${level}. Move them to another level before deleting it.` +
          outsideTerritoryRemedy(standing.outside),
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
      commissionShare: current.commissionShare,
      rebateShare: current.rebateShare,
    });

    return { deleted: true };
  }
}
