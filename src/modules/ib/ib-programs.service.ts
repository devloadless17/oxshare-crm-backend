import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { ibAccounts, ibProgramTiers, ibPrograms } from '../../database/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import { AppSettingsStore } from '../../store/app-settings.store';
import { DEFAULT_REVENUE_BASIS } from '../../common/revenue-basis';
import { tradingTermsFrom } from '../../common/trading-terms';
import type {
  CreateIbProgramDto,
  IbProgramDto,
  IbProgramTierDto,
  UpdateIbProgramDto,
} from './dto/ib-program.dto';

type Db = ReturnType<typeof getDb>;

/**
 * The most of one trade's revenue a single programme may hand out.
 *
 * Every leg is a share of the SAME number, so they add: 70 at depth 1 + 30 at
 * depth 2 + a 10 rebate is 110% of what the house kept.
 *
 * ⚠️ This bounds ONE PROGRAMME, which is narrower than it looks. On a single
 * trade the earners may hold DIFFERENT programmes — the introducer's depth-1
 * tier, their parent's depth-2 tier, the introducer's rebate — so no
 * per-programme rule can bound what one trade pays out in total. That guarantee
 * is `checkPlausible` in the engine, which REFUSES an accrual set exceeding the
 * revenue. (A broker-side cap that scaled the legs to fit used to sit beside
 * it; it was removed at the operator's request.)
 *
 * This is the configuration-time floor: it catches the operator typing 70 at
 * every depth, while they can still fix it.
 */
/**
 * A tier's payout columns, from its mode — 0111.
 *
 * One place rather than two, because create and update write the same rows and
 * a mode honoured on only one of them is a programme that changes shape when it
 * is edited.
 *
 * `ib_program_tiers_payout_shape` requires exactly the column the mode reads and
 * forbids the other, so this NULLS the unused one explicitly rather than leaving
 * it to a default — an update switching a tier from percent to per-lot has to
 * clear the rate it is no longer paid on, or the row is refused.
 */
function tierPayout(tier: IbProgramTierDto): {
  payoutMode: 'percent' | 'per_lot';
  rate: string;
  amountPerLot: string | null;
} {
  if (tier.payoutMode === 'per_lot') {
    return {
      payoutMode: 'per_lot',
      /*
       * Zero, not the submitted rate. The CHECK permits any rate in this mode,
       * but storing a live-looking percentage beside an amount that is what
       * actually pays is how somebody reads the wrong number off the row later.
       * It also keeps the per-programme share trigger honest: a per-lot tier
       * contributes nothing to a sum of percentages.
       */
      rate: '0',
      amountPerLot: tier.amountPerLot ?? '0',
    };
  }

  return { payoutMode: 'percent', rate: tier.rate, amountPerLot: null };
}

/**
 * The programme's rebate columns, from its mode — 0111. Mirrors `tierPayout`.
 *
 * `ib_programs_rebate_shape` forbids an amount in percent mode and requires one
 * in per-lot mode, so the unused column is NULLed explicitly rather than left to
 * a default — switching a programme back to percentages has to clear the amount
 * or the row is refused.
 */
function rebatePayout(
  mode: 'percent' | 'per_lot' | undefined,
  amountPerLot: string | undefined,
  rebateRate: string,
): { rebateMode: 'percent' | 'per_lot'; rebateRate: string; rebateAmountPerLot: string | null } {
  if (mode === 'per_lot') {
    return {
      rebateMode: 'per_lot',
      /*
       * Zeroed for the reason `tierPayout` zeroes a rate: a live-looking
       * percentage stored beside the amount that actually pays is how the wrong
       * number gets read off the row, and it would also inflate the share
       * trigger's sum with a figure nobody is paid.
       */
      rebateRate: '0',
      rebateAmountPerLot: amountPerLot ?? '0',
    };
  }

  return { rebateMode: 'percent', rebateRate, rebateAmountPerLot: null };
}

const MAX_TOTAL_SHARE = new Decimal(100);

/**
 * Named IB programmes — FR-ADM-10's "commission plans", and the record FR-IB-05,
 * FR-IB-06 and FR-IB-17 are all written against.
 *
 * ## One catalogue, and the tier ladder lives inside it
 *
 * FR-IB-06 asks for "an administrable catalogue of named IB programs (a tier
 * ladder), each defining a name, ordering position, commission and rebate
 * values, and a mode, and each flagged as selectable" — and says a programme
 * replaces "any per-partner bespoke plan". FR-IB-17 adds that the per-level
 * split is "configured per the agreed program ladder".
 *
 * So a programme is a HEADER (`ib_programs`) plus its LADDER
 * (`ib_program_tiers`, one row per depth). The row count is how far its
 * holder's earnings reach: three tiers pays on own clients, sub-partners' and
 * sub-sub-partners', and stops. Extending a programme by a level is inserting a
 * row, not editing a constant — which is what FR-IB-16 means by the agreed
 * method being CONFIGURED.
 *
 * `ib_levels`, the rung-keyed second catalogue this used to sit beside, was
 * dropped in 0102. See the IB block header in `database/schema.ts`.
 *
 * ## Nothing here edits money that has already been earned
 *
 * A rate change applies to the NEXT trade. Accruals record the rate AND the
 * programme they were calculated under (`ib_accruals.rate_value`,
 * `ib_accruals.program_id`), so re-reading a programme can never restate what a
 * partner was already paid — which is why editing one is an ordinary update
 * rather than something that has to reason about history.
 */
@Injectable()
export class IbProgramsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
    /*
     * The ladder ceiling. Read fresh on every save rather than cached: an
     * operator who has just raised it should see the next programme accept the
     * extra level, not wait out a TTL on the one screen where the refusal is
     * the whole feedback.
     */
    private readonly settings: AppSettingsStore,
  ) {}

  /** The configured ceiling, or the committed two. */
  private async maxLevels(): Promise<number> {
    return tradingTermsFrom(await this.settings.getTrading()).ibMaxLevels;
  }

  /**
   * Every programme, with its ladder and how many partners stand on each.
   *
   * The count is part of the row rather than a second call: it is what makes a
   * delete refusable in the UI before the database refuses it, and what tells an
   * operator how many people a rate change is about to affect.
   */
  async listAll(): Promise<IbProgramDto[]> {
    const rows = await this.db
      .select({
        id: ibPrograms.id,
        name: ibPrograms.name,
        sortOrder: ibPrograms.sortOrder,
        mode: ibPrograms.mode,
        revenueBasis: ibPrograms.revenueBasis,
        rebateRate: ibPrograms.rebateRate,
        rebateMode: ibPrograms.rebateMode,
        rebateAmountPerLot: ibPrograms.rebateAmountPerLot,
        enabled: ibPrograms.enabled,
        createdAt: ibPrograms.createdAt,
        updatedAt: ibPrograms.updatedAt,
        partnerCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${ibAccounts} WHERE ${ibAccounts.programId} = ${ibPrograms.id}
        )`,
      })
      .from(ibPrograms)
      .orderBy(asc(ibPrograms.sortOrder), asc(ibPrograms.name));

    if (rows.length === 0) return [];

    /*
     * One read for every ladder, not one per programme. The catalogue is small,
     * but this is the list endpoint an operator refreshes while editing rates,
     * and an N+1 here is the kind that only shows up once a broker has built
     * their tenth programme.
     */
    const tiers = await this.tiersFor(rows.map((row) => row.id));

    return rows.map((row) => ({ ...row, tiers: tiers.get(row.id) ?? [] }));
  }

  /** Ladders for the given programmes, each sorted shallowest depth first. */
  private async tiersFor(ids: string[]): Promise<Map<string, IbProgramTierDto[]>> {
    const rows = await this.db
      .select()
      .from(ibProgramTiers)
      .where(inArray(ibProgramTiers.programId, ids))
      .orderBy(asc(ibProgramTiers.depth));

    const byProgram = new Map<string, IbProgramTierDto[]>();
    for (const row of rows) {
      const list = byProgram.get(row.programId) ?? [];
      list.push({ depth: row.depth, rate: row.rate });
      byProgram.set(row.programId, list);
    }
    return byProgram;
  }

  /**
   * What a screen must know before it draws the ladder controls.
   *
   * Read rather than assumed by the console — see `IbProgramLimitsDto` for why
   * a hardcoded copy is the drift this setting exists to prevent.
   */
  async limits(): Promise<{ maxLevels: number }> {
    return { maxLevels: await this.maxLevels() };
  }

  /** The header alone. Callers needing the ladder use `findOneWithTiers`. */
  async findOne(id: string) {
    const [row] = await this.db.select().from(ibPrograms).where(eq(ibPrograms.id, id)).limit(1);
    return row ?? null;
  }

  async findOneWithTiers(id: string): Promise<IbProgramDto | null> {
    const row = await this.findOne(id);
    if (!row) return null;

    const [tiers, partnerCount] = await Promise.all([this.tiersFor([id]), this.partnerCount(id)]);

    return { ...row, partnerCount, tiers: tiers.get(id) ?? [] };
  }

  /**
   * A ladder must be CONTIGUOUS from depth 1, with no repeats.
   *
   * The row count is how far a programme reaches, so a gap is not a smaller
   * ladder — it is an unanswerable one. Tiers at 1 and 3 claim a reach of three
   * levels while paying nothing at 2, and the depth-2 partner is skipped with a
   * message about their programme not reaching them, which is not what happened.
   *
   * Enforced here rather than in a CHECK because a constraint cannot see the
   * other rows of its own table, and a trigger would put one rule in two places.
   */
  private assertLadderIsWellFormed(tiers: IbProgramTierDto[], maxLevels: number): void {
    const depths = tiers.map((tier) => tier.depth);
    const unique = new Set(depths);

    if (unique.size !== depths.length) {
      throw new ValidationError(
        'A programme cannot pay two different rates at the same depth. Each level appears once.',
      );
    }

    const sorted = [...depths].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length; index += 1) {
      if (sorted[index] !== index + 1) {
        throw new ValidationError(
          `Levels must run 1, 2, 3 … with no gaps — ${sorted.join(', ')} was given. The number ` +
            'of levels is how far this programme pays, so a gap would claim a reach it does ' +
            'not have.',
        );
      }
    }

    /*
     * The POLICY bound, not the structural one.
     *
     * `trading_settings.ib_max_levels` defaults to 2 — Feature List Rev 9
     * IB-17, "no level beyond L2" — and `ib_program_tiers_depth_range` is
     * deliberately wider at 10, so that raising the ceiling is a form somebody
     * fills in rather than a migration somebody writes. This is the number an
     * operator is actually held to; the column holds what the engine can pay.
     *
     * The message names the ceiling AND where to change it, because "at most 2
     * levels" with no source reads as a hard product limit somebody would file
     * a bug about rather than a setting they already control.
     */
    if (tiers.length > maxLevels) {
      throw new ValidationError(
        `A programme may reach at most ${maxLevels} level(s) and ${tiers.length} were given. ` +
          'Raise "Maximum commission levels" on the Trading settings tab if the broker has ' +
          'agreed to pay deeper.',
      );
    }

    for (const tier of tiers) {
      const rate = new Decimal(tier.rate);
      if (!rate.greaterThan(0)) {
        throw new ValidationError(
          `Level ${tier.depth} pays ${tier.rate}%. A level that pays nothing should be removed ` +
            'rather than set to zero — the number of levels is what decides how far this ' +
            'programme reaches.',
        );
      }
      if (rate.greaterThan(MAX_TOTAL_SHARE)) {
        throw new ValidationError(
          `A revenue share cannot exceed 100% — level ${tier.depth} was given ${tier.rate}.`,
        );
      }
    }
  }

  /**
   * Refuse a set of terms that pays out more than the broker earned.
   *
   * Named separately from the database trigger because a trigger violation
   * reaches an operator as a 500 with a Postgres string in it. This one says
   * which numbers were involved and what they add up to.
   */
  private assertShareFits(tiers: IbProgramTierDto[], rebate: string): void {
    /*
     * PERCENTAGE tiers only — 0111.
     *
     * "These add up to more than 100% of the revenue" is a statement about
     * shares, and a per-lot tier is not a share of anything: $10 a lot has no
     * meaningful sum with 30%. Including one here would either refuse an honest
     * mixed rate card or compare an amount against a percentage, both of which
     * are worse than not checking it.
     *
     * Per-lot legs are bounded instead at ACCRUAL time by
     * `ib_max_payout_per_lot`, where the lot count is actually known — see
     * `checkPlausible`. The database trigger `ib_programs_share_fits` makes the
     * same split for the same reason: a per-lot tier stores `rate = 0` and so
     * contributes nothing to its sum.
     */
    const shareTiers = tiers.filter((tier) => tier.payoutMode !== 'per_lot');
    const commission = shareTiers.reduce((sum, tier) => sum.plus(tier.rate), new Decimal(0));
    const total = commission.plus(rebate);

    if (total.greaterThan(MAX_TOTAL_SHARE)) {
      const legs = shareTiers.map((tier) => `${tier.rate}% at level ${tier.depth}`).join(', ');
      throw new ValidationError(
        `These terms pay out ${total.toString()}% of the broker's revenue on a trade — ` +
          `${legs || 'no commission levels'} and ${rebate}% back to the client. Every leg is a ` +
          'share of the same revenue, so they add up; the total cannot exceed 100%.',
      );
    }
  }

  /**
   * A programme must be able to pay somebody.
   *
   * `commission_only` with no levels, or `rebate_only` with no rebate, is a set
   * of terms that pays nobody — configuration an operator can save, assign, and
   * then spend a week wondering about. The engine skips it and says so in a log;
   * this refuses it where somebody can still fix it.
   */
  private assertModeIsPayable(mode: string, tiers: IbProgramTierDto[], rebate: string): void {
    const rebateAmount = new Decimal(rebate);

    if (mode === 'rebate_only') {
      if (rebateAmount.isZero()) {
        throw new ValidationError(
          'A rebate-only programme with a zero rebate pays nobody at all — neither the partner ' +
            'nor the client. Set a rebate rate, or choose another mode.',
        );
      }
      /*
       * Tiers on a `rebate_only` programme are refused rather than ignored.
       * `calculate` skips the commission legs outright on this mode, so a saved
       * ladder here is a rate card that never pays — and the operator who typed
       * it has no way to tell that from one that does.
       */
      if (tiers.length > 0) {
        throw new ValidationError(
          'A rebate-only programme pays the trading client and no partner, so its commission ' +
            'levels would never pay. Remove them, or choose `hybrid` to pay both.',
        );
      }
      return;
    }

    if (tiers.length === 0 && rebateAmount.isZero()) {
      throw new ValidationError(
        'These terms pay nothing: there are no commission levels and no rebate. Add at least ' +
          'one level, or disable the programme instead.',
      );
    }

    if (mode === 'commission_only' && tiers.length === 0) {
      throw new ValidationError(
        'A commission-only programme with no levels pays no partner at any depth. Add at least ' +
          'one level, or choose another mode.',
      );
    }
  }

  /** One below the last, or 0 on an empty catalogue. */
  private async nextSortOrder(): Promise<number> {
    const [row] = await this.db
      .select({ last: sql<number | null>`max(${ibPrograms.sortOrder})` })
      .from(ibPrograms);
    return (row?.last ?? -1) + 1;
  }

  async create(dto: CreateIbProgramDto, actor: Actor): Promise<IbProgramDto> {
    const tiers = dto.tiers ?? [];
    const rebateRate = dto.rebateRate ?? '0';
    const mode = dto.mode ?? 'commission_only';

    this.assertLadderIsWellFormed(tiers, await this.maxLevels());
    this.assertShareFits(tiers, rebateRate);
    this.assertModeIsPayable(mode, tiers, rebateRate);

    const [existing] = await this.db
      .select({ id: ibPrograms.id })
      .from(ibPrograms)
      .where(eq(ibPrograms.name, dto.name))
      .limit(1);
    if (existing) throw new ConflictError(`A programme called "${dto.name}" already exists.`);

    const sortOrder = dto.sortOrder ?? (await this.nextSortOrder());

    /*
     * The header and its ladder commit TOGETHER. A programme that exists with no
     * tiers is one the engine silently pays nothing on, and the operator who
     * created it was told it worked.
     */
    const row = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(ibPrograms)
        .values({
          name: dto.name,
          sortOrder,
          mode,
          /*
           * FR-IB-16 (0106). Defaulted to the charges basis rather than to
           * whatever the platform last used: the other two can only pay LESS on
           * a deployment whose spread markups are unset, and a new programme
           * quietly pricing on an unpopulated markup pays nothing on every deal
           * it touches — permanently, since a zero-revenue deal is marked done.
           */
          revenueBasis: dto.revenueBasis ?? DEFAULT_REVENUE_BASIS,
          ...rebatePayout(dto.rebateMode, dto.rebateAmountPerLot, rebateRate),
          enabled: dto.enabled ?? true,
        })
        .returning();

      if (tiers.length > 0) {
        await tx.insert(ibProgramTiers).values(
          tiers.map((tier) => ({
            programId: created.id,
            depth: tier.depth,
            ...tierPayout(tier),
          })),
        );
      }

      return created;
    });

    this.audit.record(actor.id, 'ib_program.create', 'ib_program', row.id, {
      name: row.name,
      mode: row.mode,
      revenueBasis: row.revenueBasis,
      tiers,
      rebateRate: row.rebateRate,
      rebateMode: row.rebateMode,
      rebateAmountPerLot: row.rebateAmountPerLot,
      enabled: row.enabled,
    });

    return { ...row, partnerCount: 0, tiers: [...tiers].sort((a, b) => a.depth - b.depth) };
  }

  async update(id: string, dto: UpdateIbProgramDto, actor: Actor): Promise<IbProgramDto> {
    const current = await this.findOneWithTiers(id);
    if (!current) throw new NotFoundError('That programme does not exist.');

    /*
     * `tiers` is REPLACE-ALL, not a merge, and the DTO says so.
     *
     * A ladder is read as a whole — its length is what decides reach — so
     * "patch level 2 to 25" and "the ladder is now just level 1" have to be
     * distinguishable. Merging would make removing the deepest level impossible
     * to express, which is the one edit an operator shortening a programme is
     * trying to make.
     */
    const tiers = dto.tiers ?? current.tiers;
    const rebateRate = dto.rebateRate ?? current.rebateRate;
    const mode = dto.mode ?? current.mode;

    /*
     * An UNCHANGED ladder is checked too, and that is deliberate. Lowering the
     * ceiling does not truncate existing programmes — but the next deliberate
     * edit of one is the right moment to be told it no longer fits, rather than
     * letting a too-deep ladder be re-saved indefinitely.
     */
    this.assertLadderIsWellFormed(tiers, await this.maxLevels());
    this.assertShareFits(tiers, rebateRate);
    this.assertModeIsPayable(mode, tiers, rebateRate);

    if (dto.name && dto.name !== current.name) {
      const [clash] = await this.db
        .select({ id: ibPrograms.id })
        .from(ibPrograms)
        .where(eq(ibPrograms.name, dto.name))
        .limit(1);
      if (clash) throw new ConflictError(`A programme called "${dto.name}" already exists.`);
    }

    /*
     * DISABLING one that partners stand on is refused.
     *
     * A disabled programme pays nothing, so this would stop every partner on it
     * earning — silently, from their side, with their referral links still
     * working. Move them first; the refusal says how many there are.
     */
    if (dto.enabled === false && current.enabled) {
      if (current.partnerCount > 0) {
        throw new ConflictError(
          `${current.partnerCount} partner(s) are on "${current.name}", and a disabled programme ` +
            'stops paying. Move them to another programme first.',
        );
      }
    }

    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(ibPrograms)
        .set({
          name: dto.name ?? current.name,
          sortOrder: dto.sortOrder ?? current.sortOrder,
          mode,
          /* Omitted means LEAVE IT — this is a PATCH, and re-pricing a
           * programme is never something an operator did by not mentioning. */
          revenueBasis: dto.revenueBasis ?? current.revenueBasis,
          /*
           * The mode falls back to what is STORED, not to `percent`. A PATCH
           * that changes only the name must not quietly re-price a per-lot
           * programme back onto a percentage nobody configured.
           */
          ...rebatePayout(
            dto.rebateMode ?? current.rebateMode,
            dto.rebateAmountPerLot ?? current.rebateAmountPerLot ?? undefined,
            rebateRate,
          ),
          enabled: dto.enabled ?? current.enabled,
          updatedAt: new Date(),
        })
        .where(eq(ibPrograms.id, id))
        .returning();

      if (dto.tiers !== undefined) {
        /*
         * Delete-then-insert rather than a row-by-row diff. The ladder is small
         * and replaced wholesale, and the share-ceiling trigger is DEFERRABLE
         * INITIALLY DEFERRED precisely so this transient empty state is never
         * observed: swapping 60/40 for 40/60 would otherwise breach nothing and
         * still be refused mid-rewrite.
         */
        await tx.delete(ibProgramTiers).where(eq(ibProgramTiers.programId, id));
        if (tiers.length > 0) {
          await tx
            .insert(ibProgramTiers)
            .values(
              tiers.map((tier) => ({ programId: id, depth: tier.depth, ...tierPayout(tier) })),
            );
        }
      }

      return updated;
    });

    this.audit.record(actor.id, 'ib_program.update', 'ib_program', id, {
      before: {
        name: current.name,
        mode: current.mode,
        revenueBasis: current.revenueBasis,
        tiers: current.tiers,
        rebateRate: current.rebateRate,
        enabled: current.enabled,
      },
      after: {
        name: row.name,
        mode: row.mode,
        revenueBasis: row.revenueBasis,
        tiers,
        rebateRate: row.rebateRate,
        rebateMode: row.rebateMode,
        rebateAmountPerLot: row.rebateAmountPerLot,
        enabled: row.enabled,
      },
    });

    return {
      ...row,
      partnerCount: current.partnerCount,
      tiers: [...tiers].sort((a, b) => a.depth - b.depth),
    };
  }

  private async partnerCount(id: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(ibAccounts)
      .where(eq(ibAccounts.programId, id));
    return row?.value ?? 0;
  }

  /**
   * Remove a programme.
   *
   * Refused while anybody is on it — the foreign key says so too, but a
   * constraint violation reaches an operator as a 500 rather than as a sentence
   * naming how many partners would have lost their terms.
   *
   * Also refused when it is the last ENABLED one: approval places a new partner
   * on the first enabled programme, so emptying the catalogue turns every
   * future approval into a refusal.
   *
   * The tiers go with it — `ib_program_tiers.program_id` cascades. That is the
   * one cascade in this schema, and it is safe here for the reason the column
   * documents: a programme partners stand on cannot reach this line at all.
   */
  async remove(id: string, actor: Actor) {
    const current = await this.findOneWithTiers(id);
    if (!current) throw new NotFoundError('That programme does not exist.');

    if (current.partnerCount > 0) {
      throw new ConflictError(
        `${current.partnerCount} partner(s) are on "${current.name}". Move them to another ` +
          'programme before deleting it.',
      );
    }

    if (current.enabled) {
      const [{ value: othersEnabled }] = await this.db
        .select({ value: count() })
        .from(ibPrograms)
        .where(sql`${ibPrograms.enabled} AND ${ne(ibPrograms.id, id)}`);

      if (othersEnabled === 0) {
        throw new ConflictError(
          `"${current.name}" is the only enabled programme. Deleting it would leave new partner ` +
            'approvals with no terms to assign.',
        );
      }
    }

    await this.db.delete(ibPrograms).where(eq(ibPrograms.id, id));

    this.audit.record(actor.id, 'ib_program.delete', 'ib_program', id, {
      name: current.name,
      mode: current.mode,
      revenueBasis: current.revenueBasis,
      tiers: current.tiers,
      rebateRate: current.rebateRate,
    });
    return { deleted: true };
  }
}
