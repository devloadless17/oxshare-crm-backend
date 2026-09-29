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
import { uploadKycFile } from './support/kyc-upload';
import { PasswordService } from '../src/common/security/password.service';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * THE CLIENT'S IDENTITY RECORD MOVES WITH EVERY KYC CHANGE (identity-core
 * plan, slice 5).
 *
 * The KYC columns are still what gets read; every transaction that changes
 * evidence or records a decision now ALSO writes the client's record, in the
 * same commit (`ClientIdentityService.recordFromKyc`). One whole round through
 * the real API — upload, submit, a page returned, the page replaced,
 * resubmitted, approved, returned for re-verification, reset — and after EVERY
 * step:
 *
 *  - nothing is out of step (`identity_drift` is empty);
 *  - the verification level equals the latest decision on the record;
 *
 * plus what each step should have added: a draft while the client works, a
 * frozen version for what they presented, one decision per review, linked to
 * exactly what was decided on.
 */

const ADMIN = { email: 'dual-write-admin@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'dual-write@oxshare-e2e.test', password: 'client-password-123' };
const PROFILE = {
  firstName: 'Layla',
  lastName: 'Haddad',
  dateOfBirth: '1990-01-01',
  phone: '+961 70 123 456',
  nationality: 'Lebanese',
  country: 'Lebanon',
  address: 'Hamra Street 12',
  city: 'Beirut',
};

let ctx: HttpTestContext;
let clientId: number;
let client: Session;
let admin: Session;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.db.db.execute(query)).rows as T[];
}

/** The two invariants, after every step. */
async function inStep(step: string) {
  expect(
    await rows(sql`SELECT problem, slot FROM identity_drift WHERE user_id = ${clientId}::integer`),
    step,
  ).toEqual([]);
  const [level] = await rows<{ level: number; latest: number | null }>(sql`
    SELECT u.verification_level AS level,
           (SELECT level_after FROM client_verifications v WHERE v.user_id = u.id
             ORDER BY seq DESC LIMIT 1) AS latest
      FROM users u WHERE u.id = ${clientId}::integer`);
  expect(level.latest ?? 0, `${step}: the level is not the latest decision`).toBe(level.level);
}

const identityVersions = () =>
  rows<{ frozen: boolean; doc_type: string; parts: number }>(sql`
    SELECT d.frozen_at IS NOT NULL AS frozen, d.doc_type,
           (SELECT count(*)::int FROM client_document_pages p WHERE p.document_id = d.id) AS parts
      FROM client_documents d
     WHERE d.user_id = ${clientId}::integer AND d.slot = 'identity'
     ORDER BY d.created_at, d.frozen_at NULLS LAST`);

const decisions = () =>
  rows<{
    outcome: string;
    level_after: number;
    method: string;
    covered: number;
    reason: string | null;
  }>(sql`
    SELECT v.outcome, v.level_after, v.method, v.reason,
           (SELECT count(*)::int FROM client_verification_documents c WHERE c.verification_id = v.id) AS covered
      FROM client_verifications v WHERE v.user_id = ${clientId}::integer ORDER BY v.seq`);

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
    .values({ name: 'Dual Write Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Dual Write Admin',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
  });
  const [user] = await ctx.db.db
    .insert(users)
    .values({
      email: CLIENT.email,
      passwordHash: await passwords.hash(CLIENT.password),
      emailVerified: true,
      ...PROFILE,
      phone: '+96170123456',
    })
    .returning();
  clientId = user.id;
  client = await actingAs(ctx, 'portal', CLIENT);
  admin = await actingAs(ctx, 'admin', ADMIN);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

function ok(res: { status: number; body: unknown }, what: string): void {
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
}

describe('one KYC round, and the record after every step', () => {
  it('uploads land on a DRAFT', async () => {
    ok(await uploadKycFile(client, 'doc_front', 'national_id'), 'front');
    ok(await uploadKycFile(client, 'doc_back', 'national_id'), 'back');
    ok(await uploadKycFile(client, 'selfie'), 'selfie');
    ok(await uploadKycFile(client, 'address_proof', 'utility_bill'), 'bill');
    await inStep('after uploading');
    expect(await identityVersions()).toEqual([
      { frozen: false, doc_type: 'national_id', parts: 2 },
    ]);
  });

  it('submitting FREEZES what was presented', async () => {
    ok(await client.post('/v1/kyc/submit', {}), 'submit');
    await inStep('after submitting');
    expect(await identityVersions()).toEqual([{ frozen: true, doc_type: 'national_id', parts: 2 }]);
  });

  it('returning the back page records the decision on what was decided', async () => {
    ok(await admin.patch(`/v1/admin/kyc/${clientId}/claim`, {}), 'claim');
    ok(
      await admin.patch(`/v1/admin/kyc/${clientId}/reject`, {
        reason: 'The back is blurred',
        rejectedFields: ['doc_back'],
      }),
      'reject',
    );
    await inStep('after the return');
    expect(await decisions()).toEqual([
      {
        outcome: 'returned',
        level_after: 0,
        method: 'manual_review',
        covered: 3,
        reason: 'The back is blurred',
      },
    ]);
  });

  it('the replacement is a new DRAFT — the returned version stays as it was', async () => {
    ok(await uploadKycFile(client, 'doc_back', 'national_id'), 'new back');
    await inStep('after replacing the page');
    expect(await identityVersions()).toEqual([
      { frozen: true, doc_type: 'national_id', parts: 2 },
      { frozen: false, doc_type: 'national_id', parts: 2 },
    ]);
  });

  it('resubmitting and approving: a second frozen version, a verified decision, level 1', async () => {
    ok(await client.post('/v1/kyc/submit', {}), 'resubmit');
    await inStep('after resubmitting');
    ok(await admin.patch(`/v1/admin/kyc/${clientId}/claim`, {}), 'claim');
    ok(await admin.patch(`/v1/admin/kyc/${clientId}/approve`, {}), 'approve');
    await inStep('after approval');
    expect((await identityVersions()).map((v) => v.frozen)).toEqual([true, true]);
    expect((await decisions()).map((d) => [d.outcome, d.level_after])).toEqual([
      ['returned', 0],
      ['verified', 1],
    ]);
  });

  it('a re-verification is recorded as what it is — never as a rejection', async () => {
    ok(
      await admin.post(`/v1/admin/kyc/${clientId}/reverify`, {
        reason: 'Expired',
        items: ['doc_front'],
      }),
      'reverify',
    );
    await inStep('after the re-verification request');
    expect((await decisions()).map((d) => d.outcome)).toEqual([
      'returned',
      'verified',
      'reverification_requested',
    ]);
  });

  it('a reset removes the drafts, and keeps every decided version as evidence', async () => {
    ok(await client.post('/v1/kyc/reset', {}), 'reset');
    await inStep('after the reset');
    const versions = await identityVersions();
    expect(
      versions.every((v) => v.frozen),
      'a draft survived the reset',
    ).toBe(true);
    expect(versions).toHaveLength(2);
  });
});
