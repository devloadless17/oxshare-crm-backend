import { Inject, Injectable } from '@nestjs/common';
import { asc, count, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { ibAccruals, ibCommissionTypes } from '../../database/schema';
import { ConflictError, NotFoundError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import type {
  CreateIbCommissionTypeDto,
  IbCommissionTypeDto,
  UpdateIbCommissionTypeDto,
} from './dto/ib-commission-type.dto';

type Db = ReturnType<typeof getDb>;

/**
 * Commission TYPES — the rate cards products are sold on (0140).
 *
 * ## What a type is, in one sentence
 *
 * Money per standard lot for the partners' commission and for the client's
 * rebate. A product points at one; each rung of `ib_levels` takes a percentage
 * of it. Together those two decide every payout, and neither has to know about
 * the other — which is what lets one ladder price a whole catalogue.
 *
 * ## Nothing here edits money already earned
 *
 * An amount change applies to the NEXT trade. Accruals record the type AND the
 * pool it produced (`ib_accruals.commission_type_id`, `base_amount`), so
 * re-reading a type can never restate what a partner was already paid.
 *
 * ## Reads are `ib.view`, writes are `ib.commission_types.*`
 *
 * Same split as the levels: an operator trusted to READ the rate cards is not
 * automatically trusted to change what every product pays.
 */
@Injectable()
export class IbCommissionTypesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Every type, disabled ones included, with the products sold on each.
   *
   * The product names are part of the row rather than a second call: they are
   * what makes a delete or a disable refusable on the screen before the API
   * refuses it, and what tells an operator which products an amount change is
   * about to re-price.
   */
  async listAll(): Promise<IbCommissionTypeDto[]> {
    const rows = await this.db
      .select({
        id: ibCommissionTypes.id,
        name: ibCommissionTypes.name,
        description: ibCommissionTypes.description,
        enabled: ibCommissionTypes.enabled,
        commissionPerLot: ibCommissionTypes.commissionPerLot,
        rebatePerLot: ibCommissionTypes.rebatePerLot,
        sortOrder: ibCommissionTypes.sortOrder,
        createdAt: ibCommissionTypes.createdAt,
        updatedAt: ibCommissionTypes.updatedAt,
        /*
         * `json_agg` rather than `array_agg`: a JSON array parses to a JS array
         * on every driver, where a Postgres text[] depends on the type parser
         * being registered. Ordered so the list is stable between reads.
         *
         * ⚠️ QUALIFIED BY HAND. Inside a select-list `sql` template Drizzle
         * renders a column as its bare name — `${ibCommissionTypes.id}` became
         * `"id"` — and inside the subquery a bare `"id"` resolves to the INNER
         * table's column. The correlation then compared trading_products with
         * itself and every type listed no products, which is the one answer
         * that lets a card be deleted from under the products sold on it.
         */
        productNames: sql<string[] | null>`(
          SELECT json_agg(p.name ORDER BY p.name)
            FROM trading_products AS p
           WHERE p.commission_type_id = "ib_commission_types"."id"
        )`,
      })
      .from(ibCommissionTypes)
      .orderBy(asc(ibCommissionTypes.sortOrder), asc(ibCommissionTypes.name));

    return rows.map((row) => ({ ...row, productNames: row.productNames ?? [] }));
  }

  async findOne(id: string): Promise<IbCommissionTypeDto | null> {
    const rows = await this.listAll();
    return rows.find((row) => row.id === id) ?? null;
  }

  async create(dto: CreateIbCommissionTypeDto, actor: Actor): Promise<IbCommissionTypeDto> {
    const [created] = await this.db
      .insert(ibCommissionTypes)
      .values({
        name: dto.name.trim(),
        description: emptyToNull(dto.description),
        commissionPerLot: dto.commissionPerLot,
        rebatePerLot: dto.rebatePerLot,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? (await this.nextSortOrder()),
      })
      .returning()
      .catch((error: unknown) => {
        if (violatesUniqueName(error)) {
          throw new ConflictError(
            `A commission type named '${dto.name.trim()}' already exists. Edit that one, or ` +
              'choose a different name.',
          );
        }
        throw error;
      });

    this.audit.record(actor.id, 'ib_commission_type.create', 'ib_commission_type', created.id, {
      name: created.name,
      commissionPerLot: created.commissionPerLot,
      rebatePerLot: created.rebatePerLot,
      enabled: created.enabled,
    });

    return { ...created, productNames: [] };
  }

  async update(
    id: string,
    dto: UpdateIbCommissionTypeDto,
    actor: Actor,
  ): Promise<IbCommissionTypeDto> {
    const current = await this.findOne(id);
    if (!current) throw new NotFoundError('Commission type not found.');

    /*
     * DISABLING a type products are sold on is refused.
     *
     * A disabled type pays nothing, so this would stop every partner earning
     * on those products — silently, from their side, with their clients still
     * trading. Move the products to another type first; the refusal names them.
     */
    if (dto.enabled === false && current.enabled && current.productNames.length > 0) {
      throw new ConflictError(
        `${current.productNames.join(', ')} ${current.productNames.length === 1 ? 'is' : 'are'} ` +
          `sold on '${current.name}', and a disabled type stops paying on every product using it. ` +
          'Move those products to another type first.',
      );
    }

    const [updated] = await this.db
      .update(ibCommissionTypes)
      .set({
        name: dto.name === undefined ? current.name : dto.name.trim(),
        /* `undefined` leaves it; an explicit null clears it. */
        description:
          dto.description === undefined ? current.description : emptyToNull(dto.description),
        commissionPerLot: dto.commissionPerLot ?? current.commissionPerLot,
        rebatePerLot: dto.rebatePerLot ?? current.rebatePerLot,
        enabled: dto.enabled ?? current.enabled,
        sortOrder: dto.sortOrder ?? current.sortOrder,
        updatedAt: new Date(),
      })
      .where(eq(ibCommissionTypes.id, id))
      .returning()
      .catch((error: unknown) => {
        if (violatesUniqueName(error)) {
          throw new ConflictError(
            `A commission type named '${dto.name?.trim() ?? ''}' already exists.`,
          );
        }
        throw error;
      });

    this.audit.record(actor.id, 'ib_commission_type.update', 'ib_commission_type', id, {
      before: {
        name: current.name,
        commissionPerLot: current.commissionPerLot,
        rebatePerLot: current.rebatePerLot,
        enabled: current.enabled,
      },
      after: {
        name: updated.name,
        commissionPerLot: updated.commissionPerLot,
        rebatePerLot: updated.rebatePerLot,
        enabled: updated.enabled,
      },
      /* Which products this re-prices from the next trade on. */
      products: current.productNames,
    });

    return { ...updated, productNames: current.productNames };
  }

  /**
   * Remove a rate card.
   *
   * Refused while any product is sold on it (the products are named), and
   * refused once it has priced a payout: `ib_accruals.commission_type_id` is
   * ON DELETE RESTRICT, and a constraint violation reaches an operator as a 500
   * with a Postgres string in it. Both refusals say what to do instead.
   */
  async remove(id: string, actor: Actor): Promise<{ deleted: true }> {
    const current = await this.findOne(id);
    if (!current) throw new NotFoundError('Commission type not found.');

    if (current.productNames.length > 0) {
      throw new ConflictError(
        `${current.productNames.join(', ')} ${current.productNames.length === 1 ? 'is' : 'are'} ` +
          `sold on '${current.name}'. Move those products to another type before deleting it, ` +
          'or disable it instead.',
      );
    }

    const [{ value: paid }] = await this.db
      .select({ value: count() })
      .from(ibAccruals)
      .where(eq(ibAccruals.commissionTypeId, id));

    if (paid > 0) {
      throw new ConflictError(
        `'${current.name}' has priced ${paid} payout(s), and the record of what was paid has to ` +
          'stay explicable. Disable it instead of deleting it.',
      );
    }

    await this.db.delete(ibCommissionTypes).where(eq(ibCommissionTypes.id, id));

    this.audit.record(actor.id, 'ib_commission_type.delete', 'ib_commission_type', id, {
      name: current.name,
      commissionPerLot: current.commissionPerLot,
      rebatePerLot: current.rebatePerLot,
    });

    return { deleted: true };
  }

  /**
   * Where a new commission type goes when no position is given: after the last one.
   *
   * The console no longer asks for an order (owner, 26 Sep 2026), so every new
   * row would otherwise land at 0 and jump to the top of the list, ahead of
   * rows an operator placed years ago.
   */
  private async nextSortOrder(): Promise<number> {
    const [row] = await this.db
      .select({ next: sql<number>`coalesce(max(${ibCommissionTypes.sortOrder}), -1)::int + 1` })
      .from(ibCommissionTypes);
    return Number(row?.next ?? 0);
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Did this write hit `ib_commission_types_name_unique`? drizzle-orm wraps the
 * driver error and moves the original to `cause`, so the constraint name is
 * found by walking the chain rather than read off the top.
 */
function violatesUniqueName(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string' && constraint.startsWith('ib_commission_types_name')) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
