import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * MIGRATION 0148 — A QUESTION'S NAME OUTLIVES THE QUESTION (reported 26 Sep 2026).
 *
 * Production's review printed "Custom Field 1790263641710" for answers to
 * questions deleted from the form: an answer is stored under its key, and the
 * name lived only in the form. 0148 keeps every name in `kyc_field_labels` and
 * backfills it from everything that still knows one — the form, what each
 * submission was asked, and the forms the audit trail kept whole — newest first.
 *
 * The database is migrated to just before 0148, given a form, a submission and
 * an audit trail the way production has them, and then 0148 runs.
 */

const MIGRATIONS = join(__dirname, '..', 'src', 'database', 'migrations');
const TAG = '0148_kyc_field_labels';
const SQL = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8');

let ctx: MoneyTestContext;
let folder: string;

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

const field = (name: string, label: string, type = 'text') => ({
  id: `f-${name}`,
  name,
  label,
  type,
  required: false,
});

async function labels(): Promise<Record<string, string>> {
  const rows = await q<{ name: string; label: string; type: string }>(
    'SELECT name, label, type FROM kyc_field_labels ORDER BY name',
  );
  return Object.fromEntries(rows.map((row) => [row.name, `${row.label} (${row.type})`]));
}

async function audit(action: string, details: unknown, at: string) {
  await q(
    `INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id, details, created_at)
     VALUES ('00000000-0000-0000-0000-000000000000', 'system@oxshare.internal', 'system', $1, 'kyc_config', 'steps', $2, $3)`,
    [action, JSON.stringify(details), at],
  );
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'mig0148-'));
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const at = journal.entries.find((entry) => entry.tag === TAG);
  if (!at) throw new Error(`${TAG} is not in the journal`);
  for (const entry of journal.entries.filter((e) => e.idx >= at.idx)) {
    rmSync(join(folder, `${entry.tag}.sql`));
  }
  journal.entries = journal.entries.filter((entry) => entry.idx < at.idx);
  writeFileSync(journalPath, JSON.stringify(journal));

  ctx = await startMoneyTestDb({ migrationsFolder: folder });

  // ── The form as it stands: one question, renamed since clients answered it. ──
  await q('DELETE FROM kyc_config_steps');
  await q(
    `INSERT INTO kyc_config_steps (id, step_number, slug, title, description, icon, enabled, fields)
     VALUES ('step-1', 1, 'personal', 'Personal Information', '', 'User', true, '[]'),
            ('step-2', 2, 'document', 'Identity Document', '', 'X', true, $1),
            ('step-sof', 3, 'source-of-funds', 'Source of funds', '', 'X', true, $2)`,
    [
      JSON.stringify([field('passport', 'Passport', 'doc:passport')]),
      JSON.stringify([field('customField_now', 'Employer', 'text')]),
    ],
  );

  // ── What a submission was asked: the old name of that question, and one since deleted. ──
  const [client] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
     VALUES ('mig0148@oxshare-e2e.test', 'x', 'Layla', 'Haddad', true) RETURNING id`,
  );
  await q(
    `INSERT INTO kyc_submissions (user_id, status, submitted_at, form_snapshot)
     VALUES ($1, 'submitted', now(), $2)`,
    [
      client.id,
      JSON.stringify([
        {
          slug: 'source-of-funds',
          title: 'Source of funds',
          fields: [
            { name: 'customField_now', label: 'Employer name', type: 'text' },
            { name: 'customField_snap', label: 'Payslip', type: 'file' },
          ],
        },
      ]),
    ],
  );

  // ── The forms the audit trail kept whole: 0147's copy, then a later step edit. ──
  await audit(
    'kyc_config.consolidated',
    {
      changes: [],
      before: [
        {
          slug: 'custom slug 1',
          fields: [
            field('customField_gone', 'text1'),
            field('customField_edited', 'Old wording'),
            field('firstName', 'First Name'),
          ],
        },
      ],
      after: [{ slug: 'custom slug 1', fields: [field('customField_gone', 'text1')] }],
    },
    '2026-09-26 07:48:00+00',
  );
  await audit(
    'kyc_config.step_update',
    {
      slug: 'custom slug 1',
      patch: { title: 'custom1', fields: [field('customField_edited', 'New wording', 'checkbox')] },
    },
    '2026-09-26 09:00:00+00',
  );
  // An audit row that carries no form at all — the common shape — is simply skipped.
  await audit(
    'kyc_config.replace',
    { slugs: ['personal'], enabled: ['personal'] },
    '2026-09-26 10:00:00+00',
  );

  await ctx.pool.query(SQL);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
  rmSync(folder, { recursive: true, force: true });
});

describe('0148 — every name still on record is kept', () => {
  it('keeps the name the FORM gives a question it still asks — the newest', async () => {
    expect((await labels())['customField_now']).toBe('Employer (text)');
  });

  it('names a question only a submission remembers', async () => {
    expect((await labels())['customField_snap']).toBe('Payslip (file)');
  });

  it('names a question only the audit trail remembers — the most recent copy first', async () => {
    const recorded = await labels();
    expect(recorded['customField_gone']).toBe('text1 (text)');
    // The step edit is newer than 0147's copy of the form before it.
    expect(recorded['customField_edited']).toBe('New wording (checkbox)');
  });

  it('records none of the platform’s own fields — the identity, documents, slots', async () => {
    const recorded = await labels();
    expect(recorded).not.toHaveProperty('firstName');
    expect(recorded).not.toHaveProperty('passport');
    expect(Object.keys(recorded).sort()).toEqual([
      'customField_edited',
      'customField_gone',
      'customField_now',
      'customField_snap',
    ]);
  });

  it('runs again without changing anything', async () => {
    const before = await labels();
    await ctx.pool.query(SQL);
    expect(await labels()).toEqual(before);
  });
});
