import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { asc, count, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { ibAccounts, ibPrograms } from '../../database/schema';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import type { CreateIbProgramDto, IbProgramDto, UpdateIbProgramDto } from './dto/ib-program.dto';

type Db = ReturnType<typeof getDb>;

/**
 * The most of one trade's revenue a single programme may hand out.
 *
 * Every leg is a share of the SAME number, so they add: 70 to the introducer +
 * 30 to their parent + a 10 rebate is 110% of what the house kept. The database
 * carries the same rule as a CHECK — this is the copy that can explain itself.
 */
const MAX_TOTAL_SHARE = new Decimal(100);

/**
 * Named IB programmes — FR-ADM-10's "commission plans", and the record FR-IB-05
 * and FR-IB-06 are written against.
 *
 * ## Why this is not the level ladder
 *
 * `ib_levels` keys a rate on the RUNG a partner occupies, so every level-1
 * partner is paid identically and there is nowhere to put a client rebate. A
 * programme is assigned per partner and carries both legs plus the mode that
 * decides which of them pay. The ladder keeps what it still owns — the rung's
 * name, and whether new partners may be placed there.
 *
 * ## Nothing here edits money that has already been earned
 *
 * A rate change applies to the NEXT trade. Accruals record the rate they were
 * calculated at (`ib_accruals.rate_value`), so re-reading a programme can never
 * restate what a partner was already paid — which is why editing one is an
 * ordinary update rather than something that has to reason about history.
 */
@Injectable()
export class IbProgramsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Every programme, with how many partners stand on each.
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
        level1Rate: ibPrograms.level1Rate,
        level2Rate: ibPrograms.level2Rate,
        rebateRate: ibPrograms.rebateRate,
        enabled: ibPrograms.enabled,
        createdAt: ibPrograms.createdAt,
        updatedAt: ibPrograms.updatedAt,
        partnerCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${ibAccounts} WHERE ${ibAccounts.programId} = ${ibPrograms.id}
        )`,
      })
      .from(ibPrograms)
      .orderBy(asc(ibPrograms.sortOrder), asc(ibPrograms.name));

    return rows;
  }

  async findOne(id: string) {
    const [row] = await this.db.select().from(ibPrograms).where(eq(ibPrograms.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Refuse a set of rates that pays out more than the broker earned.
   *
   * Named separately from the CHECK constraint because a constraint violation
   * reaches an operator as a 500 with a Postgres string in it. This one says
   * which three numbers were involved and what they add up to.
   */
  private assertShareFits(level1: string, level2: string, rebate: string): void {
    const total = new Decimal(level1).plus(level2).plus(rebate);

    if (total.greaterThan(MAX_TOTAL_SHARE)) {
      throw new ValidationError(
        `These terms pay out ${total.toString()}% of the broker's revenue on a trade — ` +
          `${level1}% at level 1, ${level2}% at level 2 and ${rebate}% back to the client. ` +
          'Every leg is a share of the same revenue, so they add up; the total cannot exceed 100%.',
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

  async create(dto: CreateIbProgramDto, actor: Actor) {
    const level1Rate = dto.level1Rate ?? '0';
    const level2Rate = dto.level2Rate ?? '0';
    const rebateRate = dto.rebateRate ?? '0';

    this.assertShareFits(level1Rate, level2Rate, rebateRate);
    this.assertModeIsPayable(dto.mode ?? 'commission_only', level1Rate, level2Rate, rebateRate);

    const [existing] = await this.db
      .select({ id: ibPrograms.id })
      .from(ibPrograms)
      .where(eq(ibPrograms.name, dto.name))
      .limit(1);
    if (existing) throw new ConflictError(`A programme called "${dto.name}" already exists.`);

    const [row] = await this.db
      .insert(ibPrograms)
      .values({
        name: dto.name,
        sortOrder: dto.sortOrder ?? (await this.nextSortOrder()),
        mode: dto.mode ?? 'commission_only',
        level1Rate,
        level2Rate,
        rebateRate,
        enabled: dto.enabled ?? true,
      })
      .returning();

    this.audit.record(actor.id, 'ib_program.create', 'ib_program', row.id, {
      name: row.name,
      mode: row.mode,
      level1Rate: row.level1Rate,
      level2Rate: row.level2Rate,
      rebateRate: row.rebateRate,
      enabled: row.enabled,
    });
    return row;
  }

  /**
   * A programme must be able to pay something.
   *
   * `commission_only` with both rates at zero, or `rebate_only` with no rebate,
   * is a set of terms that pays nobody — configuration an operator can save,
   * assign, and then spend a week wondering about. The engine already skips it
   * silently; this refuses it at the point where somebody can still fix it.
   */
  private assertModeIsPayable(mode: string, level1: string, level2: string, rebate: string): void {
    const commission = new Decimal(level1).plus(level2);
    const rebateAmount = new Decimal(rebate);

    if (mode !== 'rebate_only' && commission.isZero() && rebateAmount.isZero()) {
      throw new ValidationError(
        'These terms pay nothing: both commission rates and the rebate are zero. Set at least ' +
          'one of them, or disable the programme instead.',
      );
    }
    if (mode === 'rebate_only' && rebateAmount.isZero()) {
      throw new ValidationError(
        'A rebate-only programme with a zero rebate pays nobody at all — neither the partner ' +
          'nor the client. Set a rebate rate, or choose another mode.',
      );
    }
  }

  async update(id: string, dto: UpdateIbProgramDto, actor: Actor) {
    const current = await this.findOne(id);
    if (!current) throw new NotFoundError('That programme does not exist.');

    const level1Rate = dto.level1Rate ?? current.level1Rate;
    const level2Rate = dto.level2Rate ?? current.level2Rate;
    const rebateRate = dto.rebateRate ?? current.rebateRate;
    const mode = dto.mode ?? current.mode;

    this.assertShareFits(level1Rate, level2Rate, rebateRate);
    this.assertModeIsPayable(mode, level1Rate, level2Rate, rebateRate);

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
      const partners = await this.partnerCount(id);
      if (partners > 0) {
        throw new ConflictError(
          `${partners} partner(s) are on "${current.name}", and a disabled programme stops ` +
            'paying. Move them to another programme first.',
        );
      }
    }

    const [row] = await this.db
      .update(ibPrograms)
      .set({
        name: dto.name ?? current.name,
        sortOrder: dto.sortOrder ?? current.sortOrder,
        mode,
        level1Rate,
        level2Rate,
        rebateRate,
        enabled: dto.enabled ?? current.enabled,
        updatedAt: new Date(),
      })
      .where(eq(ibPrograms.id, id))
      .returning();

    this.audit.record(actor.id, 'ib_program.update', 'ib_program', id, {
      before: {
        name: current.name,
        mode: current.mode,
        level1Rate: current.level1Rate,
        level2Rate: current.level2Rate,
        rebateRate: current.rebateRate,
        enabled: current.enabled,
      },
      after: {
        name: row.name,
        mode: row.mode,
        level1Rate: row.level1Rate,
        level2Rate: row.level2Rate,
        rebateRate: row.rebateRate,
        enabled: row.enabled,
      },
    });
    return row;
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
   */
  async remove(id: string, actor: Actor) {
    const current = await this.findOne(id);
    if (!current) throw new NotFoundError('That programme does not exist.');

    const partners = await this.partnerCount(id);
    if (partners > 0) {
      throw new ConflictError(
        `${partners} partner(s) are on "${current.name}". Move them to another programme before ` +
          'deleting it.',
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
      level1Rate: current.level1Rate,
      level2Rate: current.level2Rate,
      rebateRate: current.rebateRate,
    });
    return { deleted: true };
  }
}
