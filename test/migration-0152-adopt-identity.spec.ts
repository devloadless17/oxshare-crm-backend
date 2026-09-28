import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * MIGRATION 0152 — every client's existing evidence and decisions adopted into
 * their identity record, nothing lost and nothing recorded twice.
 *
 * The shapes are the ones real data has (measured on the dev database: 419
 * attempts, 188 rows with a type and no pages, 11 verified clients with no
 * approved attempt, 10 re-verifications):
 *
 *  - an approved client whose live row is its last attempt: ONE version,
 *    linked to its `verified` decision;
 *  - a returned client who replaced the back page since: the returned version
 *    stays as presented, the new pages are a DRAFT;
 *  - a resubmission with nothing changed: one version, two decisions;
 *  - a re-verification, told apart from a rejection by its audit row;
 *  - a type chosen and no page uploaded: a draft carrying the type, nothing
 *    frozen;
 *  - a client who was reset: history adopted, no draft;
 *  - a verified fixture with no attempt: one `fixture` row, so the level is
 *    explained;
 *  - a broker's own upload: its own slot.
 *
 * And the two properties that let the same routine repair drift until the
 * contract slice: running it again changes nothing, and a write made to the
 * OLD columns only is listed by `identity_drift` and put right by it.
 */

const MIGRATIONS = join(__dirname, '..', 'src', 'database', 'migrations');
const TAG = '0152_adopt_identity_record';
const SQL = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8');

let ctx: MoneyTestContext;
let folder: string;
const ids: Record<string, string> = {};
let adminId: string;

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);
const key = (name: string) => `uploads/kyc/mig0152-${name}.png`;
const passport = (front: string) => ({
  docType: 'passport',
  frontFilePath: key(front),
  frontFileName: `${front}.png`,
});
const nationalId = (front: string, back: string) => ({
  docType: 'national_id',
  frontFilePath: key(front),
  backFilePath: key(back),
});
const selfie = (name: string) => ({ filePath: key(name), fileName: `${name}.png` });
const bill = (name: string) => ({ docType: 'utility_bill', filePath: key(name) });

async function client(name: string, level = 0): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, email_verified, verification_level)
     VALUES ($1, 'x', 'Layla', 'Haddad', true, $2) RETURNING id`,
    [name.includes('@') ? name : `mig0152-${name}@example.com`, level],
  );
  ids[name] = row.id;
  return row.id;
}

async function attempt(
  user: string,
  no: number,
  status: 'approved' | 'rejected',
  evidence: Record<string, unknown>,
  archived: Date,
  rejectedFields: string[] | null = null,
) {
  await q(
    `INSERT INTO kyc_submission_attempts
       (user_id, attempt_no, status, document, selfie, address_proof, step_data, rejected_fields,
        rejection_reason, submitted_at, reviewed_at, reviewed_by, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $10)`,
    [
      user,
      no,
      status,
      JSON.stringify(evidence['document'] ?? null),
      JSON.stringify(evidence['selfie'] ?? null),
      JSON.stringify(evidence['addressProof'] ?? null),
      JSON.stringify(evidence['stepData'] ?? {}),
      rejectedFields ? JSON.stringify(rejectedFields) : null,
      status === 'rejected' ? 'Blurred' : null,
      archived,
      adminId,
    ],
  );
}

async function live(user: string, status: string, evidence: Record<string, unknown>) {
  await q(
    `INSERT INTO kyc_submissions (user_id, status, document, selfie, address_proof, step_data, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      user,
      status,
      JSON.stringify(evidence['document'] ?? null),
      JSON.stringify(evidence['selfie'] ?? null),
      JSON.stringify(evidence['addressProof'] ?? null),
      JSON.stringify(evidence['stepData'] ?? {}),
      at(1),
    ],
  );
}

const versions = (user: string) =>
  q<{ slot: string; doc_type: string | null; frozen: boolean; keys: string[] }>(
    `SELECT d.slot, d.doc_type, d.frozen_at IS NOT NULL AS frozen,
            coalesce(array_agg(p.storage_key ORDER BY p.part) FILTER (WHERE p.storage_key IS NOT NULL), '{}') AS keys
       FROM client_documents d LEFT JOIN client_document_pages p ON p.document_id = d.id
      WHERE d.user_id = $1 GROUP BY d.id ORDER BY d.created_at, d.slot`,
    [user],
  );
const decisions = (user: string) =>
  q<{ seq: number; outcome: string; level_after: number; method: string; covered: number }>(
    `SELECT v.seq, v.outcome, v.level_after, v.method,
            (SELECT count(*)::int FROM client_verification_documents c WHERE c.verification_id = v.id) AS covered
       FROM client_verifications v WHERE v.user_id = $1 ORDER BY v.seq`,
    [user],
  );

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'mig0152-'));
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

  const [admin] = await q<{ id: string }>(
    `INSERT INTO admins (email, password_hash, name, role, permissions, status)
     VALUES ('mig0152-reviewer@oxshare.com', 'x', 'Reviewer', 'sub_admin', '[]', 'active') RETURNING id`,
  );
  adminId = admin.id;

  // Approved; the live row is exactly its last attempt.
  const approved = await client('approved', 1);
  const approvedEvidence = {
    document: passport('a-front'),
    selfie: selfie('a-selfie'),
    addressProof: bill('a-bill'),
  };
  await attempt(approved, 1, 'approved', approvedEvidence, at(10));
  await live(approved, 'approved', approvedEvidence);

  // Returned for the back page; the client has uploaded a new back since.
  const returned = await client('returned');
  await attempt(returned, 1, 'rejected', { document: nationalId('r-front', 'r-back') }, at(5), [
    'doc_back',
  ]);
  await live(returned, 'in_progress', { document: nationalId('r-front', 'r-back-2') });

  // Resubmitted unchanged, then approved: one version, two decisions.
  const again = await client('again', 1);
  const same = { document: passport('s-front') };
  await attempt(again, 1, 'rejected', same, at(8), ['firstName']);
  await attempt(again, 2, 'approved', same, at(6));
  await live(again, 'approved', same);

  // A re-verification: archived as `rejected`, with its audit row.
  const reverified = await client('reverified');
  await attempt(reverified, 1, 'approved', { document: passport('v-front') }, at(20));
  await attempt(reverified, 2, 'rejected', { document: passport('v-front') }, at(3), ['doc_front']);
  await q(
    `INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id, details, created_at)
     VALUES ($1, 'mig0152-reviewer@oxshare.com', 'admin', 'kyc.reverification_request', 'kyc_submission', $2, '{}', $3)`,
    [adminId, reverified, at(3)],
  );
  await live(reverified, 'rejected', { document: passport('v-front') });

  // A re-verification flagged by the code that archived it, with no audit row
  // (the live case: that row is written after the decision commits).
  const flagged = await client('flagged');
  await attempt(flagged, 1, 'rejected', { document: passport('f-front') }, at(2), ['doc_front']);
  await q(`UPDATE kyc_submission_attempts SET reverification = true WHERE user_id = $1`, [flagged]);

  // A type chosen, no page yet.
  const typeOnly = await client('type-only');
  await live(typeOnly, 'in_progress', { document: { docType: 'national_id' } });

  // Reset: attempts, no live row.
  const reset = await client('reset');
  await attempt(reset, 1, 'rejected', { selfie: selfie('x-selfie') }, at(30), ['selfie']);

  // A verified fixture with no attempt at all.
  await client('mig0152-fixture@oxshare-e2e.test', 1);

  // A broker's own upload.
  const custom = await client('custom');
  await attempt(
    custom,
    1,
    'approved',
    {
      stepData: {
        extra: { customField_payslip: { filePath: key('c-payslip'), fileName: 'payslip.pdf' } },
      },
    },
    at(4),
  );

  await q(SQL);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
  rmSync(folder, { recursive: true, force: true });
});

describe('0152 — adopting the evidence', () => {
  it('an approved client: ONE version per document, linked to its verified decision', async () => {
    const v = await versions(ids['approved']);
    expect(v).toEqual(
      expect.arrayContaining([
        { slot: 'identity', doc_type: 'passport', frozen: true, keys: [key('a-front')] },
        { slot: 'selfie', doc_type: null, frozen: true, keys: [key('a-selfie')] },
        { slot: 'address', doc_type: 'utility_bill', frozen: true, keys: [key('a-bill')] },
      ]),
    );
    expect(v).toHaveLength(3);
    expect(await decisions(ids['approved'])).toEqual([
      { seq: 1, outcome: 'verified', level_after: 1, method: 'manual_review', covered: 3 },
    ]);
    const [row] = await q<{ ok: boolean }>(
      `SELECT k.identity_document_id = a.identity_document_id AS ok
         FROM kyc_submissions k JOIN kyc_submission_attempts a USING (user_id) WHERE k.user_id = $1`,
      [ids['approved']],
    );
    expect(row.ok, 'the live row and its attempt point at different versions').toBe(true);
  });

  it('a returned client: what was presented stays frozen, the new pages are a draft', async () => {
    expect(await versions(ids['returned'])).toEqual([
      {
        slot: 'identity',
        doc_type: 'national_id',
        frozen: true,
        keys: [key('r-front'), key('r-back')],
      },
      {
        slot: 'identity',
        doc_type: 'national_id',
        frozen: false,
        keys: [key('r-front'), key('r-back-2')],
      },
    ]);
    expect(await decisions(ids['returned'])).toEqual([
      { seq: 1, outcome: 'returned', level_after: 0, method: 'manual_review', covered: 1 },
    ]);
  });

  it('a resubmission with nothing changed: one version, two decisions', async () => {
    expect(await versions(ids['again'])).toHaveLength(1);
    expect((await decisions(ids['again'])).map((d) => [d.outcome, d.covered])).toEqual([
      ['returned', 1],
      ['verified', 1],
    ]);
  });

  it('tells a re-verification from a rejection by its audit row', async () => {
    expect((await decisions(ids['reverified'])).map((d) => d.outcome)).toEqual([
      'verified',
      'reverification_requested',
    ]);
    const [row] = await q<{ reverification: boolean }>(
      `SELECT reverification FROM kyc_submission_attempts WHERE user_id = $1 AND attempt_no = 2`,
      [ids['reverified']],
    );
    expect(row.reverification).toBe(true);
    // The live row is exactly that frozen version: no draft is invented.
    expect((await versions(ids['reverified'])).map((v) => v.frozen)).toEqual([true]);
  });

  it('trusts the attempt’s own re-verification flag, without an audit row', async () => {
    expect((await decisions(ids['flagged'])).map((d) => d.outcome)).toEqual([
      'reverification_requested',
    ]);
  });

  it('a type with no page: a draft carrying the type — nothing frozen', async () => {
    expect(await versions(ids['type-only'])).toEqual([
      { slot: 'identity', doc_type: 'national_id', frozen: false, keys: [] },
    ]);
  });

  it('a reset client: the history adopted, and no draft', async () => {
    expect(await versions(ids['reset'])).toEqual([
      { slot: 'selfie', doc_type: null, frozen: true, keys: [key('x-selfie')] },
    ]);
    expect((await decisions(ids['reset'])).map((d) => d.outcome)).toEqual(['returned']);
  });

  it('a verified fixture with no attempt: one fixture row explains the level', async () => {
    expect(await decisions(ids['mig0152-fixture@oxshare-e2e.test'])).toEqual([
      { seq: 1, outcome: 'verified', level_after: 1, method: 'fixture', covered: 0 },
    ]);
  });

  it('a broker’s own upload gets its own slot', async () => {
    expect(await versions(ids['custom'])).toEqual([
      { slot: 'other:customField_payslip', doc_type: null, frozen: true, keys: [key('c-payslip')] },
    ]);
  });
});

describe('0152 — the invariants', () => {
  it('every level equals the latest decision', async () => {
    const rows = await q(
      `SELECT u.id FROM users u
        WHERE u.verification_level IS DISTINCT FROM coalesce(
          (SELECT level_after FROM client_verifications v WHERE v.user_id = u.id ORDER BY seq DESC LIMIT 1), 0)`,
    );
    expect(rows).toEqual([]);
  });

  it('no file belongs to two clients, and nothing is out of step', async () => {
    expect(
      await q(`SELECT p.storage_key FROM client_document_pages p JOIN client_documents d ON d.id = p.document_id
               GROUP BY p.storage_key HAVING count(DISTINCT d.user_id) > 1`),
    ).toEqual([]);
    expect(await q(`SELECT * FROM identity_drift`)).toEqual([]);
  });

  it('changes nothing when it runs again', async () => {
    const count = async () =>
      (
        await q<{ d: number; v: number; p: number }>(
          `SELECT (SELECT count(*)::int FROM client_documents) AS d,
                (SELECT count(*)::int FROM client_verifications) AS v,
                (SELECT count(*)::int FROM client_document_pages) AS p`,
        )
      )[0];
    const before = await count();
    await q(SQL);
    expect(await count()).toEqual(before);
  });

  it('lists a write made to the OLD columns only, and puts it right', async () => {
    // What an older build (after a rollback) or a fixture reset does: the old
    // column moves, the record does not.
    await q(
      `UPDATE kyc_submissions SET document = jsonb_set(document, '{backFilePath}', $2) WHERE user_id = $1`,
      [ids['returned'], JSON.stringify(key('r-back-3'))],
    );
    expect(await q(`SELECT user_id, slot, problem FROM identity_drift`)).toEqual([
      { user_id: ids['returned'], slot: 'identity', problem: 'pages' },
    ]);
    await q(`SELECT identity_adopt($1)`, [ids['returned']]);
    expect(await q(`SELECT * FROM identity_drift`)).toEqual([]);
    const draft = (await versions(ids['returned'])).find((v) => !v.frozen);
    expect(draft?.keys).toEqual([key('r-front'), key('r-back-3')]);
  });
});

describe('0152 — every kind of drift is listed, and ONE adoption clears it', () => {
  /*
   * Each case starts a client IN STEP, then makes one write to the OLD columns
   * only — what an older build does after a rollback, or raw SQL. The view must
   * name exactly that, and `identity_adopt` must clear it: the boot repair
   * adopts every client the view lists, so a kind adoption could not clear
   * would be "repaired" — and alerted — on every boot for ever.
   */
  const drift = (user: string) =>
    q<{ problem: string; slot: string | null }>(
      `SELECT DISTINCT problem, slot FROM identity_drift WHERE user_id = $1 ORDER BY problem, slot`,
      [user],
    );
  const set =
    (text: string, ...values: unknown[]) =>
    async (user: string) => {
      await q(text, [user, ...values]);
    };

  const cases: {
    name: string;
    start: (user: string) => Promise<void>;
    write: (user: string) => Promise<void>;
    listed: { problem: string; slot: string | null }[];
    after?: (user: string) => Promise<void>;
  }[] = [
    {
      name: 'the document type switched',
      start: (u) => live(u, 'in_progress', { document: nationalId('t-front', 't-back') }),
      write: set(
        `UPDATE kyc_submissions SET document = jsonb_set(document, '{docType}', '"residence_permit"')
          WHERE user_id = $1`,
      ),
      listed: [{ problem: 'type', slot: 'identity' }],
    },
    {
      name: 'submitted by an older build',
      start: (u) => live(u, 'in_progress', { document: passport('n-front') }),
      write: set(`UPDATE kyc_submissions SET status = 'submitted' WHERE user_id = $1`),
      listed: [
        { problem: 'not_frozen', slot: 'identity' },
        { problem: 'stale_draft', slot: 'identity' },
      ],
      after: async (u) => {
        expect(await versions(u)).toEqual([
          { slot: 'identity', doc_type: 'passport', frozen: true, keys: [key('n-front')] },
        ]);
      },
    },
    {
      name: 'a broker’s upload replaced',
      start: (u) =>
        live(u, 'in_progress', {
          stepData: { extra: { customField_payslip: { filePath: key('u-1'), fileName: 'p.pdf' } } },
        }),
      write: set(
        `UPDATE kyc_submissions
            SET step_data = jsonb_set(step_data, '{extra,customField_payslip,filePath}', $2)
          WHERE user_id = $1`,
        JSON.stringify(key('u-2')),
      ),
      listed: [{ problem: 'upload', slot: 'other:customField_payslip' }],
    },
    {
      name: 'a broker’s upload removed',
      start: (u) =>
        live(u, 'in_progress', {
          stepData: {
            extra: { customField_payslip: { filePath: key('ur-1'), fileName: 'p.pdf' } },
          },
        }),
      write: set(`UPDATE kyc_submissions SET step_data = '{}' WHERE user_id = $1`),
      listed: [{ problem: 'stale_draft', slot: 'other:customField_payslip' }],
    },
    {
      name: 'submitted by an older build, with a broker’s upload',
      start: (u) =>
        live(u, 'in_progress', {
          stepData: {
            extra: { customField_payslip: { filePath: key('us-1'), fileName: 'p.pdf' } },
          },
        }),
      write: set(`UPDATE kyc_submissions SET status = 'submitted' WHERE user_id = $1`),
      // Presented, so only a FROZEN version holds it — the draft does not count.
      listed: [
        { problem: 'stale_draft', slot: 'other:customField_payslip' },
        { problem: 'upload', slot: 'other:customField_payslip' },
      ],
    },
    {
      name: 'a page rewritten on an archived attempt',
      start: (u) => attempt(u, 1, 'rejected', { selfie: selfie('p-1') }, at(3), ['selfie']),
      write: set(
        `UPDATE kyc_submission_attempts SET selfie = jsonb_set(selfie, '{filePath}', $2)
          WHERE user_id = $1`,
        JSON.stringify(key('p-2')),
      ),
      listed: [{ problem: 'unrecorded_page', slot: 'selfie' }],
    },
    {
      name: 'reset by an older build',
      start: (u) => live(u, 'in_progress', { document: passport('d-front') }),
      write: set(`DELETE FROM kyc_submissions WHERE user_id = $1`),
      listed: [{ problem: 'stale_draft', slot: 'identity' }],
    },
    {
      name: 'returned by an older build',
      start: (u) => live(u, 'submitted', { document: passport('o-front') }),
      write: async (u) => {
        await attempt(u, 1, 'rejected', { document: passport('o-front') }, at(0), ['doc_front']);
        await q(`UPDATE kyc_submissions SET status = 'rejected' WHERE user_id = $1`, [u]);
      },
      listed: [{ problem: 'undecided_attempt', slot: null }],
    },
    {
      name: 'approved by an older build',
      start: (u) => live(u, 'under_review', { document: passport('ap-front') }),
      write: async (u) => {
        await attempt(u, 1, 'approved', { document: passport('ap-front') }, at(0));
        await q(`UPDATE kyc_submissions SET status = 'approved' WHERE user_id = $1`, [u]);
        await q(`UPDATE users SET verification_level = 1 WHERE id = $1`, [u]);
      },
      listed: [
        { problem: 'level', slot: null },
        { problem: 'undecided_attempt', slot: null },
      ],
      // The decision it made, as a review — not a `legacy` row explaining the level.
      after: async (u) => {
        expect(await decisions(u)).toEqual([
          { seq: 1, outcome: 'verified', level_after: 1, method: 'manual_review', covered: 1 },
        ]);
      },
    },
    {
      name: 'a level set directly',
      start: async () => {},
      write: set(`UPDATE users SET verification_level = 1 WHERE id = $1`),
      listed: [{ problem: 'level', slot: null }],
      after: async (u) => {
        expect((await decisions(u)).map((d) => [d.outcome, d.method])).toEqual([
          ['verified', 'legacy'],
        ]);
      },
    },
  ];

  it.each(cases)('$name', async ({ name, start, write, listed, after }) => {
    const user = await client(`drift-${name.replace(/\W+/g, '-')}`);
    await start(user);
    await q(`SELECT identity_adopt($1)`, [user]);
    expect(await drift(user), 'the client did not start in step').toEqual([]);

    await write(user);
    expect(await drift(user)).toEqual(listed);

    await q(`SELECT identity_adopt($1)`, [user]);
    expect(await drift(user), 'one adoption did not clear it').toEqual([]);
    await after?.(user);
  });
});

describe('0152 — adoption waits for a KYC change in flight', () => {
  it('takes the client’s KYC row before it touches the record', async () => {
    // In step, then an attempt archived without the record: adopting it writes
    // only record rows and the attempt — nothing that would itself have to
    // wait for the KYC row. Only the lock taken first makes it wait.
    const user = await client('in-flight');
    await live(user, 'submitted', { document: passport('w-front') });
    await q(`SELECT identity_adopt($1)`, [user]);
    await attempt(user, 1, 'rejected', { document: passport('w-front') }, at(0), ['doc_front']);

    const holder = await ctx.pool.connect();
    const repair = await ctx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM kyc_submissions WHERE user_id = $1 FOR UPDATE`, [user]);
      await repair.query('BEGIN');
      await repair.query(`SET LOCAL lock_timeout = '300ms'`);
      await expect(repair.query(`SELECT identity_adopt($1)`, [user])).rejects.toThrow(
        /lock timeout/,
      );
      await repair.query('ROLLBACK');
      await holder.query('COMMIT');
    } finally {
      holder.release();
      repair.release();
    }
    // The KYC change done, the adoption goes through.
    await q(`SELECT identity_adopt($1)`, [user]);
    expect((await decisions(user)).map((d) => d.outcome)).toEqual(['returned']);
  });
});
