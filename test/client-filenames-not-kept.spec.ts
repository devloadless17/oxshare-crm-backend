import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { KYC_TEST_PNG } from './support/kyc-upload';
import { PasswordService } from '../src/common/security/password.service';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * A client's original filename is neither kept nor shown (0160, D-84).
 *
 * What a file was called on the client's device is text they typed, and it
 * routinely carries their name or a document number. This ATTEMPTS the leak: a
 * client uploads files named exactly that way, submits, and then every reader of
 * those documents is asked — the upload's own answer, the client's status, the
 * reviewer's submission, the client page's identity record — and so is every
 * text column in the database. None of them may hold the name.
 */

const ADMIN = { email: 'filenames-admin@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'filenames@oxshare-e2e.test', password: 'client-password-123' };

/** In every name the client sends, and nowhere else. */
const CANARY = 'FNCANARY';
const named = (what: string) => `Layla_Haddad_${what}_X1234567_${CANARY}.png`;

let ctx: HttpTestContext;
let admin: Session;
let client: Session;
let clientId: number;
const answers: string[] = [];

function upload(field: string, filename: string, docType?: string) {
  const req = client.post('/v1/kyc/upload', undefined).field('field', field);
  if (docType) req.field('docType', docType);
  return req.attach('file', KYC_TEST_PNG, { filename, contentType: 'image/png' });
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  await ctx.db.db.insert(kycConfigSteps).values(
    DEFAULT_KYC_STEPS.map((s) => ({
      id: s.id,
      stepNumber: s.stepNumber,
      slug: s.slug,
      title: s.title,
      description: s.description,
      icon: s.icon,
      enabled: s.enabled,
      fields: s.fields as unknown as Record<string, unknown>[],
    })),
  );
  const passwords = new PasswordService();
  const [role] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Filenames Master', permissions: [...ALL_PERMISSIONS], isSystem: false })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Filenames Master',
    role: 'sub_admin',
    roleId: role.id,
    permissions: [...ALL_PERMISSIONS],
  });
  const [user] = await ctx.db.db
    .insert(users)
    .values({
      email: CLIENT.email,
      passwordHash: await passwords.hash(CLIENT.password),
      emailVerified: true,
      firstName: 'Layla',
      lastName: 'Haddad',
      dateOfBirth: '1990-01-01',
      phone: '+96170123456',
      nationality: 'Lebanese',
      country: 'Lebanon',
      address: 'Hamra Street 12',
      city: 'Beirut',
    })
    .returning();
  clientId = user.id;
  client = await actingAs(ctx, 'portal', CLIENT);
  admin = await actingAs(ctx, 'admin', ADMIN);

  for (const [field, what, docType] of [
    ['doc_front', 'passport', 'passport'],
    ['selfie', 'selfie', undefined],
    ['address_proof', 'bill', 'utility_bill'],
    ['address_proof_2', 'bill_page2', 'utility_bill'],
  ] as const) {
    const res = await upload(field, named(what), docType);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    answers.push(JSON.stringify(res.body));
  }
  const submitted = await client.post('/v1/kyc/submit');
  expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a client’s original filename is neither kept nor shown', () => {
  it('the uploads really happened — four files, presented for review', async () => {
    // Non-vacuous: without the files there would be nothing for a name to ride on.
    const { rows } = await ctx.db.db.execute<{ files: number; pages: number }>(sql`
      SELECT (SELECT count(*)::int FROM stored_objects WHERE owner_user_id = ${clientId}) AS files,
             (SELECT count(*)::int FROM client_document_pages p
                JOIN client_documents d ON d.id = p.document_id
               WHERE d.user_id = ${clientId} AND d.frozen_at IS NOT NULL) AS pages`);
    expect(rows[0]).toEqual({ files: 4, pages: 4 });
  });

  it('is in no answer: the upload, the client’s status, the review, the identity record', async () => {
    const reads = [
      ...answers,
      JSON.stringify((await client.get('/v1/kyc/status').expect(200)).body),
      JSON.stringify((await admin.get(`/v1/admin/kyc/${clientId}`).expect(200)).body),
      JSON.stringify((await admin.get(`/v1/admin/kyc/${clientId}/history`).expect(200)).body),
      JSON.stringify((await admin.get(`/v1/admin/clients/${clientId}/identity`).expect(200)).body),
    ];
    for (const body of reads) expect(body).not.toContain(CANARY);
    // The documents ARE in those answers — by path, never by name.
    expect(reads[4]).toContain('uploads/kyc/');
  });

  it('is kept in no column of the database', async () => {
    const { rows: columns } = await ctx.db.db.execute<{
      table_name: string;
      column_name: string;
    }>(sql`
      SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')`);
    const holding: string[] = [];
    for (const { table_name, column_name } of columns) {
      const { rows } = await ctx.db.db.execute(
        sql.raw(
          `SELECT 1 FROM "${table_name}" WHERE "${column_name}"::text LIKE '%${CANARY}%' LIMIT 1`,
        ),
      );
      if (rows.length > 0) holding.push(`${table_name}.${column_name}`);
    }
    expect(holding).toEqual([]);
  });
});
