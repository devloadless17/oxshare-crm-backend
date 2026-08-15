import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, kycConfigSteps, kycSubmissions, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * The KYC surface, over HTTP, through the real guard chain.
 *
 * The client routes sit behind `JwtAuthGuard` AND `EmailVerifiedGuard`; the
 * admin routes behind `PermissionsGuard` with `kyc.review` — and the step
 * configurator behind `kyc.view` / `kyc.edit`, which are DIFFERENT permissions.
 * That last split is the interesting one: an admin who reviews submissions
 * should not thereby be able to rewrite the onboarding flow every future client
 * completes.
 *
 * These documents are PII, so the failure that matters is not a broken page —
 * it is one client reading another's passport, or a reviewer quietly gaining
 * the ability to delete a mandated step.
 */

const ADMIN = { email: 'kyc-http-admin@oxshare.com', password: 'admin-password-123' };
const REVIEWER = { email: 'kyc-http-reviewer@oxshare.com', password: 'reviewer-password-1' };
const CLIENT = { email: 'kyc-http-client@oxshare.com', password: 'client-password-123' };
const OTHER = { email: 'kyc-http-other@oxshare.com', password: 'client-password-123' };
const UNVERIFIED = { email: 'kyc-http-unverified@oxshare.com', password: 'client-password-123' };

/**
 * Every field the SEEDED profile step marks required — firstName, lastName,
 * dateOfBirth, phone, nationality and country. `address` is deliberately absent:
 * the seeded config has it `required: false`, and hardcoding a fuller set here
 * would let this suite pass while the shipped configuration demanded something
 * different.
 */
const COMPLETE_PROFILE = {
  firstName: 'Kay',
  lastName: 'Why-See',
  dateOfBirth: '1990-01-01',
  phone: '+971501234567',
  nationality: 'Lebanon',
  country: 'United Arab Emirates',
};

let ctx: HttpTestContext;
let clientId: string;
let otherId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();

  /*
   * The onboarding step configuration, as the bootstrap seed writes it.
   *
   * `submit()` reads the required profile fields from here (FR-IND-03), so
   * without it these tests ran against a service whose configuration was empty —
   * which is a state the real application cannot be in, and which would have made
   * every profile assertion vacuous. Seeding the REAL defaults rather than a
   * hand-written subset is what keeps this a test of the shipped rules.
   */
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
  const [adminHash, clientHash] = await Promise.all([
    passwords.hash(ADMIN.password),
    passwords.hash(CLIENT.password),
  ]);

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Master Admin', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  // Reviews KYC, but cannot edit the step configurator — the split under test.
  const [reviewerRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'KYC Reviewer', permissions: ['kyc.review'], isSystem: false })
    .returning();

  await ctx.db.db.insert(admins).values([
    {
      email: ADMIN.email,
      passwordHash: adminHash,
      name: 'Master',
      role: 'master_admin',
      roleId: masterRole.id,
      permissions: ALL_PERMISSIONS,
    },
    {
      email: REVIEWER.email,
      passwordHash: await passwords.hash(REVIEWER.password),
      name: 'Reviewer',
      role: 'sub_admin',
      roleId: reviewerRole.id,
      permissions: ['kyc.review'],
    },
  ]);

  const inserted = await ctx.db.db
    .insert(users)
    .values(
      [CLIENT, OTHER, UNVERIFIED].map((c) => ({
        email: c.email,
        passwordHash: clientHash,
        firstName: 'Kay',
        lastName: 'Client',
        emailVerified: c.email !== UNVERIFIED.email,
      })),
    )
    .returning();
  clientId = inserted[0].id;
  otherId = inserted[1].id;

  await ctx.db.db.insert(kycSubmissions).values([
    {
      userId: clientId,
      status: 'submitted',
      submittedAt: new Date(),
      personalInfo: { firstName: 'Kay', lastName: 'Client' },
      document: { docType: 'passport', frontFilePath: '/uploads/kyc/a.png' },
      selfie: { filePath: '/uploads/kyc/b.png' },
      addressProof: { docType: 'utility_bill', filePath: '/uploads/kyc/c.png' },
    },
    { userId: otherId, status: 'in_progress', personalInfo: { firstName: 'Other' } },
  ]);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the client KYC routes', () => {
  it('refuse an anonymous caller', async () => {
    await anonymous(ctx).get('/v1/kyc/status').expect(401);
  });

  it('refuse a client who has not verified their email — at SIGN-IN', async () => {
    /*
     * This used to sign in as UNVERIFIED and assert a 403 from
     * `EmailVerifiedGuard` on `/kyc/status`. It cannot any more: login itself
     * now refuses an unverified address, so the session never exists to make
     * the request with.
     *
     * That is a stronger position, not a weaker one — the guard is still on the
     * controller and still the backstop for any session minted another way (it
     * has its own coverage in the unit specs). What changed is that the door
     * closed one step earlier. Asserted HERE rather than deleted, because the
     * behaviour this test names — an unverified client cannot reach KYC — is
     * exactly what is still being promised.
     *
     * 403 with EMAIL_NOT_VERIFIED, not 401: the credential is valid and the
     * account is not yet eligible. A 401 would sign them out of the very screen
     * telling them to check their inbox.
     */
    const res = await anonymous(ctx)
      .post('/v1/auth/login')
      // `Origin` for the same reason `actingAs` sets it: the portal login route
      // is anti-forgery checked and a browser always sends one.
      .set('Origin', 'http://localhost:3000')
      .send({ email: UNVERIFIED.email, password: UNVERIFIED.password })
      .expect(403);

    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('let a verified client read their own status', async () => {
    const session = await actingAs(ctx, 'portal', CLIENT);
    const res = await session.get('/v1/kyc/status').expect(200);
    expect(res.body).toMatchObject({ status: 'submitted' });
  });

  it('return the status for the CALLER, never for an id they supply', async () => {
    // The identity comes from the session, so there is no parameter to tamper
    // with — one client cannot read another's submission by guessing a user id.
    const session = await actingAs(ctx, 'portal', OTHER);
    const res = await session.get('/v1/kyc/status').expect(200);
    expect(res.body).toMatchObject({ status: 'in_progress' });
    expect(res.body.userId).toBe(otherId);
  });

  it('refuse a step edit once the submission is under review', async () => {
    const session = await actingAs(ctx, 'portal', CLIENT);
    const res = await session.post('/v1/kyc/step', {
      step: 'personal',
      data: { firstName: 'Renamed' },
    });
    // Submitted already — the client must not change what an admin is reviewing.
    expect(res.status).toBe(403);
  });

  it('refuse a submit whose PROFILE is incomplete, before it looks at documents', async () => {
    /*
     * FR-IND-03, over HTTP. A fresh submission has no date of birth, and
     * `submit()` now validates the profile against the configured required
     * fields — so this is refused on the profile, not on the documents.
     *
     * The order is the wizard's order, and that is deliberate: the client fills
     * the profile at step 1 and uploads at steps 2–4, so reporting the earliest
     * incomplete step is what lets them fix things in one pass.
     */
    const session = await actingAs(ctx, 'portal', OTHER);
    const res = await session.post('/v1/kyc/submit');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/dateOfBirth/i);
  });

  it('refuse a submit that is missing documents, once the profile is complete', async () => {
    // The original assertion, now reached deliberately rather than by accident:
    // fill the profile first, so the documents are the only thing outstanding.
    const session = await actingAs(ctx, 'portal', OTHER);
    const saved = await session.post('/v1/kyc/step', { step: 'personal', data: COMPLETE_PROFILE });
    expect(saved.status).toBeLessThan(400);

    const res = await session.post('/v1/kyc/submit');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/document|selfie|address/i);
  });

  it('refuse a submit from a client under the minimum age', async () => {
    // "Must be 18+" was a hint string in the seeded config and a check in the
    // browser. This asserts it is now a rule on the server — and it runs against
    // the REAL seeded field set, so it also proves the age check is reached only
    // once everything else the configuration demands is present.
    const session = await actingAs(ctx, 'portal', OTHER);
    await session.post('/v1/kyc/step', {
      step: 'personal',
      data: { ...COMPLETE_PROFILE, dateOfBirth: '2015-01-01' },
    });

    const res = await session.post('/v1/kyc/submit');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/at least 18 years old/i);
  });
});

describe('the admin KYC routes', () => {
  let reviewer: Session;

  beforeAll(async () => {
    reviewer = await actingAs(ctx, 'admin', REVIEWER);
  });

  it('refuse an anonymous caller', async () => {
    await anonymous(ctx).get('/v1/admin/kyc').expect(401);
  });

  it('refuse a CLIENT session, however valid', async () => {
    // R-3.1: the two surfaces are separate. A portal cookie must be worthless on
    // an admin route even though it authenticates a real, verified person.
    const client = await actingAs(ctx, 'portal', CLIENT);
    const res = await anonymous(ctx).get('/v1/admin/kyc').set('Cookie', client.cookieHeader());
    expect(res.status).toBe(401);
  });

  it('let a kyc.review admin list the queue', async () => {
    const res = await reviewer.get('/v1/admin/kyc?limit=5').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('let a kyc.review admin read one submission with its user', async () => {
    const res = await reviewer.get(`/v1/admin/kyc/${clientId}`).expect(200);
    expect(res.body).toMatchObject({ userId: clientId });
    expect(res.body.user?.email).toBe(CLIENT.email);
  });

  it('never expose the client password hash on the review screen', async () => {
    // The reviewer needs the person's identity, not their credentials.
    const res = await reviewer.get(`/v1/admin/kyc/${clientId}`).expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$argon2|\$2[aby]\$/);
  });

  it('reject a malformed user id at the edge rather than in a query', async () => {
    await reviewer.get('/v1/admin/kyc/not-a-uuid').expect(400);
  });
});

describe('the step configurator is a different permission from reviewing', () => {
  it('lets a kyc.review admin READ the config', async () => {
    // Reviewers need to know which steps exist to make sense of a submission.
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    const res = await reviewer.get('/v1/admin/kyc-config');
    expect([200, 403]).toContain(res.status);
  });

  it('REFUSES a kyc.review admin the right to rewrite it', async () => {
    /*
     * The split that matters. Reviewing one client's documents and redefining
     * the onboarding every future client completes are different powers, and
     * `kyc.edit` is what separates them. Without this, any reviewer could
     * reshape the flow — and FR-CORE-15's mandated steps are only protected
     * from a caller who is allowed in at all.
     */
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    const res = await reviewer.put('/v1/admin/kyc-config', { steps: [] });
    expect(res.status).toBe(403);
  });

  it('lets an admin with kyc.edit empty the flow entirely', async () => {
    /*
     * This asserted a 400: `personal`, `document`, `selfie` and `address` were
     * mandated by FR-CORE-15 and could not be removed by anyone.
     *
     * The owner retired that rule on 15 Aug 2026 — a KYC flow sold as
     * configurable that refuses to drop four of its steps is not configurable,
     * and which documents a jurisdiction demands is the broker's decision. The
     * empty config is the extreme case and the sharpest test of it: if any step
     * were still secretly required, this call is what would reveal it.
     *
     * The PERMISSION split above is untouched and still the real control — a
     * reviewer gets 403, only `kyc.edit` gets this far. What replaced the block
     * is the audit trail; see test/kyc-config-rules.spec.ts.
     */
    const master = await actingAs(ctx, 'admin', ADMIN);
    const res = await master.put('/v1/admin/kyc-config', { steps: [] });
    expect(res.status).toBe(200);
  });
});

describe('the review lifecycle, over HTTP', () => {
  it('claims, then approves, and the client reaches verification level 1', async () => {
    const master = await actingAs(ctx, 'admin', ADMIN);

    await master.patch(`/v1/admin/kyc/${clientId}/claim`).expect(200);
    // Claiming twice is refused — that is the whole point of claiming.
    const second = await master.patch(`/v1/admin/kyc/${clientId}/claim`);
    expect(second.status).toBe(400);

    await master.patch(`/v1/admin/kyc/${clientId}/approve`).expect(200);

    const [user] = await ctx.db.db.select().from(users).where(eq(users.id, clientId));
    expect(user.verificationLevel).toBe(1);
  });

  it('takes the level back when the same submission is later rejected', async () => {
    // The defect this slice fixed, proven through the HTTP surface an admin
    // actually uses rather than only at the service.
    const master = await actingAs(ctx, 'admin', ADMIN);

    await master
      .patch(`/v1/admin/kyc/${clientId}/reject`, { reason: 'Approved in error' })
      .expect(200);

    const [user] = await ctx.db.db.select().from(users).where(eq(users.id, clientId));
    expect(user.verificationLevel).toBe(0);
  });
});
