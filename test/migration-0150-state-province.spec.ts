import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * MIGRATION 0150 — State / Province becomes an identity detail, and nothing a
 * broker already collected is lost or shown twice.
 *
 *  - the column exists on `users`, named `state_province` (not `state`, which
 *    `transactions` and `transfers` already carry);
 *  - a broker's own question that MEANS the state ("State", "Province",
 *    "Region") leaves the form: its answers are copied onto EMPTY profiles only
 *    (a value already there wins), the answers stay in the submission, and one
 *    audit row says what went — while "Bank Statement", which merely contains
 *    the letters, is left alone;
 *  - a custom field KEYED `stateProvince` is re-keyed with its answers, flags
 *    and name, so it is never read as the profile detail;
 *  - a role or invitation hiding the street address hides the state too;
 *  - running it twice changes nothing more.
 *
 * The database is migrated to 0149, the old shapes written as the old code
 * wrote them, then 0150 runs — the order production sees.
 */

const MIGRATIONS = join(__dirname, '..', 'src', 'database', 'migrations');
const TAG = '0150_state_province';
const SQL = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8');

let ctx: MoneyTestContext;
let folder: string;
const ids: Record<string, string> = {};

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

async function client(key: string, personal: Record<string, unknown>, stepData = {}) {
  const [row] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'Layla', 'Haddad', true) RETURNING id`,
    [`mig0150-${key}@oxshare-e2e.test`],
  );
  ids[key] = row.id;
  await q(
    `INSERT INTO kyc_submissions (user_id, status, personal_info, step_data, rejected_fields)
     VALUES ($1, 'submitted', $2, $3, $4)`,
    [row.id, JSON.stringify(personal), JSON.stringify(stepData), JSON.stringify(['stateProvince'])],
  );
}

const stateOf = async (key: string) =>
  (
    await q<{ s: string | null }>('SELECT state_province AS s FROM users WHERE id = $1', [ids[key]])
  )[0]?.s;

const formFields = async () =>
  (
    await q<{ slug: string; name: string; label: string }>(
      `SELECT s.slug, f->>'name' AS name, f->>'label' AS label
         FROM kyc_config_steps s, jsonb_array_elements(s.fields) f ORDER BY s.step_number`,
    )
  ).map((r) => `${r.slug}:${r.name}:${r.label}`);

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'mig0150-'));
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

  // The form: a "Province" question on Personal Information, a "Region" one on a
  // broker's step, a crafted field KEYED stateProvince, and a document whose
  // name merely contains the letters.
  await q(`DELETE FROM kyc_config_steps`);
  await q(
    `INSERT INTO kyc_config_steps (id, step_number, slug, title, description, icon, enabled, fields)
     VALUES
      ('step-1', 1, 'personal', 'Personal Information', '', 'User', true, $1),
      ('step-2', 2, 'address', 'Proof of Address', '', 'Home', true, $2),
      ('step-9', 3, 'extra', 'Extra', '', 'FileText', true, $3)`,
    [
      JSON.stringify([
        { id: 'c1', name: 'customField_1', label: 'Province', type: 'text', required: false },
        { id: 'c2', name: 'customField_2', label: 'Employer', type: 'text', required: false },
        // Contains the letters "state" — and means nothing of the kind.
        {
          id: 'c5',
          name: 'customField_5',
          label: 'Real estate agent',
          type: 'text',
          required: false,
        },
      ]),
      JSON.stringify([
        {
          id: 'd1',
          name: 'bankStatement',
          label: 'Bank Statement',
          type: 'doc:bank_statement',
          required: false,
        },
      ]),
      JSON.stringify([
        { id: 'c3', name: 'customField_3', label: 'Region', type: 'text', required: false },
        {
          id: 'c4',
          name: 'stateProvince',
          label: 'Department code',
          type: 'text',
          required: false,
        },
      ]),
    ],
  );

  // Answers: one client answered both questions; one already HAS a state on
  // the profile, which must win; one answered the crafted field.
  await client('answered', { customField_1: 'Mount Lebanon', customField_2: 'Acme' });
  await client('kept', { customField_1: 'Beqaa' });
  await client('region', {}, { extra: { customField_3: 'Kesrouan' } });
  await client('crafted', { stateProvince: 'D-75' }, { extra: { stateProvince: 'D-13' } });

  await q(
    `INSERT INTO roles (name, permissions, masked_fields, is_system)
     VALUES ('Hides address', '[]', '["client.address"]', false),
            ('Hides nothing', '[]', '[]', false)`,
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
  rmSync(folder, { recursive: true, force: true });
});

describe('0150 — State / Province', () => {
  it('adds the column, then folds each question MEANING the state into empty profiles', async () => {
    // The column must exist to seed the "already there" case, so add it first —
    // exactly as a second run of 0150 would find it.
    await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS state_province varchar(100)');
    await q(`UPDATE users SET state_province = 'North' WHERE id = $1`, [ids['kept']]);

    await q(SQL);

    expect(await stateOf('answered')).toBe('Mount Lebanon');
    expect(await stateOf('kept'), 'a value already on the profile was overwritten').toBe('North');
    expect(await stateOf('region')).toBe('Kesrouan');
  });

  it('removes those questions from the form, and leaves "Bank Statement" and the rest alone', async () => {
    const fields = await formFields();
    expect(fields).not.toContain('personal:customField_1:Province');
    expect(fields).not.toContain('extra:customField_3:Region');
    expect(fields).toContain('personal:customField_2:Employer');
    expect(fields, 'a question merely CONTAINING "state" was removed').toContain(
      'personal:customField_5:Real estate agent',
    );
    expect(fields).toContain('address:bankStatement:Bank Statement');
  });

  it('keeps every answer in the submission — nothing a client sent is deleted', async () => {
    const [row] = await q<{ personal_info: Record<string, string> }>(
      'SELECT personal_info FROM kyc_submissions WHERE user_id = $1',
      [ids['answered']],
    );
    expect(row.personal_info).toMatchObject({
      customField_1: 'Mount Lebanon',
      customField_2: 'Acme',
    });
  });

  it('re-keys a field KEYED stateProvince, with its answers and flags, so it is not read as the detail', async () => {
    const fields = await formFields();
    expect(fields).toContain('extra:customField_state_province_0150:Department code');
    expect(fields.some((f) => f.includes(':stateProvince:'))).toBe(false);

    const [row] = await q<{
      personal_info: Record<string, string>;
      step_data: Record<string, Record<string, string>>;
      rejected_fields: string[];
    }>('SELECT personal_info, step_data, rejected_fields FROM kyc_submissions WHERE user_id = $1', [
      ids['crafted'],
    ]);
    expect(row.personal_info).toEqual({ customField_state_province_0150: 'D-75' });
    expect(row.step_data['extra']).toEqual({ customField_state_province_0150: 'D-13' });
    expect(row.rejected_fields).toEqual(['customField_state_province_0150']);
    expect(await stateOf('crafted'), 'a re-keyed answer became the profile detail').toBeNull();
  });

  it('writes ONE audit row saying what left the form', async () => {
    const rows = await q<{ details: { changes: { name: string }[] } }>(
      `SELECT details FROM audit_log WHERE action = 'kyc_config.consolidated'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].details.changes.map((c) => c.name).sort()).toEqual([
      'customField_1',
      'customField_3',
    ]);
  });

  it('hides the state wherever the street address is hidden, and nowhere else', async () => {
    const roles = await q<{ name: string; masked_fields: string[] }>(
      `SELECT name, masked_fields FROM roles WHERE name IN ('Hides address', 'Hides nothing')`,
    );
    const byName = Object.fromEntries(roles.map((r) => [r.name, r.masked_fields]));
    expect(byName['Hides address']).toEqual(['client.address', 'client.stateProvince']);
    expect(byName['Hides nothing']).toEqual([]);
  });

  it('changes nothing more when it runs a second time', async () => {
    const before = {
      form: await formFields(),
      audits: (await q(`SELECT 1 FROM audit_log WHERE action = 'kyc_config.consolidated'`)).length,
      masks: await q(`SELECT masked_fields FROM roles ORDER BY name`),
    };
    await q(SQL);
    expect(await formFields()).toEqual(before.form);
    expect(
      (await q(`SELECT 1 FROM audit_log WHERE action = 'kyc_config.consolidated'`)).length,
    ).toBe(before.audits);
    expect(await q(`SELECT masked_fields FROM roles ORDER BY name`)).toEqual(before.masks);
  });
});
