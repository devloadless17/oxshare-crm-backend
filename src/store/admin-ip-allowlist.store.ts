import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { adminIpAllowlist } from '../database/schema';
import { canonicaliseRule, ipMatchesAny } from '../common/security/ip-range';

export interface AllowlistRule {
  id: string;
  cidr: string;
  label: string;
  createdBy: string;
  createdAt: Date;
}

@Injectable()
export class AdminIpAllowlistStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async findAll(): Promise<AllowlistRule[]> {
    return this.db.select().from(adminIpAllowlist).orderBy(asc(adminIpAllowlist.createdAt));
  }

  /** Just the rules, for the guard's hot path. */
  async listCidrs(): Promise<string[]> {
    const rows = await this.db.select({ cidr: adminIpAllowlist.cidr }).from(adminIpAllowlist);
    return rows.map((r) => r.cidr);
  }

  /**
   * Stored canonicalised, so two spellings of one rule cannot both exist and
   * leave an operator believing they removed a rule that is still in force.
   * Returns undefined when the rule is not valid CIDR.
   */
  async create(input: {
    cidr: string;
    label: string;
    createdBy: string;
  }): Promise<AllowlistRule | undefined> {
    const canonical = canonicaliseRule(input.cidr);
    if (!canonical) return undefined;

    const [row] = await this.db
      .insert(adminIpAllowlist)
      .values({ cidr: canonical, label: input.label, createdBy: input.createdBy })
      .returning();
    return row;
  }

  /**
   * Delete one rule UNLESS doing so would leave the caller uncovered — decided
   * and acted on under `SELECT … FOR UPDATE`, so two concurrent removals cannot
   * each treat the other's rule as the one that still covers them.
   *
   * An empty remaining list is allowed: that turns the feature off and admits
   * everyone, the caller included, which is the plainly-stated way to disable it.
   */
  async removeUnlessLockedOut(
    id: string,
    callerIp: string | undefined,
  ): Promise<
    | { outcome: 'deleted'; rule: AllowlistRule; remaining: number }
    | { outcome: 'would-lock-out'; rule: AllowlistRule }
    | { outcome: 'not-found' }
  > {
    return this.db.transaction(async (tx) => {
      const rules = await tx.select().from(adminIpAllowlist).for('update');
      const target = rules.find((r) => r.id === id);
      if (!target) return { outcome: 'not-found' as const };
      const remaining = rules.filter((r) => r.id !== id).map((r) => r.cidr);
      if (remaining.length > 0 && !ipMatchesAny(callerIp, remaining)) {
        return { outcome: 'would-lock-out' as const, rule: target };
      }
      await tx.delete(adminIpAllowlist).where(eq(adminIpAllowlist.id, id));
      return { outcome: 'deleted' as const, rule: target, remaining: remaining.length };
    });
  }

  async delete(id: string): Promise<AllowlistRule | undefined> {
    const [row] = await this.db
      .delete(adminIpAllowlist)
      .where(eq(adminIpAllowlist.id, id))
      .returning();
    return row;
  }
}
