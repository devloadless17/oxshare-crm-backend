import { sql } from 'drizzle-orm';
import type { Executor } from '../../src/database/db';

/** A fixture's documents, in the KYC shape every reader sees. */
export interface KycEvidence {
  document?: Record<string, string> | null;
  selfie?: Record<string, string> | null;
  addressProof?: Record<string, string> | null;
}

/**
 * Record a fixture's documents on the client's identity record (0171) — the
 * only place they live since the KYC document columns went. Through
 * `identity_record_evidence`, the same SQL `KycStore` writes with, as the KYC
 * row's status has them: a draft while the client works, frozen once
 * presented. Run AFTER the fixture's `kyc_submissions` row is written.
 */
export async function recordKycEvidence(
  db: Executor,
  userId: number,
  evidence: KycEvidence,
): Promise<void> {
  const json = (value: Record<string, string> | null | undefined) =>
    value ? JSON.stringify(value) : null;
  await db.execute(sql`
    SELECT identity_record_evidence(
      k.user_id, k.status::text,
      ${json(evidence.document)}::jsonb, ${json(evidence.addressProof)}::jsonb,
      ${json(evidence.selfie)}::jsonb, k.step_data, coalesce(k.submitted_at, k.updated_at))
      FROM kyc_submissions k
     WHERE k.user_id = ${userId}::integer`);
}

/**
 * A FROZEN identity document on a client's record — what a presented and
 * decided submission leaves behind — without walking a whole KYC round. Under
 * the record's maintenance escape, as `identity_record_evidence` writes one.
 */
export async function recordFrozenIdentityDocument(
  db: { transaction: <T>(work: (tx: Executor) => Promise<T>) => Promise<T> },
  userId: number,
  document: Record<string, string>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('oxshare.identity_maintenance', 'on', true)`);
    await tx.execute(sql`
      SELECT identity_frozen_version(
        ${userId}::integer, 'identity', ${document.docType ?? null},
        identity_pages('identity', ${JSON.stringify(document)}::jsonb), now())`);
  });
}
