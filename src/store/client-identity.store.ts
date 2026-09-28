import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';

/** The kinds of disagreement `identity_drift` (0152) names — its header says what each is. */
export type IdentityDriftProblem =
  | 'pages'
  | 'type'
  | 'not_frozen'
  | 'upload'
  | 'unrecorded_page'
  | 'stale_draft'
  | 'undecided_attempt'
  | 'level';

/** One thing the KYC columns and the record disagree on. */
export interface IdentityDrift {
  userId: string;
  /** The document slot, or null for a decision or the level. */
  slot: string | null;
  problem: IdentityDriftProblem;
}

/** What one repair pass found and did. */
export interface IdentityRepair {
  /** Clients brought back in step. */
  repaired: number;
  /** Clients adoption failed on — each left exactly as it was — and why. */
  failed: { userId: string; message: string }[];
  /** What was out of step before the pass, counted by kind. */
  problems: Partial<Record<IdentityDriftProblem, number>>;
}

/**
 * THE CLIENT'S IDENTITY RECORD, as the database keeps it (0151, 0152).
 *
 * While the KYC columns are still what gets READ (until the identity-core
 * plan's slice 6), the record is kept in step by ONE routine,
 * `identity_adopt(user)` — the SQL function 0152 created, proven on real data
 * and idempotent. Calling it inside the transaction that changed the KYC row
 * makes the record move with that change, or not at all.
 */
@Injectable()
export class ClientIdentityStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /** Bring this client's record in step with their KYC rows. Idempotent. */
  async adopt(userId: string, executor: Executor = this.db): Promise<void> {
    await executor.execute(sql`SELECT identity_adopt(${userId}::uuid)`);
  }

  /**
   * The client whose record holds this stored file — the ONE place that says.
   *
   * By the page's exact key (0151 stores one spelling, and indexes it).
   * Undefined when no client's record holds it — an orphan — and ALSO when two
   * do: a file is never shared, so that is a data error, and guessing whose it
   * is would be how one client's passport is served to another.
   */
  async ownerOfFile(storageKey: string): Promise<string | undefined> {
    const result = await this.db.execute<{ user_id: string }>(sql`
      SELECT DISTINCT d.user_id
        FROM client_document_pages p
        JOIN client_documents d ON d.id = p.document_id
       WHERE p.storage_key = ${storageKey}
       LIMIT 2`);
    return result.rows.length === 1 ? result.rows[0].user_id : undefined;
  }

  /** What is out of step — for one client, or everyone. Empty is healthy. */
  async drift(userId?: string, executor: Executor = this.db): Promise<IdentityDrift[]> {
    const result = await executor.execute<{
      user_id: string;
      slot: string | null;
      problem: IdentityDriftProblem;
    }>(
      userId === undefined
        ? sql`SELECT user_id, slot, problem FROM identity_drift ORDER BY user_id, problem, slot`
        : sql`SELECT user_id, slot, problem FROM identity_drift
               WHERE user_id = ${userId}::uuid ORDER BY problem, slot`,
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      slot: row.slot,
      problem: row.problem,
    }));
  }

  /**
   * Adopt every client `identity_drift` names, EACH IN A TRANSACTION OF ITS
   * OWN: a client adoption fails on is left as it was and reported, and holds
   * up neither the others nor whoever called (a boot, a fixture reset).
   * Reports nothing itself — the caller decides what a repair means.
   */
  async repairDrift(): Promise<IdentityRepair> {
    const drift = await this.drift();
    const problems: IdentityRepair['problems'] = {};
    for (const { problem } of drift) problems[problem] = (problems[problem] ?? 0) + 1;

    const failed: IdentityRepair['failed'] = [];
    const clients = [...new Set(drift.map((row) => row.userId))];
    for (const userId of clients) {
      try {
        await this.db.transaction((tx) => this.adopt(userId, tx));
      } catch (error) {
        failed.push({ userId, message: databaseReason(error) });
      }
    }
    return { repaired: clients.length - failed.length, failed, problems };
  }
}

/**
 * The database's own reason for a failure. Drizzle wraps a driver error in
 * `Failed query: <the SQL>` and moves the original to `cause`, so the outer
 * message says WHAT ran and never WHY it failed — the one thing a person
 * reading "could not be repaired" needs. Walks the chain, as
 * `all-exceptions.filter.ts` does for the error code.
 */
function databaseReason(error: unknown): string {
  let reason = String(error);
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) reason = current.message;
    current = (current as { cause?: unknown }).cause;
  }
  return reason;
}
