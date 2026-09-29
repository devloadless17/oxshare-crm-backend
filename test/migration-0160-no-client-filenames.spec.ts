import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * 0160 — a client's original filename is neither kept nor shown (D-84).
 *
 * Migrates to 0159 and stores names everywhere they used to live: the upload
 * registry, a live submission, an archived attempt, a broker's upload answer —
 * and, written by 0153's triggers from those rows, the identity record's pages.
 * Then runs 0160 and looks for the names in EVERY text column of the database,
 * not only in the ones the migration names. The evidence itself — which file, at
 * which part, of which version — must come through untouched.
 */

const MIGRATIONS = join(__dirname, '..', 'src', 'database', 'migrations');
const TAG = '0160_no_client_filenames';
const SQL = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8');

/** In every name, and nowhere else — what the scan looks for. */
const CANARY = 'FNCANARY';
const named = (what: string) => `Layla_Haddad_${what}_X1234567_${CANARY}.png`;
const key = (file: string) => `uploads/kyc/mig0160-${file}.png`;

let ctx: MoneyTestContext;
let folder: string;
let userId: number;

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

/** Every text, varchar, json and jsonb column holding `needle`, as `table.column`. */
async function columnsHolding(needle: string): Promise<string[]> {
  const columns = await q<{ table_name: string; column_name: string }>(`
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')`);
  const hits: string[] = [];
  for (const { table_name, column_name } of columns) {
    const rows = await q(
      `SELECT 1 FROM "${table_name}" WHERE "${column_name}"::text LIKE $1 LIMIT 1`,
      [`%${needle}%`],
    );
    if (rows.length > 0) hits.push(`${table_name}.${column_name}`);
  }
  return hits;
}

const evidence = () => ({
  document: {
    docType: 'passport',
    frontFilePath: key('front'),
    frontFileName: named('passport_front'),
    backFilePath: key('back'),
    backFileName: named('passport_back'),
  },
  selfie: { filePath: key('selfie'), fileName: named('selfie') },
  addressProof: {
    docType: 'utility_bill',
    filePath: key('bill'),
    fileName: named('bill'),
    page2FilePath: key('bill2'),
    page2FileName: named('bill_page2'),
  },
  stepData: {
    extra: { customField_payslip: { filePath: key('payslip'), fileName: named('payslip') } },
  },
});

/** Each version's slot, type and page keys — what the evidence IS. */
const record = () =>
  q<{ slot: string; doc_type: string | null; frozen: boolean; keys: string[] }>(
    `SELECT d.slot, d.doc_type, d.frozen_at IS NOT NULL AS frozen,
            coalesce(array_agg(p.storage_key ORDER BY p.part)
                       FILTER (WHERE p.storage_key IS NOT NULL), '{}') AS keys
       FROM client_documents d LEFT JOIN client_document_pages p ON p.document_id = d.id
      WHERE d.user_id = $1 GROUP BY d.id ORDER BY d.slot, d.created_at`,
    [userId],
  );

let before: Awaited<ReturnType<typeof record>>;

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'mig0160-'));
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const stop = journal.entries.find((entry) => entry.tag === TAG);
  if (!stop) throw new Error(`${TAG} is not in the journal`);
  for (const entry of journal.entries.filter((e) => e.idx >= stop.idx)) {
    rmSync(join(folder, `${entry.tag}.sql`));
  }
  journal.entries = journal.entries.filter((entry) => entry.idx < stop.idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  ctx = await startMoneyTestDb({ migrationsFolder: folder });

  const [user] = await q<{ id: number }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
     VALUES ('mig0160@example.com', 'x', 'Layla', 'Haddad', true) RETURNING id`,
  );
  userId = user.id;
  const [admin] = await q<{ id: string }>(
    `INSERT INTO admins (email, password_hash, name, role, permissions, status)
     VALUES ('mig0160-reviewer@oxshare.com', 'x', 'Reviewer', 'sub_admin', '[]', 'active')
     RETURNING id`,
  );

  // The registry, as the upload route wrote it before 0160: with the device's name.
  for (const [file, what] of [
    ['front', 'passport_front'],
    ['back', 'passport_back'],
    ['selfie', 'selfie'],
    ['bill', 'bill'],
    ['bill2', 'bill_page2'],
    ['payslip', 'payslip'],
  ]) {
    await q(
      `INSERT INTO stored_objects (bucket, storage_key, provider, content_type, byte_size, sha256,
                                   original_name, owner_user_id, uploaded_by_id, uploaded_by_kind)
       VALUES ('kyc', $1, 'disk', 'image/png', 1, repeat('a', 64), $2, $3, $4, 'client')`,
      [key(file).replace(/^uploads\//, ''), named(what), userId, String(userId)],
    );
  }

  // An attempt a reviewer returned, and the live submission after it — both named.
  const e = evidence();
  await q(
    `INSERT INTO kyc_submission_attempts
       (user_id, attempt_no, status, document, selfie, address_proof, step_data,
        rejection_reason, submitted_at, reviewed_at, reviewed_by, archived_at)
     VALUES ($1, 1, 'rejected', $2, $3, $4, $5, 'Blurred', now() - interval '2 days',
             now() - interval '1 day', $6, now() - interval '1 day')`,
    [
      userId,
      JSON.stringify(e.document),
      JSON.stringify(e.selfie),
      JSON.stringify(e.addressProof),
      JSON.stringify(e.stepData),
      admin.id,
    ],
  );
  await q(
    `INSERT INTO kyc_submissions (user_id, status, document, selfie, address_proof, step_data)
     VALUES ($1, 'in_progress', $2, $3, $4, $5)`,
    [
      userId,
      JSON.stringify(e.document),
      JSON.stringify(e.selfie),
      JSON.stringify(e.addressProof),
      JSON.stringify(e.stepData),
    ],
  );

  before = await record();
  // Non-vacuous: before 0160 the names really were in every place listed above,
  // the identity record's pages included (0153 adopted them from the KYC rows).
  expect(await columnsHolding(CANARY)).toEqual(
    expect.arrayContaining([
      'client_document_pages.file_name',
      'kyc_submission_attempts.address_proof',
      'kyc_submission_attempts.document',
      'kyc_submission_attempts.selfie',
      'kyc_submission_attempts.step_data',
      'kyc_submissions.address_proof',
      'kyc_submissions.document',
      'kyc_submissions.selfie',
      'kyc_submissions.step_data',
      'stored_objects.original_name',
    ]),
  );

  await ctx.pool.query(SQL);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
  rmSync(folder, { recursive: true, force: true });
});

describe('0160 — a client’s original filename is neither kept nor shown', () => {
  it('leaves no name anywhere in the database', async () => {
    expect(await columnsHolding(CANARY)).toEqual([]);
  });

  it('drops both columns, so nothing can store a name again', async () => {
    const rows = await q<{ col: string }>(`
      SELECT table_name || '.' || column_name AS col FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (('client_document_pages', 'file_name'),
                                           ('stored_objects', 'original_name'))`);
    expect(rows).toEqual([]);
  });

  it('keeps every path, type and answer exactly as stored', async () => {
    const [live] = await q<{
      document: unknown;
      address_proof: unknown;
      selfie: unknown;
      step_data: unknown;
    }>(
      `SELECT document, address_proof, selfie, step_data FROM kyc_submissions WHERE user_id = $1`,
      [userId],
    );
    expect(live).toEqual({
      document: { docType: 'passport', frontFilePath: key('front'), backFilePath: key('back') },
      selfie: { filePath: key('selfie') },
      address_proof: {
        docType: 'utility_bill',
        filePath: key('bill'),
        page2FilePath: key('bill2'),
      },
      step_data: { extra: { customField_payslip: { filePath: key('payslip') } } },
    });
    const [archived] = await q<{ document: unknown }>(
      `SELECT document FROM kyc_submission_attempts WHERE user_id = $1`,
      [userId],
    );
    expect(archived.document).toEqual(live.document);
  });

  it('changes nothing about the evidence — no version made, none lost, the record healthy', async () => {
    expect(await record()).toEqual(before);
    expect(
      await q(`SELECT slot, problem FROM identity_drift WHERE user_id = $1`, [userId]),
    ).toEqual([]);
  });

  it('reads a version back as its paths and type alone', async () => {
    const [row] = await q<{ evidence: unknown }>(
      `SELECT identity_evidence(d.id, d.slot) AS evidence FROM client_documents d
        WHERE d.user_id = $1 AND d.slot = 'identity' ORDER BY d.created_at DESC LIMIT 1`,
      [userId],
    );
    expect(row.evidence).toEqual({
      docType: 'passport',
      frontFilePath: key('front'),
      backFilePath: key('back'),
    });
  });
});
