import { eq } from 'drizzle-orm';
import { getDb } from '../database/db';
import { rejectionReasons } from '../database/schema';

// FR-ADM-03: rejection of a withdrawal or verification request is accompanied
// by "a reason from a configurable list". Defaults are seeded idempotently in
// src/database/seed.ts (UNIQUE(context, label) makes re-seeding a no-op).
export type RejectionContext = 'kyc' | 'withdrawal';

export interface RejectionReason {
  id: string;
  context: RejectionContext;
  label: string;
  createdAt: Date;
}

export const RejectionReasonsStore = {
  async findAll(context?: RejectionContext): Promise<RejectionReason[]> {
    const db = getDb();
    return context
      ? db.select().from(rejectionReasons).where(eq(rejectionReasons.context, context))
      : db.select().from(rejectionReasons);
  },

  async findById(id: string): Promise<RejectionReason | undefined> {
    const [row] = await getDb()
      .select()
      .from(rejectionReasons)
      .where(eq(rejectionReasons.id, id))
      .limit(1);
    return row;
  },

  async create(context: RejectionContext, label: string): Promise<RejectionReason> {
    const [row] = await getDb().insert(rejectionReasons).values({ context, label }).returning();
    return row;
  },

  async update(id: string, label: string): Promise<RejectionReason | undefined> {
    const [row] = await getDb()
      .update(rejectionReasons)
      .set({ label })
      .where(eq(rejectionReasons.id, id))
      .returning();
    return row;
  },

  async delete(id: string): Promise<boolean> {
    const deleted = await getDb()
      .delete(rejectionReasons)
      .where(eq(rejectionReasons.id, id))
      .returning();
    return deleted.length > 0;
  },
};
