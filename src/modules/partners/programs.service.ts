import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { ibPrograms } from '../../database/schema';
import { money, toDecimal } from '../wallet/money';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db, Executor } from '../../database/db';

/**
 * Runs inside the writer's transaction, so the record and the change commit or
 * fail together (R-6.5). `Executor` is the shared type that lets a caller join
 * a transaction rather than opening its own.
 */
type AuditHook = (tx: Executor, row: typeof ibPrograms.$inferSelect) => Promise<void>;

export type CommissionMode = 'commission' | 'rebate' | 'hybrid';
export type CommissionMethod = 'spread_share' | 'per_lot' | 'fixed_per_deal';

export interface ProgramInput {
  name: string;
  description?: string;
  position?: number;
  mode: CommissionMode;
  method: CommissionMethod;
  commissionValue: string;
  rebateValue?: string;
  l1Share: string;
  l2Share: string;
  settlementWindowHours?: number;
  rebateOnClose?: boolean;
  selectable?: boolean;
  active?: boolean;
}

/**
 * IB programs (IB-06) and their CRUD (ADM-10).
 *
 * This is where the "open" commission decisions actually live. The client
 * configures L1/L2 shares (§12.2), rates and the ladder (§12.3), the
 * settlement window (§12.6) and rebate timing (§12.8) here — per program, in
 * the admin UI, without a deploy. Nothing is hardcoded and nothing is guessed.
 *
 * Validation exists because these numbers feed the commission engine directly:
 * a bad share silently pays the wrong party for months.
 */
@Injectable()
export class ProgramsService {
  /**
   * The db is injected, not fetched from the module-level singleton.
   *
   * `this.db` and the DRIZZLE_DB provider return the *same* lazy instance
   * (see database.module.ts), so this is behaviour-identical — but a declared
   * dependency can be seen, and reaching for a global from inside a money method
   * could not. `executor ?? this.db` still lets a caller pass a transaction
   * handle so a method joins their transaction (§6.2).
   */
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  private validate(input: ProgramInput) {
    const l1 = toDecimal(input.l1Share);
    const l2 = toDecimal(input.l2Share);
    const commission = toDecimal(input.commissionValue);
    const rebate = toDecimal(input.rebateValue ?? '0');

    for (const [label, value] of [
      ['L1 share', l1],
      ['L2 share', l2],
    ] as const) {
      if (value.isNegative() || value.greaterThan(100)) {
        throw new ValidationError(`${label} must be between 0 and 100 percent.`);
      }
    }
    // ASSUMPTION (logged in DECISIONS D-39): the two levels split the commission
    // pool, so their shares cannot exceed 100%. A sum below 100 leaves the
    // remainder with the broker, which is why this is ≤ and not ==.
    if (l1.plus(l2).greaterThan(100)) {
      throw new ValidationError(
        `L1 + L2 shares cannot exceed 100% (got ${l1.toString()} + ${l2.toString()}).`,
      );
    }
    // §8.6: resolution stops at L2. A program paying L2 but not L1 is a
    // misconfiguration — an L2 only earns through the L1 beneath it.
    if (l1.isZero() && l2.greaterThan(0)) {
      throw new ValidationError('L2 cannot earn while L1 earns nothing — check the split.');
    }
    if (commission.isNegative() || rebate.isNegative()) {
      throw new ValidationError('Commission and rebate values cannot be negative.');
    }
    if (input.method === 'spread_share' && commission.greaterThan(100)) {
      throw new ValidationError(
        'With the spread-share method the commission value is a percentage of the spread and cannot exceed 100.',
      );
    }
    if (input.mode === 'commission' && rebate.greaterThan(0)) {
      throw new ValidationError(
        'A commission-only program cannot carry a rebate value — use rebate or hybrid mode.',
      );
    }
    if (input.mode === 'rebate' && commission.greaterThan(0)) {
      throw new ValidationError(
        'A rebate-only program cannot carry a commission value — use commission or hybrid mode.',
      );
    }
    if ((input.settlementWindowHours ?? 24) < 0) {
      throw new ValidationError('The settlement window cannot be negative.');
    }
  }

  private toColumns(input: ProgramInput) {
    return {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      position: input.position ?? 1,
      mode: input.mode,
      method: input.method,
      // Percentages and money alike are stored exactly — strings in, strings out.
      commissionValue: money(input.commissionValue),
      rebateValue: money(input.rebateValue ?? '0'),
      l1Share: new Decimal(input.l1Share).toFixed(2),
      l2Share: new Decimal(input.l2Share).toFixed(2),
      settlementWindowHours: input.settlementWindowHours ?? 24,
      rebateOnClose: input.rebateOnClose ?? false,
      selectable: input.selectable ?? true,
      active: input.active ?? true,
      updatedAt: new Date(),
    };
  }

  async findAll() {
    return this.db.select().from(ibPrograms).orderBy(asc(ibPrograms.position));
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(ibPrograms).where(eq(ibPrograms.id, id)).limit(1);
    if (!row) throw new NotFoundError('Program not found.');
    return row;
  }

  /*
   * Each writer takes an optional `audit` callback and runs it INSIDE its own
   * transaction — R-6.5, and the same shape `TransactionsService.approve` uses.
   *
   * A commission plan is not itself a money movement, which is why these
   * originally used the fire-and-forget `audit.record()`. But a plan decides
   * what every future accrual pays: changing an L1 share silently re-prices
   * commission for every deal that follows. If the write commits and the audit
   * row is lost, "who changed the L1 share, and from what" has only a log line
   * that may have rotated — and the accruals it produced are already correct
   * with respect to a rule nobody can now attribute.
   *
   * §9 item 6 calls this the one item in the system that cannot be retrofitted
   * at any price. It is true here in a weaker but real sense: the missing row
   * cannot be reconstructed after the fact, only guessed at from the values.
   */
  async create(input: ProgramInput, audit?: AuditHook) {
    this.validate(input);
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(ibPrograms)
        .where(eq(ibPrograms.name, input.name.trim()))
        .limit(1);
      if (existing.length > 0) {
        throw new ConflictError('A program with this name already exists.');
      }
      const [row] = await tx.insert(ibPrograms).values(this.toColumns(input)).returning();
      await audit?.(tx, row);
      return row;
    });
  }

  async update(id: string, input: ProgramInput, audit?: AuditHook) {
    this.validate(input);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(ibPrograms)
        .set(this.toColumns(input))
        .where(eq(ibPrograms.id, id))
        .returning();
      if (!row) throw new NotFoundError('Program not found.');
      await audit?.(tx, row);
      return row;
    });
  }

  /**
   * Programs are deactivated, never deleted: accruals reference the program
   * that produced them, and money history must stay explainable.
   */
  async setActive(id: string, active: boolean, audit?: AuditHook) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(ibPrograms)
        .set({ active, updatedAt: new Date() })
        .where(eq(ibPrograms.id, id))
        .returning();
      if (!row) throw new NotFoundError('Program not found.');
      await audit?.(tx, row);
      return row;
    });
  }
}
