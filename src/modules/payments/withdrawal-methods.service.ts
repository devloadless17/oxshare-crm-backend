import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { withdrawalPaymentMethods } from '../../database/schema';
import { ConflictError, NotFoundError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import type {
  AdminWithdrawalMethodDto,
  CreateWithdrawalMethodDto,
  UpdateWithdrawalMethodDto,
} from './dto/withdrawal-method.dto';

type WithdrawalMethodRow = typeof withdrawalPaymentMethods.$inferSelect;

/**
 * The payout rails clients may withdraw through — `withdrawal_payment_methods`.
 *
 * The table has existed since migration 0062 and the portal's withdraw form has
 * read it all along (`GET /payments/withdrawal-methods`, enabled rows only). What
 * was missing was a way to change it without a database client: this is that.
 *
 * ## Enable and disable, never delete
 *
 * `transactions.withdrawal_method_key` references a row ON DELETE RESTRICT, so a
 * method that has carried a request cannot be removed — and one that has not is
 * just as well switched off. Same rule as the deposit methods, for the same
 * reason: the desk has to be able to name the rail on every request it settles.
 *
 * ## `payments.*` keys, shared with the deposit methods
 *
 * They are the same kind of thing configured by the same people, and one grant
 * for "manage payment methods" is what an operator expects. Splitting the keys
 * would be a privilege distinction nobody asked for.
 */
@Injectable()
export class WithdrawalMethodsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
  ) {}

  /** Every method, disabled ones included, in the order clients see them. */
  async listAll(): Promise<AdminWithdrawalMethodDto[]> {
    return this.db
      .select()
      .from(withdrawalPaymentMethods)
      .orderBy(asc(withdrawalPaymentMethods.sortOrder), asc(withdrawalPaymentMethods.name));
  }

  async findOne(key: string): Promise<WithdrawalMethodRow | null> {
    const [row] = await this.db
      .select()
      .from(withdrawalPaymentMethods)
      .where(eq(withdrawalPaymentMethods.key, this.normalise(key)))
      .limit(1);
    return row ?? null;
  }

  async create(dto: CreateWithdrawalMethodDto, actor: Actor): Promise<AdminWithdrawalMethodDto> {
    const key = this.normalise(dto.key);
    if (await this.findOne(key)) {
      throw new ConflictError(`A withdrawal method with the key ${key} already exists.`);
    }

    const [row] = await this.db
      .insert(withdrawalPaymentMethods)
      .values({
        key,
        name: dto.name.trim(),
        logoUrl: dto.logoUrl ?? null,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? (await this.nextSortOrder()),
      })
      .returning();

    this.audit.record(actor.id, 'withdrawal_method.create', 'withdrawal_method', row.key, {
      name: row.name,
      enabled: row.enabled,
    });
    return row;
  }

  async update(
    key: string,
    dto: UpdateWithdrawalMethodDto,
    actor: Actor,
  ): Promise<AdminWithdrawalMethodDto> {
    const current = await this.findOne(key);
    if (!current) throw new NotFoundError(`Unknown withdrawal method ${this.normalise(key)}.`);

    const [row] = await this.db
      .update(withdrawalPaymentMethods)
      .set({
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(eq(withdrawalPaymentMethods.key, current.key))
      .returning();

    /*
     * The diff, not the new row: "who switched Whish payouts off, and when" is
     * the question this entry exists to answer, and it should not need two rows
     * compared by hand.
     */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of ['name', 'enabled', 'sortOrder', 'logoUrl'] as const) {
      if (current[field] !== row[field]) {
        changed[field] = { before: current[field], after: row[field] };
      }
    }
    this.audit.record(actor.id, 'withdrawal_method.update', 'withdrawal_method', row.key, {
      changed,
    });
    return row;
  }

  /** Keys are stored lower-case, so `Whish` and `whish` are one method. */
  private normalise(key: string): string {
    return key.trim().toLowerCase();
  }

  /**
   * Where a new withdrawal method goes when no position is given: after the last one.
   *
   * The console no longer asks for an order (owner, 26 Sep 2026), so every new
   * row would otherwise land at 0 and jump to the top of the list, ahead of
   * rows an operator placed years ago.
   */
  private async nextSortOrder(): Promise<number> {
    const [row] = await this.db
      .select({
        next: sql<number>`coalesce(max(${withdrawalPaymentMethods.sortOrder}), -1)::int + 1`,
      })
      .from(withdrawalPaymentMethods);
    return Number(row?.next ?? 0);
  }
}
