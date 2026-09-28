import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * MIGRATION 0153 — the identity record follows the KYC rows at every commit,
 * whoever wrote them.
 *
 * Nothing here calls `identity_adopt` or any service: every write is raw SQL,
 * which is what an older build during a rollback, a dev script or a test
 * fixture does. The record must still end up in step — and a DECISION made in
 * several writes must be recorded as the decision it was, which only holds
 * because the triggers wait for COMMIT.
 */

const SQL = readFileSync(
  join(__dirname, '..', 'src', 'database', 'migrations', '0153_identity_follows_kyc.sql'),
  'utf8',
);

let ctx: MoneyTestContext;

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

/** Several statements as ONE transaction, the way a service writes a decision. */
async function inOneTransaction(statements: [string, unknown[]][]): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    for (const [text, values] of statements) await client.query(text, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const key = (name: string) => `uploads/kyc/mig0153-${name}.png`;
const passport = (name: string) =>
  JSON.stringify({ docType: 'passport', frontFilePath: key(name), frontFileName: `${name}.png` });

async function client(name: string): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'Layla', 'Haddad', true) RETURNING id`,
    [`mig0153-${name}@example.com`],
  );
  return row.id;
}

const versions = (user: string) =>
  q<{ frozen: boolean; keys: string[] }>(
    `SELECT d.frozen_at IS NOT NULL AS frozen,
            array_agg(p.storage_key ORDER BY p.part) AS keys
       FROM client_documents d JOIN client_document_pages p ON p.document_id = d.id
      WHERE d.user_id = $1 GROUP BY d.id ORDER BY d.created_at`,
    [user],
  );
const decisions = (user: string) =>
  q<{ outcome: string; level_after: number; method: string }>(
    `SELECT outcome, level_after, method FROM client_verifications WHERE user_id = $1 ORDER BY seq`,
    [user],
  );
const drift = (user: string) =>
  q(`SELECT problem, slot FROM identity_drift WHERE user_id = $1`, [user]);

beforeAll(async () => {
  ctx = await startMoneyTestDb();
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('0153 — the record follows every writer of the KYC rows', () => {
  it('a raw insert of a KYC row is followed: the client’s work is a draft', async () => {
    const user = await client('insert');
    await q(
      `INSERT INTO kyc_submissions (user_id, status, document) VALUES ($1, 'in_progress', $2)`,
      [user, passport('i-front')],
    );
    expect(await versions(user)).toEqual([{ frozen: false, keys: [key('i-front')] }]);
    expect(await drift(user)).toEqual([]);
  });

  it('an older build’s SUBMIT — the status alone — freezes what was presented', async () => {
    const user = await client('submit');
    await q(
      `INSERT INTO kyc_submissions (user_id, status, document) VALUES ($1, 'in_progress', $2)`,
      [user, passport('s-front')],
    );
    await q(`UPDATE kyc_submissions SET status = 'submitted' WHERE user_id = $1`, [user]);
    expect(await versions(user)).toEqual([{ frozen: true, keys: [key('s-front')] }]);
    expect(await drift(user)).toEqual([]);
  });

  it('an older build’s APPROVAL, written in one transaction, is recorded as the review it was', async () => {
    const user = await client('approve');
    await q(
      `INSERT INTO kyc_submissions (user_id, status, document) VALUES ($1, 'under_review', $2)`,
      [user, passport('a-front')],
    );
    // Status, archived attempt, level — the order approve() writes them in.
    // Adopted after the attempt alone, the level (still 0) would disagree with
    // the decision, and an invented legacy row would "explain" it.
    await inOneTransaction([
      [`UPDATE kyc_submissions SET status = 'approved' WHERE user_id = $1`, [user]],
      [
        `INSERT INTO kyc_submission_attempts (user_id, attempt_no, status, document, archived_at)
         VALUES ($1, 1, 'approved', $2, now())`,
        [user, passport('a-front')],
      ],
      [`UPDATE users SET verification_level = 1 WHERE id = $1`, [user]],
    ]);
    expect(await decisions(user)).toEqual([
      { outcome: 'verified', level_after: 1, method: 'manual_review' },
    ]);
    expect(await versions(user)).toEqual([{ frozen: true, keys: [key('a-front')] }]);
    expect(await drift(user)).toEqual([]);
  });

  it('an older build’s RETURN is recorded, on what was presented', async () => {
    const user = await client('return');
    await q(
      `INSERT INTO kyc_submissions (user_id, status, document) VALUES ($1, 'submitted', $2)`,
      [user, passport('r-front')],
    );
    await inOneTransaction([
      [`UPDATE kyc_submissions SET status = 'rejected' WHERE user_id = $1`, [user]],
      [
        `INSERT INTO kyc_submission_attempts
           (user_id, attempt_no, status, document, rejected_fields, rejection_reason, archived_at)
         VALUES ($1, 1, 'rejected', $2, '["doc_front"]', 'Blurred', now())`,
        [user, passport('r-front')],
      ],
    ]);
    expect(await decisions(user)).toEqual([
      { outcome: 'returned', level_after: 0, method: 'manual_review' },
    ]);
    expect(await drift(user)).toEqual([]);
  });

  it('an attempt written ON ITS OWN is followed — no KYC row moves with it', async () => {
    // A client who has since reset, whose history arrives by itself (an import,
    // a restore of one table): only the attempts' own trigger can see it.
    const user = await client('attempt-only');
    await q(
      `INSERT INTO kyc_submission_attempts (user_id, attempt_no, status, document, archived_at)
       VALUES ($1, 1, 'rejected', $2, now())`,
      [user, passport('o-front')],
    );
    expect(await decisions(user)).toEqual([
      { outcome: 'returned', level_after: 0, method: 'manual_review' },
    ]);
    expect(await versions(user)).toEqual([{ frozen: true, keys: [key('o-front')] }]);
  });

  it('an older build’s RESET is followed: the drafts go, what was decided stays', async () => {
    const user = await client('reset');
    await q(
      `INSERT INTO kyc_submissions (user_id, status, document) VALUES ($1, 'in_progress', $2)`,
      [user, passport('d-front')],
    );
    await q(`DELETE FROM kyc_submissions WHERE user_id = $1`, [user]);
    expect(await versions(user)).toEqual([]);
    expect(await drift(user)).toEqual([]);
  });

  it('a transaction that rolls back leaves the record untouched', async () => {
    const user = await client('rollback');
    await expect(
      inOneTransaction([
        [
          `INSERT INTO kyc_submissions (user_id, status, document) VALUES ($1, 'in_progress', $2)`,
          [user, passport('x-front')],
        ],
        ['SELECT 1 / 0', []],
      ]),
    ).rejects.toThrow(/division by zero/);
    expect(await versions(user)).toEqual([]);
  });

  it('runs a second time without error, and leaves one trigger of each', async () => {
    await q(SQL);
    const triggers = await q<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgname LIKE '%identity_follow%' ORDER BY tgname`,
    );
    expect(triggers.map((t) => t.tgname)).toEqual([
      'kyc_attempts_identity_follow',
      'kyc_attempts_identity_follow_update',
      'kyc_submissions_identity_follow',
      'kyc_submissions_identity_follow_update',
    ]);
  });
});
