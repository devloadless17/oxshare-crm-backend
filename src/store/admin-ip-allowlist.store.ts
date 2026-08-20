import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { adminIpAllowlist } from '../database/schema';
import { canonicaliseRule } from '../common/security/ip-range';

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

  async delete(id: string): Promise<AllowlistRule | undefined> {
    const [row] = await this.db
      .delete(adminIpAllowlist)
      .where(eq(adminIpAllowlist.id, id))
      .returning();
    return row;
  }
}
