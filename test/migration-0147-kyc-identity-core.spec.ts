import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { IDENTITY_FIELDS, platformStep } from '../src/common/kyc/identity-core';
import { assertKycConfigIntegrity } from '../src/modules/admin/kyc-config-integrity';
import type { KycFieldConfig, KycStepConfig } from '../src/store/kyc-config.store';

/**
 * MIGRATION 0147 — every KYC form saved before the identity core is made to fit
 * it, and no client's answer is lost on the way.
 *
 * It runs once against every real form and every real submission. A field it
 * drops is a question nobody sees again, an answer it forgets to move is one a
 * reviewer can no longer find — so each rule is proven here on the shapes that
 * actually exist, starting with the one found on the dev database: Personal
 * Information holding a single custom box labelled "firstname", and Proof of
 * Address moved to the front.
 *
 * The database is migrated to 0145, the legacy rows are written the way the old
 * builder wrote them, and then 0147 runs — the order production sees. Then it
 * runs again, because a migration that is re-run must find nothing to do.
 */

const MIGRATIONS = join(__dirname, '..', 'src', 'database', 'migrations');
const TAG = '0147_kyc_identity_core';
const SQL = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8');

let ctx: MoneyTestContext;
let folder: string;
let clientId: string;

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

type Row = {
  id: string;
  step_number: number;
  slug: string;
  title: string;
  icon: string;
  enabled: boolean;
  fields: KycFieldConfig[];
};

const steps = () =>
  q<Row>(
    'SELECT id, step_number, slug, title, icon, enabled, fields FROM kyc_config_steps ORDER BY step_number',
  );
const stepOf = async (slug: string) => (await steps()).find((row) => row.slug === slug)!;
const consolidations = () =>
  q<{ actor_kind: string; details: { changes: string[] } }>(
    "SELECT actor_kind, details FROM audit_log WHERE action = 'kyc_config.consolidated' ORDER BY created_at",
  );

const field = (
  id: string,
  name: string,
  label: string,
  type = 'text',
  required = false,
): KycFieldConfig => ({ id, name, label, type, required });

async function step(
  id: string,
  stepNumber: number,
  slug: string,
  title: string,
  fields: KycFieldConfig[],
  enabled = true,
) {
  await q(
    `INSERT INTO kyc_config_steps (id, step_number, slug, title, description, icon, enabled, fields)
     VALUES ($1, $2, $3, $4, '', 'X', $5, $6)`,
    [id, stepNumber, slug, title, enabled, JSON.stringify(fields)],
  );
}

const file = (name: string) => ({ filePath: `/uploads/kyc/${name}.jpg`, fileName: `${name}.jpg` });

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'mig0147-'));
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

  // ── The form, as the old builder let an operator leave it. ──
  await q('DELETE FROM kyc_config_steps');
  await step('step-4', 1, 'address', 'Proof of Address', [
    field('f-addr-utility', 'utilityBill', 'Utility Bill', 'doc:utility_bill'),
    field('f-addr-bank', 'bankStatement', 'Bank Statement', 'doc:bank_statement'),
    field('f-addr-tenancy', 'tenancyAgreement', 'Tenancy Agreement', 'doc:tenancy_agreement'),
    field('field-proof3', 'customField_proof3', 'prooof3', 'file', true),
    field('f-pp-wrong', 'passportHere', 'Passport', 'doc:passport'),
  ]);
  await step('step-2', 2, 'document', 'Identity Docs', [
    field('f-doc-passport', 'passport', 'Passport', 'doc:passport'),
    field('f-doc-national-id', 'nationalId', 'National ID card', 'doc:national_id', true),
    field('f-doc-driving-license', 'drivingLicense', 'Driving License', 'doc:driving_license'),
    field('f-pp-again', 'passportAgain', 'Passport (again)', 'doc:passport'),
    field('field-docnum', 'customField_docnum', 'Document number', 'text', true),
  ]);
  await step('step-1', 3, 'personal', 'Personal Information', [
    // The reported case: identity deleted, "firstname" re-added as a custom box.
    field('field-1790402959161', 'customField_1790402959161', 'firstname', 'text', true),
    // A stored identity field an older build left behind.
    field('f-2', 'lastName', 'Surname', 'text', true),
    field('field-occupation', 'customField_occupation', 'Occupation', 'text', true),
    field('field-payslip', 'customField_payslip', 'Payslip', 'file'),
  ]);
  await step('step-custom1', 4, 'custom slug 1', 'custom1', [
    // A broker's own question whose KEY the platform reserves.
    field('field-bizphone', 'phone', 'Business phone', 'phone'),
    // What 0137 made of a passport that stood on a custom step.
    field('field-pp-page', 'passportPage', 'Passport — Photo Page', 'file', true),
  ]);
  await step('step-3', 5, 'selfie', 'Selfie Verification', [
    field('f-11', 'selfie', 'Selfie Photo', 'camera', true),
    field('field-holding', 'customField_holding', 'Holding your ID', 'camera', true),
  ]);
  await step('step-5', 6, 'review', 'Review & Submit', []);

  // ── A client who answered all of it. ──
  const [client] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
     VALUES ('mig0147@oxshare-e2e.test', 'x', 'Layla', 'Haddad', true) RETURNING id`,
  );
  clientId = client.id;
  await q(
    `INSERT INTO kyc_submissions (user_id, status, personal_info, step_data, rejected_fields)
     VALUES ($1, 'rejected', $2, $3, $4)`,
    [
      clientId,
      JSON.stringify({ customField_1790402959161: 'Layla', customField_occupation: 'Engineer' }),
      JSON.stringify({
        personal: { customField_payslip: file('payslip') },
        address: { customField_proof3: file('proof3') },
        document: { customField_docnum: 'A1234567' },
        selfie: { customField_holding: file('holding') },
        'custom slug 1': { phone: '+97150123456', passportPage: file('pp-page') },
      }),
      JSON.stringify(['customField_proof3', 'phone']),
    ],
  );

  await ctx.pool.query(SQL);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
  rmSync(folder, { recursive: true, force: true });
});

describe('the form', () => {
  it('opens with Personal Information, keeps the rest in order, and moves the extras last', async () => {
    expect((await steps()).map((row) => [row.step_number, row.slug])).toEqual([
      [1, 'personal'],
      [2, 'address'],
      [3, 'document'],
      [4, 'custom slug 1'],
      [5, 'selfie'],
      [6, 'additional-information'],
    ]);
  });

  it('THE REPORTED CASE: Personal Information stores only the broker’s own questions', async () => {
    // "firstname" was a second copy of the first name, and the stored lastName
    // is the platform's to serve: both leave the row, and the identity comes
    // back on every read.
    // Since Phase 2 the identity comes back as stored PLACEMENTS — 0158, below.
    const personal = await stepOf('personal');
    expect(personal.fields.map((f) => f.label)).toEqual(['Occupation']);
  });

  it('keeps each document on its own step, once, as the catalogue names it', async () => {
    expect((await stepOf('document')).fields).toEqual([
      field('f-doc-passport', 'passport', 'Passport', 'doc:passport'),
      field('f-doc-national-id', 'nationalId', 'National ID', 'doc:national_id'),
      field('f-doc-driving-license', 'drivingLicense', 'Driving License', 'doc:driving_license'),
    ]);
    expect((await stepOf('address')).fields.map((f) => f.type)).toEqual([
      'doc:utility_bill',
      'doc:bank_statement',
      'doc:tenancy_agreement',
    ]);
  });

  it('does NOT tick Residence Permit on a form the broker already chose documents for', async () => {
    const types = (await stepOf('document')).fields.map((f) => f.type);
    expect(types).not.toContain('doc:residence_permit');
  });

  it('empties the selfie step of everything but the camera the platform serves', async () => {
    expect((await stepOf('selfie')).fields).toEqual([]);
  });

  it('gives a reserved key a fresh one, and drops a second copy of a passport', async () => {
    expect((await stepOf('custom slug 1')).fields).toEqual([
      field('field-bizphone', 'customField_phone', 'Business phone', 'phone'),
    ]);
  });

  it('moves the extras to a step of the broker’s own, in the order the client met them', async () => {
    const extras = await stepOf('additional-information');
    expect(extras).toMatchObject({ title: 'Additional information', enabled: true });
    expect(extras.fields.map((f) => f.name)).toEqual([
      'customField_payslip',
      'customField_proof3',
      'customField_docnum',
      'customField_holding',
    ]);
  });

  it('removes the stored summary step — the portal always appends its own', async () => {
    expect((await steps()).some((row) => row.slug === 'review')).toBe(false);
  });

  it('leaves a form the new rules accept as it is', async () => {
    const form = (await steps()).map((row) => platformStep(toStep(row)));
    expect(() => assertKycConfigIntegrity(form, form)).not.toThrow();
  });
});

describe('the client’s answers', () => {
  async function submission() {
    const [row] = await q<{
      personal_info: Record<string, unknown>;
      step_data: Record<string, Record<string, unknown>>;
      rejected_fields: string[];
    }>('SELECT personal_info, step_data, rejected_fields FROM kyc_submissions WHERE user_id = $1', [
      clientId,
    ]);
    return row;
  }

  it('moves every answer with its field, and deletes none', async () => {
    const { step_data } = await submission();
    expect(step_data).toEqual({
      'custom slug 1': { customField_phone: '+97150123456', passportPage: file('pp-page') },
      'additional-information': {
        customField_payslip: file('payslip'),
        customField_proof3: file('proof3'),
        customField_docnum: 'A1234567',
        customField_holding: file('holding'),
      },
    });
  });

  it('keeps the answer to a removed question where it was — history, not debris', async () => {
    expect((await submission()).personal_info).toEqual({
      customField_1790402959161: 'Layla',
      customField_occupation: 'Engineer',
    });
  });

  it('leaves a reviewer’s flag on a reserved key alone — it may have meant the platform’s', async () => {
    expect((await submission()).rejected_fields).toEqual(['customField_proof3', 'phone']);
  });
});

describe('the record of it', () => {
  it('is ONE audit row, by the system, saying what was repaired', async () => {
    const rows = await consolidations();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_kind).toBe('system');
    const changes = rows[0].details.changes.join('\n');
    expect(changes).toMatch(/Removed "firstname" from "Personal Information"/);
    expect(changes).toMatch(/Removed "Passport" from "Proof of Address"/);
    expect(changes).toMatch(/Moved "prooof3" from "Proof of Address"/);
    expect(changes).toMatch(/Moved Personal Information to the front/);
    expect(changes).toMatch(/identity fields are now served by the platform/);
  });

  it('is written once: a second run finds nothing to repair', async () => {
    const before = await steps();
    await ctx.pool.query(SQL);
    expect(await steps()).toEqual(before);
    expect(await consolidations()).toHaveLength(1);
  });
});

describe('a form missing its built-in steps', () => {
  it('gets them back — Selfie and Proof of Address switched off, as nobody was asked', async () => {
    await q('DELETE FROM kyc_config_steps');
    await step(
      'step-1',
      1,
      'personal',
      'About you',
      [field('f-1', 'firstName', 'First Name', 'text', true)],
      false,
    );
    await step('step-funds', 2, 'source-of-funds', 'Source of funds', [
      field('field-employer', 'customField_employer', 'Employer'),
    ]);

    await ctx.pool.query(SQL);

    const rows = await steps();
    expect(rows.map((row) => [row.slug, row.title, row.enabled])).toEqual([
      ['personal', 'Personal Information', true],
      ['source-of-funds', 'Source of funds', true],
      ['document', 'Identity Document', true],
      ['selfie', 'Selfie Verification', false],
      ['address', 'Proof of Address', false],
    ]);
    expect((await stepOf('document')).fields.map((f) => f.type)).toEqual([
      'doc:passport',
      'doc:national_id',
      'doc:driving_license',
      'doc:residence_permit',
    ]);
    expect((await consolidations()).at(-1)?.details.changes).toEqual(
      expect.arrayContaining([
        'Restored Identity Document',
        'Restored Selfie Verification, switched off',
        'Restored Proof of Address, switched off',
      ]),
    );
  });

  it('keeps the first of two copies of a built-in step, and makes the other the broker’s', async () => {
    await q('DELETE FROM kyc_config_steps');
    await step('step-1', 1, 'personal', 'Personal Information', []);
    await step('step-2', 2, 'document', 'Identity Document', [
      field('f-doc-passport', 'passport', 'Passport', 'doc:passport'),
    ]);
    await step('step-2b', 3, 'document', 'Identity Document', [
      field('f-q', 'customField_q', 'Tax number'),
    ]);
    await step('step-3', 4, 'selfie', 'Selfie Verification', []);
    await step('step-4', 5, 'address', 'Proof of Address', [
      field('f-addr-bank', 'bankStatement', 'Bank Statement', 'doc:bank_statement'),
    ]);

    await ctx.pool.query(SQL);

    const copy = (await steps()).find((row) => row.id === 'step-2b')!;
    expect(copy).toMatchObject({ slug: 'document-copy', title: 'Identity Document (copy)' });
    expect(copy.fields.map((f) => f.label)).toEqual(['Tax number']);
  });
});

function toStep(row: Row): KycStepConfig {
  return {
    id: row.id,
    stepNumber: row.step_number,
    slug: row.slug,
    title: row.title,
    description: '',
    icon: row.icon,
    enabled: row.enabled,
    fields: row.fields,
  };
}

describe('then 0158 (Phase 2): the identity is stored as placements', () => {
  it('writes all ten back, first and in the platform’s order — and a re-run changes nothing', async () => {
    // Without them the form would silently stop asking for the client's name.
    await q(`UPDATE kyc_config_steps SET fields = $1 WHERE slug = 'personal'`, [
      JSON.stringify([field('field-occupation', 'customField_occupation', 'Occupation')]),
    ]);
    const phase2 = readFileSync(join(MIGRATIONS, '0158_kyc_form_customizable.sql'), 'utf8');
    const names = async () => (await stepOf('personal')).fields.map((f) => f.name);
    const expected = [...IDENTITY_FIELDS.map((f) => f.name), 'customField_occupation'];

    await ctx.pool.query(phase2);
    expect(await names()).toEqual(expected);
    await ctx.pool.query(phase2);
    expect(await names()).toEqual(expected);
  });
});
