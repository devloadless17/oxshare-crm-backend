import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { admins, clientFollowups } from '../database/schema';

/** The two notes and the date, as stored: trimmed text or NULL. */
export interface FollowUpValues {
  followUp: string | null;
  result: string | null;
  followUpAt: Date | null;
}

export interface FollowUpRecord extends FollowUpValues {
  /** 0 when the client has no row yet: nothing was ever written. */
  version: number;
  updatedAt: Date | null;
  updatedByAdminId: string | null;
  /** The editor's name, joined at read time; NULL once they were removed. */
  updatedByName: string | null;
}

/** What a client with no row reads as — both notes empty, version 0. */
export const EMPTY_FOLLOW_UP: FollowUpRecord = {
  followUp: null,
  result: null,
  followUpAt: null,
  version: 0,
  updatedAt: null,
  updatedByAdminId: null,
  updatedByName: null,
};

/**
 * A client's Follow-up and Result (0212). One row per client.
 *
 * The write is version-checked IN THE STATEMENT: an update names the version it
 * was made from and matches nothing if a colleague saved in between, and the
 * first write is an insert that a concurrent first write makes match nothing.
 * The caller turns "matched nothing" into a 409, never into a retry.
 */
@Injectable()
export class ClientFollowupsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async find(userId: number, executor: Executor = this.db): Promise<FollowUpRecord> {
    const [row] = await executor
      .select({
        followUp: clientFollowups.followUp,
        result: clientFollowups.result,
        followUpAt: clientFollowups.followUpAt,
        version: clientFollowups.version,
        updatedAt: clientFollowups.updatedAt,
        updatedByAdminId: clientFollowups.updatedByAdminId,
        updatedByName: admins.name,
      })
      .from(clientFollowups)
      .leftJoin(admins, eq(admins.id, clientFollowups.updatedByAdminId))
      .where(eq(clientFollowups.userId, userId))
      .limit(1);
    return row ?? EMPTY_FOLLOW_UP;
  }

  /** The current values under a row lock, for a write in the caller's transaction. */
  async findForUpdate(userId: number, tx: Executor): Promise<FollowUpRecord> {
    const [row] = await tx
      .select({
        followUp: clientFollowups.followUp,
        result: clientFollowups.result,
        followUpAt: clientFollowups.followUpAt,
        version: clientFollowups.version,
        updatedAt: clientFollowups.updatedAt,
        updatedByAdminId: clientFollowups.updatedByAdminId,
      })
      .from(clientFollowups)
      .where(eq(clientFollowups.userId, userId))
      .for('update')
      .limit(1);
    return row ? { ...row, updatedByName: null } : EMPTY_FOLLOW_UP;
  }

  /**
   * Write the notes made from `fromVersion`. Returns the new version, or
   * `undefined` when the stored version is no longer `fromVersion`: somebody
   * saved in between, and nothing was written.
   */
  async save(
    userId: number,
    fromVersion: number,
    values: FollowUpValues,
    adminId: string,
    tx: Executor,
  ): Promise<number | undefined> {
    const written = { ...values, updatedByAdminId: adminId, updatedAt: sql`now()` };
    if (fromVersion === 0) {
      const [row] = await tx
        .insert(clientFollowups)
        .values({ userId, ...written, version: 1 })
        .onConflictDoNothing({ target: clientFollowups.userId })
        .returning({ version: clientFollowups.version });
      return row?.version;
    }
    const [row] = await tx
      .update(clientFollowups)
      .set({ ...written, version: sql`${clientFollowups.version} + 1` })
      .where(and(eq(clientFollowups.userId, userId), eq(clientFollowups.version, fromVersion)))
      .returning({ version: clientFollowups.version });
    return row?.version;
  }
}
