import { eq } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { rejectionReasons } from '../database/schema';

// FR-ADM-03: rejection of a withdrawal or verification request is accompanied
// by "a reason from a configurable list". Defaults are seeded idempotently in
// src/database/seed.ts (UNIQUE(context, label) makes re-seeding a no-op).
/*
 * DERIVED from the enum rather than restated.
 *
 * This was a hand-written union and it went stale the moment 'partner' was
 * added to `rejection_context` — the store then returned rows the type said
 * could not exist, and tsc pointed at the assignment rather than at the union.
 * Reading it off the column means the next context added to the schema is a
 * type error at every switch that does not handle it, which is where the
 * mismatch is worth surfacing.
 */
export type RejectionContext = (typeof rejectionReasons.context.enumValues)[number];

export interface RejectionReason {
  id: string;
  context: RejectionContext;
  label: string;
  createdAt: Date;
}

@Injectable()
export class RejectionReasonsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async findAll(context?: RejectionContext): Promise<RejectionReason[]> {
    const db = this.db;
    return context
      ? db.select().from(rejectionReasons).where(eq(rejectionReasons.context, context))
      : db.select().from(rejectionReasons);
  }

  async findById(id: string): Promise<RejectionReason | undefined> {
    const [row] = await this.db
      .select()
      .from(rejectionReasons)
      .where(eq(rejectionReasons.id, id))
      .limit(1);
    return row;
  }

  async create(context: RejectionContext, label: string): Promise<RejectionReason> {
    const [row] = await this.db.insert(rejectionReasons).values({ context, label }).returning();
    return row;
  }

  async update(id: string, label: string): Promise<RejectionReason | undefined> {
    const [row] = await this.db
      .update(rejectionReasons)
      .set({ label })
      .where(eq(rejectionReasons.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(rejectionReasons)
      .where(eq(rejectionReasons.id, id))
      .returning();
    return deleted.length > 0;
  }
}
