import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueTestPhone } from './support/registration';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { uploadKycFile, uploadStandardKycDocuments } from './support/kyc-upload';
import { PasswordService } from '../src/common/security/password.service';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * A RETURN IS CLEAN (identity-core plan, slice 6).
 *
 *  - A reviewer may return only what the client can answer: an identity
 *    detail, a page ON FILE, the selfie, a question on the form. Anything else
 *    was stored as given — shown nowhere, blocking nothing.
 *  - The configured reason chosen is KEPT on the decision, and must be a KYC
 *    reason: the list is shared with withdrawals and partner applications.
 *  - A return corrected while the client works decides what was PRESENTED —
 *    never the replacements they have uploaded since.
 */

const ADMIN = { email: 'returns-admin@oxshare.com', password: 'admin-password-123' };
const RETURNED = { email: 'returns-client@oxshare-e2e.test', password: 'client-password-123' };
const VERIFIED = { email: 'returns-verified@oxshare-e2e.test', password: 'client-password-123' };
const PROFILE = {
  firstName: 'Layla',
  lastName: 'Haddad',
  dateOfBirth: '1990-01-01',
  // A fresh number per spread: one client per phone (0194).
  get phone(): string {
    return uniqueTestPhone();
  },
  nationality: 'Lebanese',
  country: 'Lebanon',
  address: 'Hamra Street 12',
  city: 'Beirut',
};

let ctx: HttpTestContext;
let admin: Session;
const ids: Record<string, number> = {};
const sessions: Record<string, Session> = {};
let kycReason: string;
let withdrawalReason: string;

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.db.db.execute(query)).rows as T[];
}

const decisions = (user: number) =>
  rows<{ outcome: string; reason_id: string | null; returned_items: string[]; covered: string[] }>(
    sql`SELECT v.outcome, v.reason_id, v.returned_items,
               coalesce((SELECT array_agg(c.document_id::text ORDER BY c.document_id)
                           FROM client_verification_documents c WHERE c.verification_id = v.id),
                        '{}') AS covered
          FROM client_verifications v WHERE v.user_id = ${user}::integer ORDER BY v.seq`,
  );

const live = async (user: number) =>
  (
    await rows<{ status: string; rejected_fields: string[] | null }>(
      sql`SELECT status, rejected_fields FROM kyc_submissions WHERE user_id = ${user}::integer`,
    )
  )[0];

async function submitted(name: 'returned' | 'verified'): Promise<void> {
  await uploadStandardKycDocuments(sessions[name]);
  const res = await sessions[name].post('/v1/kyc/submit', {});
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  expect((await admin.patch(`/v1/admin/kyc/${ids[name]}/claim`, {})).status).toBeLessThan(300);
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
    .values({ name: 'Returns Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Returns Admin',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
  });
  for (const [name, account] of [
    ['returned', RETURNED],
    ['verified', VERIFIED],
  ] as const) {
    const [user] = await ctx.db.db
      .insert(users)
      .values({
        email: account.email,
        passwordHash: await passwords.hash(account.password),
        emailVerified: true,
        ...PROFILE,
      })
      .returning();
    ids[name] = user.id;
    sessions[name] = await actingAs(ctx, 'portal', account);
  }
  admin = await actingAs(ctx, 'admin', ADMIN);
  const [kyc] = await rows<{ id: string }>(
    sql`INSERT INTO rejection_reasons (context, label) VALUES ('kyc', 'The photo is blurred') RETURNING id`,
  );
  const [withdrawal] = await rows<{ id: string }>(
    sql`INSERT INTO rejection_reasons (context, label) VALUES ('withdrawal', 'Wrong beneficiary') RETURNING id`,
  );
  kycReason = kyc.id;
  withdrawalReason = withdrawal.id;
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('returning a submission', () => {
  const reject = (body: Record<string, unknown>) =>
    admin.patch(`/v1/admin/kyc/${ids['returned']}/reject`, body);

  it('refuses what the client cannot answer — naming each — and changes nothing', async () => {
    await submitted('returned');
    // A passport has no back page, and `bogus` is nothing at all.
    const res = await reject({
      reason: 'Please fix these',
      rejectedFields: ['doc_front', 'doc_back', 'bogus'],
    });
    expect(res.status).toBe(400);
    const body = res.body as { fields?: { rejectedFields?: string } };
    expect(body.fields?.rejectedFields).toContain('doc_back, bogus');
    expect((await live(ids['returned'])).status).toBe('under_review');
    expect(await decisions(ids['returned'])).toEqual([]);
  });

  it('refuses a reason that is not a KYC reason, and one that names no reason at all', async () => {
    const other = await reject({ reasonId: withdrawalReason, rejectedFields: ['doc_front'] });
    expect(other.status).toBe(400);
    expect((other.body as { fields?: Record<string, string> }).fields).toHaveProperty('reasonId');
    expect((await reject({ reasonId: 'not-an-id', rejectedFields: ['doc_front'] })).status).toBe(
      400,
    );
    expect(await decisions(ids['returned'])).toEqual([]);
  });

  it('keeps the chosen reason on the decision, beside what was returned', async () => {
    const res = await reject({
      reasonId: kycReason,
      reason: 'Retake it in daylight',
      rejectedFields: ['doc_front', 'firstName'],
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const [decision] = await decisions(ids['returned']);
    expect(decision).toMatchObject({
      outcome: 'returned',
      reason_id: kycReason,
      returned_items: ['doc_front', 'firstName'],
    });
    const [attempt] = await rows<{ reason_id: string }>(
      sql`SELECT reason_id FROM kyc_submission_attempts WHERE user_id = ${ids['returned']}::integer`,
    );
    expect(attempt.reason_id).toBe(kycReason);
  });

  it('a CORRECTED return decides what was presented — not the replacement uploaded since', async () => {
    // The client starts on the return: a new front, still a draft.
    expect(
      (await uploadKycFile(sessions['returned'], 'doc_front', 'passport')).status,
    ).toBeLessThan(300);
    const [first] = await decisions(ids['returned']);

    const res = await reject({ reason: 'And the selfie, too', rejectedFields: ['selfie'] });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);

    const [, second] = await decisions(ids['returned']);
    expect(second.outcome).toBe('returned');
    expect(second.covered, 'the correction decided on different evidence').toEqual(first.covered);
    // The replacement is untouched: still the client's draft, still being worked on.
    const drafts = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM client_documents
       WHERE user_id = ${ids['returned']}::integer AND slot = 'identity' AND frozen_at IS NULL`);
    expect(drafts[0].n).toBe(1);
    expect((await live(ids['returned'])).rejected_fields).toEqual(['selfie']);
  });
});

describe('asking a verified client to update', () => {
  it('refuses items the client cannot answer, and accepts what they can', async () => {
    await submitted('verified');
    expect((await admin.patch(`/v1/admin/kyc/${ids['verified']}/approve`, {})).status).toBeLessThan(
      300,
    );

    const reverify = (items: string[]) =>
      admin.post(`/v1/admin/kyc/${ids['verified']}/reverify`, { reason: 'Expired', items });
    const refused = await reverify(['doc_back', 'nationalId']);
    expect(refused.status).toBe(400);
    expect((refused.body as { fields?: { items?: string } }).fields?.items).toContain(
      'doc_back, nationalId',
    );
    expect((await live(ids['verified'])).status).toBe('approved');

    const accepted = await reverify(['passport']);
    expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
    // The whole passport, stored as its one page on file.
    expect((await live(ids['verified'])).rejected_fields).toEqual(['doc_front']);
  });
});
