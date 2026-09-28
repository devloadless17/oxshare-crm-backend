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

/** One version of one of the client's documents, as stored. */
export type IdentityVersionRow = {
  id: string;
  slot: string;
  docType: string | null;
  createdAt: Date;
  frozenAt: Date | null;
  pages: { part: number; path: string; fileName: string | null }[];
  /** The latest decision that covered this version, if any has. */
  decision: {
    seq: number;
    outcome: IdentityDecisionRow['outcome'];
    returnedItems: string[];
  } | null;
};

/** One verification decision, as the log keeps it. */
export type IdentityDecisionRow = {
  seq: number;
  outcome: 'verified' | 'returned' | 'reverification_requested';
  levelAfter: number;
  method: string;
  decidedBy: string | null;
  reason: string | null;
  returnedItems: string[];
  decidedAt: Date;
};

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

  /**
   * The client's whole record: every version of every document, newest first
   * within its slot, each with its pages and the LATEST decision that covered
   * it; and every decision, newest first.
   */
  async recordOf(userId: string): Promise<{
    versions: IdentityVersionRow[];
    decisions: IdentityDecisionRow[];
  }> {
    const versions = await this.db.execute<IdentityVersionRow>(sql`
      SELECT d.id, d.slot, d.doc_type AS "docType", d.created_at AS "createdAt",
             d.frozen_at AS "frozenAt",
             coalesce(json_agg(json_build_object('part', p.part, 'path', p.storage_key,
                                                 'fileName', p.file_name) ORDER BY p.part)
                        FILTER (WHERE p.document_id IS NOT NULL), '[]') AS pages,
             (SELECT json_build_object('seq', v.seq, 'outcome', v.outcome,
                                       'returnedItems', v.returned_items)
                FROM client_verification_documents c
                JOIN client_verifications v ON v.id = c.verification_id
               WHERE c.document_id = d.id
               ORDER BY v.seq DESC LIMIT 1) AS decision
        FROM client_documents d
        LEFT JOIN client_document_pages p ON p.document_id = d.id
       WHERE d.user_id = ${userId}::uuid
       GROUP BY d.id
       ORDER BY d.slot, d.frozen_at DESC NULLS FIRST, d.created_at DESC`);
    const decisions = await this.db.execute<IdentityDecisionRow>(sql`
      SELECT seq, outcome, level_after AS "levelAfter", method, admin_email AS "decidedBy",
             reason, returned_items AS "returnedItems", decided_at AS "decidedAt"
        FROM client_verifications
       WHERE user_id = ${userId}::uuid
       ORDER BY seq DESC`);
    return { versions: versions.rows, decisions: decisions.rows };
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
