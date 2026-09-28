import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * THE CLIENT'S IDENTITY RECORD HOLDS — every forbidden act attempted (0151).
 *
 * The ledger taught this repo that a guarantee a test never ATTEMPTS to break
 * is not tested: `ledger_entries` was silently mutable for a month while a
 * spec named "append-only" only ever inserted. So each rule here is proven by
 * doing the forbidden thing, as the SUPERUSER migrations and dev run as —
 * which is exactly who a role-based grant does not stop, and a trigger does.
 *
 *  - a frozen document version, and its pages, never change and are never
 *    deleted; a draft can be;
 *  - a version with no pages cannot be frozen;
 *  - one draft per client and slot;
 *  - a verification decision is never rewritten or removed;
 *  - the one escape is explicit, and local to its transaction;
 *  - the log does not trap its neighbours: a rejection reason and an admin
 *    it names can still be deleted;
 *  - the migration runs twice without harm.
 */

const SQL = readFileSync(
  join(__dirname, '..', 'src', 'database', 'migrations', '0151_client_identity_record.sql'),
  'utf8',
);

let ctx: MoneyTestContext;
let userId: string;

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

/** The error a statement raises, or undefined when it succeeds. */
async function refusal(text: string, values: unknown[] = []): Promise<string | undefined> {
  try {
    await q(text, values);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

async function draft(slot: string, docType: string | null = 'passport'): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO client_documents (user_id, slot, doc_type) VALUES ($1, $2, $3) RETURNING id`,
    [userId, slot, docType],
  );
  return row.id;
}

async function page(documentId: string, part = 0, key = `uploads/kyc/${documentId}-${part}.png`) {
  await q(
    `INSERT INTO client_document_pages (document_id, part, storage_key, file_name)
     VALUES ($1, $2, $3, 'page.png')`,
    [documentId, part, key],
  );
}

const freeze = (id: string) =>
  q(`UPDATE client_documents SET frozen_at = now() WHERE id = $1`, [id]);

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const [row] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
     VALUES ('identity-schema@oxshare-e2e.test', 'x', 'Layla', 'Haddad', true) RETURNING id`,
  );
  userId = row.id;
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('a document version: a draft, then frozen for ever', () => {
  it('lets a draft be assembled — pages added, replaced, the type switched — and frozen', async () => {
    const id = await draft('identity');
    await page(id, 0);
    await q(
      `UPDATE client_document_pages SET storage_key = 'uploads/kyc/new.png' WHERE document_id = $1`,
      [id],
    );
    await q(`UPDATE client_documents SET doc_type = 'national_id' WHERE id = $1`, [id]);
    await freeze(id);
    const [row] = await q<{ frozen: boolean }>(
      `SELECT frozen_at IS NOT NULL AS frozen FROM client_documents WHERE id = $1`,
      [id],
    );
    expect(row.frozen).toBe(true);
  });

  it('REFUSES freezing a version with no pages — nothing presented is no evidence', async () => {
    const id = await draft('address', 'utility_bill');
    expect(
      await refusal(`UPDATE client_documents SET frozen_at = now() WHERE id = $1`, [id]),
    ).toMatch(/no pages cannot be frozen/);
    await q(`DELETE FROM client_documents WHERE id = $1`, [id]);
  });

  it('REFUSES every change to a frozen version, and to its pages — as a superuser', async () => {
    const id = await draft('identity');
    await page(id, 0);
    await freeze(id);

    expect(
      await refusal(`UPDATE client_documents SET doc_type = 'driving_license' WHERE id = $1`, [id]),
    ).toMatch(/frozen version never changes/);
    expect(await refusal(`DELETE FROM client_documents WHERE id = $1`, [id])).toMatch(
      /cannot be deleted/,
    );
    expect(
      await refusal(`UPDATE client_document_pages SET storage_key = 'x' WHERE document_id = $1`, [
        id,
      ]),
    ).toMatch(/pages of a frozen version never change/);
    expect(await refusal(`DELETE FROM client_document_pages WHERE document_id = $1`, [id])).toMatch(
      /pages of a frozen version never change/,
    );
    expect(
      await refusal(
        `INSERT INTO client_document_pages (document_id, part, storage_key) VALUES ($1, 1, 'uploads/kyc/late.png')`,
        [id],
      ),
    ).toMatch(/pages of a frozen version never change/);
  });

  it('stores a page under ONE spelling only — the one the file route looks up', async () => {
    const id = await draft('other:customField_spelling', null);
    for (const spelling of [
      '/uploads/kyc/x.png',
      './uploads/kyc/x.png',
      'uploads\\kyc\\x.png',
      'x.png',
      'uploads/kyc/.hidden.png',
      'uploads/kyc/',
      'uploads/avatars/x.png',
    ]) {
      expect(
        await refusal(
          `INSERT INTO client_document_pages (document_id, part, storage_key) VALUES ($1, 0, $2)`,
          [id, spelling],
        ),
        spelling,
      ).toMatch(/client_document_pages_key_ck/);
    }
    await page(id, 0, 'uploads/kyc/x.png');
  });

  it('lets a DRAFT be deleted, pages and all', async () => {
    const id = await draft('selfie', null);
    await page(id, 0);
    await q(`DELETE FROM client_documents WHERE id = $1`, [id]);
    expect(
      await q(`SELECT 1 FROM client_document_pages WHERE document_id = $1`, [id]),
    ).toHaveLength(0);
  });

  it('keeps ONE draft per client and slot — and allows the next once the first is frozen', async () => {
    const first = await draft('address', 'bank_statement');
    expect(
      await refusal(`INSERT INTO client_documents (user_id, slot) VALUES ($1, 'address')`, [
        userId,
      ]),
    ).toMatch(/client_documents_one_draft_uq/);
    await page(first, 0);
    await freeze(first);
    const second = await draft('address', 'utility_bill');
    expect(second).not.toBe(first);
  });

  it('refuses a slot that is not the platform’s or a broker’s upload', async () => {
    expect(
      await refusal(`INSERT INTO client_documents (user_id, slot) VALUES ($1, 'passport')`, [
        userId,
      ]),
    ).toMatch(/client_documents_slot_ck/);
    const own = await draft('other:customField_payslip', null);
    expect(own).toBeTruthy();
  });
});

describe('the verification log: every decision, never rewritten', () => {
  let decision: string;

  it('records a decision, and links the versions it covered', async () => {
    const doc = await draft('other:customField_linked', null);
    await page(doc, 0);
    await freeze(doc);
    const [row] = await q<{ id: string }>(
      `INSERT INTO client_verifications (user_id, seq, outcome, level_after, method, reason)
       VALUES ($1, 1, 'verified', 1, 'manual_review', NULL) RETURNING id`,
      [userId],
    );
    decision = row.id;
    await q(
      `INSERT INTO client_verification_documents (verification_id, document_id) VALUES ($1, $2)`,
      [decision, doc],
    );
  });

  it('REFUSES rewriting or removing a decision, or what it covered — as a superuser', async () => {
    expect(
      await refusal(`UPDATE client_verifications SET level_after = 0 WHERE id = $1`, [decision]),
    ).toMatch(/verification decision is history/);
    expect(await refusal(`DELETE FROM client_verifications WHERE id = $1`, [decision])).toMatch(
      /verification decision is history/,
    );
    expect(
      await refusal(`DELETE FROM client_verification_documents WHERE verification_id = $1`, [
        decision,
      ]),
    ).toMatch(/verification decision is history/);
  });

  it('refuses a decision whose outcome and level disagree, and a second row at the same step', async () => {
    expect(
      await refusal(
        `INSERT INTO client_verifications (user_id, seq, outcome, level_after, method)
         VALUES ($1, 2, 'verified', 0, 'manual_review')`,
        [userId],
      ),
    ).toMatch(/client_verifications_outcome_level_ck/);
    expect(
      await refusal(
        `INSERT INTO client_verifications (user_id, seq, outcome, level_after, method)
         VALUES ($1, 1, 'returned', 0, 'manual_review')`,
        [userId],
      ),
    ).toMatch(/client_verifications_seq_uq/);
  });

  it('keeps a provider’s decision idempotent by its reference', async () => {
    const insert = (seq: number) =>
      refusal(
        `INSERT INTO client_verifications (user_id, seq, outcome, level_after, method, provider, provider_ref)
         VALUES ($1, $2, 'returned', 0, 'provider', 'acme-kyc', 'session-42')`,
        [userId, seq],
      );
    expect(await insert(10)).toBeUndefined();
    expect(await insert(11)).toMatch(/client_verifications_provider_ref_uq/);
  });

  it('does not trap its neighbours: a named reason and admin can still be deleted', async () => {
    const [reason] = await q<{ id: string }>(
      `INSERT INTO rejection_reasons (context, label) VALUES ('kyc', 'Blurred') RETURNING id`,
    );
    const [admin] = await q<{ id: string }>(
      `INSERT INTO admins (email, password_hash, name, role, permissions, status)
       VALUES ('leaver@oxshare.com', 'x', 'Leaver', 'sub_admin', '[]', 'active') RETURNING id`,
    );
    await q(
      `INSERT INTO client_verifications (user_id, seq, outcome, level_after, method, admin_id, admin_email, reason_id, reason)
       VALUES ($1, 3, 'returned', 0, 'manual_review', $2, 'leaver@oxshare.com', $3, 'Blurred')`,
      [userId, admin.id, reason.id],
    );
    expect(
      await refusal(`DELETE FROM rejection_reasons WHERE id = $1`, [reason.id]),
    ).toBeUndefined();
    expect(await refusal(`DELETE FROM admins WHERE id = $1`, [admin.id])).toBeUndefined();
    // …and the decision still says who and why, in their words at the time.
    const [row] = await q<{ admin_email: string; reason: string }>(
      `SELECT admin_email, reason FROM client_verifications WHERE user_id = $1 AND seq = 3`,
      [userId],
    );
    expect(row).toEqual({ admin_email: 'leaver@oxshare.com', reason: 'Blurred' });
  });
});

describe('the one escape', () => {
  it('opens only inside its own transaction, and closes with it', async () => {
    const id = await draft('other:customField_escape', null);
    await page(id, 0);
    await freeze(id);

    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('oxshare.identity_maintenance', 'on', true)`);
      await client.query(`DELETE FROM client_documents WHERE id = $1`, [id]);
      await client.query('ROLLBACK'); // a test's teardown would COMMIT; the point is the scope
    } finally {
      client.release();
    }
    // A fresh transaction: the escape is closed again.
    expect(await refusal(`DELETE FROM client_documents WHERE id = $1`, [id])).toMatch(
      /cannot be deleted/,
    );
  });
});

describe('the migration', () => {
  it('runs a second time without error or change', async () => {
    const before = await q(`SELECT count(*)::int AS n FROM client_documents`);
    await q(SQL);
    expect(await q(`SELECT count(*)::int AS n FROM client_documents`)).toEqual(before);
  });
});
