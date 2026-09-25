import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * MIGRATION 0139 — two copies of every client's identity become ONE, and
 * nothing is lost on the way.
 *
 * The migration runs once, against every real client's data, and cannot be
 * re-run with a fix: a value it drops is gone, and a value it picks wrongly is
 * a client whose verified name silently changed. So its rules are proven here
 * on the data shapes that actually exist, rather than trusted from reading SQL:
 *
 *  - the KYC answer wins, because it is the one entered "as on your ID" and a
 *    reviewer checked it — the "t1" registered, "test1" verified case;
 *  - UNLESS the support desk corrected that field on the profile after the KYC
 *    answer was written: then the correction stands;
 *  - a value that cannot be stored (not a real day, longer than its column) is
 *    recorded as discarded — never truncated, never guessed at;
 *  - every change is one audit row per client, before / after / discarded;
 *  - the submission keeps only a broker's own questions;
 *  - masks follow the fields to their new keys, and the KYC form is repaired.
 *
 * The database is migrated to 0138, the legacy rows are written the way the
 * old code wrote them, and then 0139 runs — the order production sees.
 */

const MIGRATIONS = join(__dirname, '..', 'src', 'database', 'migrations');
const TAG = '0139_client_profile_single_home';
const SQL = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8');

let ctx: MoneyTestContext;
let folder: string;
const ids: Record<string, string> = {};

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

async function user(key: string) {
  const [row] = await q(
    `SELECT first_name, last_name, phone, country, to_char(date_of_birth, 'YYYY-MM-DD') AS dob,
            nationality, address, city, postal_code
       FROM users WHERE id = $1`,
    [ids[key]],
  );
  return row;
}

async function personalInfo(key: string) {
  const [row] = await q<{ personal_info: unknown }>(
    'SELECT personal_info FROM kyc_submissions WHERE user_id = $1',
    [ids[key]],
  );
  return row?.personal_info;
}

async function consolidation(key: string) {
  return q<{ actor_kind: string; details: Record<string, Record<string, string>> }>(
    `SELECT actor_kind, details FROM audit_log
      WHERE action = 'client.profile_consolidated' AND subject_id = $1`,
    [ids[key]],
  );
}

/** A legacy client: the users row as registration wrote it, the KYC blob as the form did. */
async function legacyClient(
  key: string,
  profile: Record<string, string | null>,
  personal: Record<string, string> | null,
  kycUpdatedAt = new Date(Date.now() - 2 * 86_400_000),
) {
  const [row] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, phone, country, email_verified)
     VALUES ($1, 'x', $2, $3, $4, $5, true) RETURNING id`,
    [
      `mig0139-${key}@oxshare-e2e.test`,
      profile['firstName'] ?? 'Legacy',
      profile['lastName'] ?? 'Client',
      profile['phone'] ?? null,
      profile['country'] ?? null,
    ],
  );
  ids[key] = row.id;
  if (personal) {
    await q(
      `INSERT INTO kyc_submissions (user_id, status, personal_info, updated_at)
       VALUES ($1, 'approved', $2, $3)`,
      [row.id, JSON.stringify(personal), kycUpdatedAt],
    );
  }
}

beforeAll(async () => {
  /*
   * The committed history, stopped just before 0139 — a copy of the folder with
   * 0139 and anything after it left out, so the legacy rows below meet the
   * schema they were written against.
   */
  folder = mkdtempSync(join(tmpdir(), 'mig0139-'));
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

  // ── The reported case: registered as "t1", verified as "test1". ──
  await legacyClient(
    't1',
    { firstName: 't1', lastName: 'x', phone: '+961 70 123 456', country: 'LB' },
    {
      firstName: 'test1',
      lastName: 'Newman',
      phone: '+961 70 999 999',
      dateOfBirth: '1990-06-15T00:00:00.000Z',
      nationality: 'Lebanese',
      country: 'Lebanon',
      address: '  Hamra   Street  ',
      city: 'Beirut',
      postalCode: '1103',
      customField_1790000000001: 'Engineer',
    },
  );

  // ── The desk corrected the name AFTER the KYC answer: the desk's stands. ──
  await legacyClient(
    'desk',
    { firstName: 'Deskfixed', lastName: 'Surname' },
    { firstName: 'Kycname', lastName: 'Surname' },
    new Date(Date.now() - 3 * 86_400_000),
  );
  await q(
    `INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id,
                            details, created_at)
     VALUES ('00000000-0000-0000-0000-000000000001', 'desk@oxshare.com', 'admin',
             'client.profile_update', 'user', $1, $2, $3)`,
    [
      ids['desk'],
      JSON.stringify({ before: { firstName: 'Kycname' }, after: { firstName: 'Deskfixed' } }),
      new Date(Date.now() - 1 * 86_400_000),
    ],
  );

  // ── …but a desk edit OLDER than the KYC answer loses to it. ──
  await legacyClient(
    'stale-desk',
    { firstName: 'Olddesk', lastName: 'Surname' },
    { firstName: 'Newerkyc' },
    new Date(Date.now() - 1 * 86_400_000),
  );
  await q(
    `INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id,
                            details, created_at)
     VALUES ('00000000-0000-0000-0000-000000000001', 'desk@oxshare.com', 'admin',
             'client.profile_update', 'user', $1, $2, $3)`,
    [
      ids['stale-desk'],
      JSON.stringify({ after: { firstName: 'Olddesk' } }),
      new Date(Date.now() - 5 * 86_400_000),
    ],
  );

  // ── Values that cannot be stored are recorded, never truncated or guessed. ──
  await legacyClient(
    'unstorable',
    { firstName: 'Kept', lastName: 'Name' },
    {
      dateOfBirth: '1990-02-31',
      address: 'x'.repeat(250),
      nationality: 'Lebanese',
    },
  );

  // ── The same number typed two ways is not a change. ──
  await legacyClient(
    'same-phone',
    { firstName: 'Same', lastName: 'Phone', phone: '+961 70 555 555' },
    { phone: '+96170555555' },
  );

  // ── No KYC at all: only the profile's own shape is tidied. ──
  await legacyClient(
    'no-kyc',
    { firstName: 'Only', lastName: 'Profile', phone: '+961 3 111 222', country: '  ' },
    null,
  );

  // ── Masks written against the KYC keys. ──
  const [role] = await q<{ id: string }>(
    `INSERT INTO roles (name, permissions, masked_fields) VALUES ('Mig0139 Role', '[]', $1) RETURNING id`,
    [JSON.stringify(['kyc.personalInfo.dateOfBirth', 'kyc.personalInfo.address', 'client.email'])],
  );
  ids['role'] = role.id;
  const [admin] = await q<{ id: string }>(
    `INSERT INTO admins (email, password_hash, name, role, role_id, permissions, masked_fields, status)
     VALUES ('mig0139-admin@oxshare.com', 'x', 'Mig0139', 'sub_admin', $1, '[]', $2, 'active')
     RETURNING id`,
    [role.id, JSON.stringify(['kyc.personalInfo.nationality'])],
  );
  ids['admin'] = admin.id;

  // ── The KYC form as an older builder saved it. ──
  await q(`DELETE FROM kyc_config_steps`);
  await q(
    `INSERT INTO kyc_config_steps (id, step_number, slug, title, description, icon, enabled, fields)
     VALUES ('step-1', 1, 'personal', 'Personal Information', '', 'User', true, $1),
            ('step-2', 2, 'document', 'Identity Document', '', 'FileText', true, $2)`,
    [
      JSON.stringify([
        { id: 'f-1', name: 'firstName', label: 'First Name', type: 'text', required: true },
        // Re-typed by an operator — the date column cannot take free text.
        { id: 'f-3', name: 'dateOfBirth', label: 'Date of Birth', type: 'text', required: true },
        // The builder baked the whole list into the row on its first save.
        {
          id: 'f-5',
          name: 'nationality',
          label: 'Nationality',
          type: 'select',
          required: true,
          options: ['Lebanese', 'Syrian'],
        },
        { id: 'f-7', name: 'address', label: 'Residential Address', type: 'text' },
        { id: 'x-1', name: 'customField_1790000000001', label: 'Occupation', type: 'text' },
      ]),
      JSON.stringify([
        { id: 'f-doc-passport', name: 'passport', label: 'Passport', type: 'doc:passport' },
        // A broker's own select on another step keeps what they typed.
        { id: 'x-2', name: 'shade', label: 'Shade', type: 'select', options: ['a', 'b'] },
      ]),
    ],
  );

  await ctx.pool.query(SQL);
}, 240_000);

afterAll(async () => {
  if (ctx) await stopMoneyTestDb(ctx);
  if (folder) rmSync(folder, { recursive: true, force: true });
});

describe('the KYC answer wins — the verified identity becomes the account’s', () => {
  it('turns "t1" into the name the client verified, and moves every other field home', async () => {
    expect(await user('t1')).toEqual({
      first_name: 'test1',
      last_name: 'Newman',
      phone: '+96170999999',
      country: 'Lebanon',
      dob: '1990-06-15',
      nationality: 'Lebanese',
      address: 'Hamra Street',
      city: 'Beirut',
      postal_code: '1103',
    });
  });

  it('leaves the submission holding ONLY the broker’s own question', async () => {
    expect(await personalInfo('t1')).toEqual({ customField_1790000000001: 'Engineer' });
  });

  it('records what changed in one audit row, by the system, with both sides', async () => {
    const rows = await consolidation('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_kind).toBe('system');
    expect(rows[0].details.before).toEqual({
      firstName: 't1',
      lastName: 'x',
      phone: '+961 70 123 456',
      country: 'LB',
    });
    expect(rows[0].details.after).toMatchObject({
      firstName: 'test1',
      lastName: 'Newman',
      phone: '+96170999999',
      country: 'Lebanon',
      dateOfBirth: '1990-06-15',
    });
  });
});

describe('the desk’s later correction stands', () => {
  it('keeps a name the desk corrected AFTER the KYC answer, and records the answer not taken', async () => {
    expect((await user('desk'))['first_name']).toBe('Deskfixed');
    const [row] = await consolidation('desk');
    expect(row.details.discarded).toEqual({ firstName: 'Kycname' });
    expect(row.details.after ?? {}).not.toHaveProperty('firstName');
  });

  it('but a desk edit OLDER than the KYC answer is the one replaced', async () => {
    expect((await user('stale-desk'))['first_name']).toBe('Newerkyc');
  });
});

describe('nothing is truncated, guessed at, or lost', () => {
  it('records an impossible date and an over-long address as discarded, and stores the rest', async () => {
    const stored = await user('unstorable');
    expect(stored['dob']).toBeNull();
    expect(stored['address']).toBeNull();
    expect(stored['nationality']).toBe('Lebanese');
    const [row] = await consolidation('unstorable');
    expect(row.details.discarded).toEqual({ dateOfBirth: '1990-02-31', address: 'x'.repeat(250) });
  });

  it('does not count the same phone number typed another way as a change', async () => {
    expect((await user('same-phone'))['phone']).toBe('+96170555555');
    const [row] = await consolidation('same-phone');
    expect(row?.details.after ?? {}).not.toHaveProperty('phone');
  });

  it('tidies a profile that had no KYC at all — one phone shape, no blank country', async () => {
    const stored = await user('no-kyc');
    expect(stored['phone']).toBe('+9613111222');
    expect(stored['country']).toBeNull();
    expect(await consolidation('no-kyc')).toEqual([]);
  });
});

describe('masks follow the fields to their new keys', () => {
  it('moves a role’s KYC masks onto the profile keys — the address taking the city and postal code with it', async () => {
    const [role] = await q<{ masked_fields: string[] }>(
      'SELECT masked_fields FROM roles WHERE id = $1',
      [ids['role']],
    );
    expect([...role.masked_fields].sort()).toEqual(
      [
        'client.address',
        'client.city',
        'client.dateOfBirth',
        'client.email',
        'client.postalCode',
      ].sort(),
    );
  });

  it('moves a personal override too, leaving nothing on the old key', async () => {
    const [admin] = await q<{ masked_fields: string[] }>(
      'SELECT masked_fields FROM admins WHERE id = $1',
      [ids['admin']],
    );
    expect(admin.masked_fields).toEqual(['client.nationality']);
  });
});

describe('the KYC form asks for the whole profile, at the right types', () => {
  const fieldsOf = async (slug: string) =>
    (
      await q<{ fields: Record<string, unknown>[] }>(
        'SELECT fields FROM kyc_config_steps WHERE slug = $1',
        [slug],
      )
    )[0].fields;

  it('adds city and postal code right after the address, optional, under ids that cannot collide', async () => {
    const names = (await fieldsOf('personal')).map((field) => field['name']);
    expect(names).toEqual([
      'firstName',
      'dateOfBirth',
      'nationality',
      'address',
      'city',
      'postalCode',
      'customField_1790000000001',
    ]);
    const added = (await fieldsOf('personal')).filter((f) =>
      ['city', 'postalCode'].includes(f['name'] as string),
    );
    expect(added.map((f) => [f['id'], f['required']])).toEqual([
      ['f-city', false],
      ['f-postal-code', false],
    ]);
  });

  it('gives a re-typed profile field its type back, and drops the baked-in list', async () => {
    const personal = await fieldsOf('personal');
    const byName = Object.fromEntries(personal.map((f) => [f['name'], f]));
    expect(byName['dateOfBirth']?.['type']).toBe('date');
    expect(byName['nationality']?.['type']).toBe('select');
    expect(byName['nationality']).not.toHaveProperty('options');
    // A broker's own fields are theirs, untouched.
    expect(byName['customField_1790000000001']?.['type']).toBe('text');
    const document = await fieldsOf('document');
    expect(document.find((f) => f['name'] === 'shade')?.['options']).toEqual(['a', 'b']);
  });
});

describe('it can run twice', () => {
  it('changes nothing, and writes no second audit row, on a second run', async () => {
    const before = {
      t1: await user('t1'),
      rows: (await q('SELECT count(*)::int AS n FROM audit_log'))[0],
      personal: await fieldsOf2(),
    };
    await ctx.pool.query(SQL);
    expect(await user('t1')).toEqual(before.t1);
    expect((await q('SELECT count(*)::int AS n FROM audit_log'))[0]).toEqual(before.rows);
    expect(await fieldsOf2()).toEqual(before.personal);
  });
});

async function fieldsOf2() {
  return (
    await q<{ fields: unknown }>("SELECT fields FROM kyc_config_steps WHERE slug = 'personal'")
  )[0].fields;
}
