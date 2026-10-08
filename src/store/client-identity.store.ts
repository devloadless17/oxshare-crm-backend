import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
/** One thing the KYC columns and the record disagree on. */
/** One version of one of the client's documents, as stored. */
export type IdentityVersionRow = {
  id: string;
  slot: string;
  docType: string | null;
  createdAt: Date;
  frozenAt: Date | null;
  pages: { part: number; path: string }[];
  /**
   * The administrator who uploaded a page of it for the client ("Complete KYC",
   * 0210) — their name, from the upload registry — or null when the client
   * uploaded every page themselves.
   */
  uploadedByStaff: string | null;
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
  /** The reason in Arabic as the client was shown it (0179). */
  reasonAr: string | null;
  returnedItems: string[];
  decidedAt: Date;
};
/**
 * THE CLIENT'S IDENTITY RECORD, as the database keeps it (0151, 0152).
 *
 * The ONLY home of a client's documents and decisions since 0171 dropped the
 * KYC document columns. `KycStore` writes it in the KYC row's own transaction;
 * this store reads it.
 */
@Injectable()
export class ClientIdentityStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * The client whose record holds this stored file — the ONE place that says.
   *
   * By the page's exact key (0151 stores one spelling, and indexes it).
   * Undefined when no client's record holds it — an orphan — and ALSO when two
   * do: a file is never shared, so that is a data error, and guessing whose it
   * is would be how one client's passport is served to another.
   */
  async ownerOfFile(storageKey: string): Promise<number | undefined> {
    const result = await this.db.execute<{ user_id: number }>(sql`
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
  async recordOf(userId: number): Promise<{
    versions: IdentityVersionRow[];
    decisions: IdentityDecisionRow[];
  }> {
    const versions = await this.db.execute<IdentityVersionRow>(sql`
      SELECT d.id, d.slot, d.doc_type AS "docType", d.created_at AS "createdAt",
             d.frozen_at AS "frozenAt",
             coalesce(json_agg(json_build_object('part', p.part, 'path', p.storage_key)
                               ORDER BY p.part)
                        FILTER (WHERE p.document_id IS NOT NULL), '[]') AS pages,
             -- Who uploaded it, from the registry the upload path already fills.
             -- uploaded_by_id is text (an admin uuid OR a Portal ID): compared ::text.
             -- An administrator since removed is still staff, never "the client".
             (SELECT coalesce(a.name, 'A former administrator')
                FROM client_document_pages sp
                JOIN stored_objects o ON o.id = sp.stored_object_id
                LEFT JOIN admins a ON a.id::text = o.uploaded_by_id
               WHERE sp.document_id = d.id AND o.uploaded_by_kind = 'admin'
               ORDER BY sp.part LIMIT 1) AS "uploadedByStaff",
             (SELECT json_build_object('seq', v.seq, 'outcome', v.outcome,
                                       'returnedItems', v.returned_items)
                FROM client_verification_documents c
                JOIN client_verifications v ON v.id = c.verification_id
               WHERE c.document_id = d.id
               ORDER BY v.seq DESC LIMIT 1) AS decision
        FROM client_documents d
        LEFT JOIN client_document_pages p ON p.document_id = d.id
       WHERE d.user_id = ${userId}::integer
       GROUP BY d.id
       ORDER BY d.slot, d.frozen_at DESC NULLS FIRST, d.created_at DESC`);
    const decisions = await this.db.execute<IdentityDecisionRow>(sql`
      SELECT seq, outcome, level_after AS "levelAfter", method, admin_email AS "decidedBy",
             reason, reason_ar AS "reasonAr", returned_items AS "returnedItems",
             decided_at AS "decidedAt"
        FROM client_verifications
       WHERE user_id = ${userId}::integer
       ORDER BY seq DESC`);
    return { versions: versions.rows, decisions: decisions.rows };
  }
}
