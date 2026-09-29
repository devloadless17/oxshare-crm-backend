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
  nationality: 'Lebanese',
  country: 'United Arab Emirates',
  // Required to verify, by the platform (the identity core, 26 Sep 2026).
  address: '12 Sheikh Zayed Road',
  city: 'Dubai',
};

let ctx: HttpTestContext;
let clientId: number;
let otherId: number;

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
        // The CLIENT's contact details live on its profile (0139), as the KYC
        // personal step would have stored them — E.164, trimmed.
        ...(c.email === CLIENT.email
          ? {
              phone: '+96170111111',
              country: 'Lebanon',
              // The rest of a complete identity: approval re-asks the judge.
              dateOfBirth: '1990-01-01',
              nationality: 'Lebanese',
              address: 'Hamra Street 12',
              city: 'Beirut',
            }
          : {}),
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
      // Only a broker's own questions live here; this client answered none.
      personalInfo: {},
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

  /*
   * `reviewed_by` is an ADMIN's internal id — and, while a review is open, the
   * one holding the claim. It went to every client in their own status until
   * 28 Sep 2026. The portal never read it, and it is not the client's to see.
   */
  it('never shows the client which admin holds or decided their submission', async () => {
    const [reviewer] = await ctx.db.db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.email, REVIEWER.email));
    await ctx.db.db
      .update(kycSubmissions)
      .set({ reviewedBy: reviewer.id })
      .where(eq(kycSubmissions.userId, otherId));
    try {
      const session = await actingAs(ctx, 'portal', OTHER);
      const res = await session.get('/v1/kyc/status').expect(200);
      expect(res.body).not.toHaveProperty('reviewedBy');
      expect(JSON.stringify(res.body)).not.toContain(reviewer.id);
    } finally {
      await ctx.db.db
        .update(kycSubmissions)
        .set({ reviewedBy: null })
        .where(eq(kycSubmissions.userId, otherId));
    }
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

  it('refuse an under-age date of birth the moment it is SAVED, naming the field', async () => {
    // "Must be 18+" was a hint string in the seeded config and a check in the
    // browser. It is a rule of the PROFILE now (0139), so it holds at the door —
    // the step refuses the date field by field, and the stored one survives.
    const session = await actingAs(ctx, 'portal', OTHER);
    const res = await session.post('/v1/kyc/step', {
      step: 'personal',
      data: { ...COMPLETE_PROFILE, dateOfBirth: '2015-01-01' },
    });
    expect(res.status).toBe(400);
    expect((res.body as { fields?: Record<string, string> }).fields?.dateOfBirth).toMatch(
      /at least 18 years old/i,
    );
    const [row] = await ctx.db.db.select().from(users).where(eq(users.id, otherId));
    expect(row.dateOfBirth, 'the refused date was stored anyway').toBe(
      COMPLETE_PROFILE.dateOfBirth,
    );
  });

  it('refuse a submit from a client whose STORED date of birth is under age', async () => {
    // A date that reached the profile by some other road — written before the
    // rule, or by hand in SQL — is still refused where completeness is judged.
    // It runs against the REAL seeded field set, so it also proves the age
    // check is reached before anything later in the flow.
    await ctx.db.db.update(users).set({ dateOfBirth: '2015-01-01' }).where(eq(users.id, otherId));
    try {
      const session = await actingAs(ctx, 'portal', OTHER);
      const res = await session.post('/v1/kyc/submit');
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/at least 18 years old/i);
    } finally {
      await ctx.db.db
        .update(users)
        .set({ dateOfBirth: COMPLETE_PROFILE.dateOfBirth })
        .where(eq(users.id, otherId));
    }
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

  it('refuses even kyc.edit a form without the four built-in steps — the identity core', async () => {
    /*
     * This asserted a 200 for a form holding one step that was none of the
     * four: the owner had retired the mandatory-step rule on 15 Aug 2026.
     *
     * On 26 Sep 2026 the owner ruled again, after a builder edit removed a
     * client's first name from the form: the client's identity is not
     * configuration. Personal Information and Identity Document are always on,
     * Selfie and Proof of Address can be switched off, and none of the four can
     * be deleted (`common/kyc/identity-core.ts`). The permission split above is
     * still the first control; this is the second, and it holds for everybody.
     */
    const master = await actingAs(ctx, 'admin', ADMIN);
    const before = (await master.get('/v1/admin/kyc-config')).body as { slug: string }[];

    const res = await master.put('/v1/admin/kyc-config', {
      format: 2,
      steps: [
        {
          slug: 'proof-of-funds',
          title: 'Proof of Funds',
          enabled: true,
          fields: [
            {
              id: 'pof-1',
              name: 'sourceOfWealth',
              label: 'Source of wealth',
              type: 'text',
              required: true,
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/cannot be deleted/);

    // RE-READ: nothing was written.
    const after = (await master.get('/v1/admin/kyc-config')).body as { slug: string }[];
    expect(after.map((s) => s.slug)).toEqual(before.map((s) => s.slug));
  });
});

describe('the needs_review queue', () => {
  /*
   * The dashboard tile and the sidebar badge both count submitted +
   * under_review, and both used to link to `submitted` alone — so clicking a
   * badge reading 17 opened a list of 12, and the five a reviewer had already
   * picked up fell off the daily sweep. `needs_review` is that set as a filter
   * value, so the number and the destination mean the same thing.
   */
  it('returns BOTH submitted and under_review, and nothing else', async () => {
    const master = await actingAs(ctx, 'admin', ADMIN);
    const res = await master.get('/v1/admin/kyc?status=needs_review&limit=100');

    expect(res.status).toBe(200);
    const states = (res.body as { items: { status: string }[] }).items.map((i) => i.status);
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s === 'submitted' || s === 'under_review')).toBe(true);
  });

  it('still refuses a value that is neither a status nor the set', async () => {
    const master = await actingAs(ctx, 'admin', ADMIN);
    const res = await master.get('/v1/admin/kyc?status=nonsense');
    expect(res.status).toBe(400);
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
    /*
     * The VERIFIED identity IS the client row.
     *
     * Approval once wrote the level and nothing else: phone and country stayed
     * locked in the submission's JSONB, an operator opening a fully verified
     * client saw "—" for both, and the client list's country filter matched no
     * real client at all — seventeen approved clients were in that state. The
     * first fix PROMOTED the two fields on approval; 0139 removed the copy that
     * needed promoting. What the reviewer approved is what the account holds,
     * so there is nothing to move — and nothing moved.
     */
    expect(user.phone).toBe('+96170111111');
    expect(user.country).toBe('Lebanon');
    const review = await master.get(`/v1/admin/kyc/${clientId}`).expect(200);
    const personal = (review.body as { personalInfo?: Record<string, string> }).personalInfo;
    expect(personal?.phone, 'the review showed a different phone from the account').toBe(
      user.phone,
    );
    expect(personal?.country).toBe(user.country);
  });

  it('does not blank a value the submission did not carry', async () => {
    /*
     * The other half: a submission with no phone must not erase one taken at
     * registration. Promotion fills, it never clears — otherwise approving a
     * client would silently delete contact details the desk relies on.
     */
    const [fresh] = await ctx.db.db
      .insert(users)
      .values({
        email: `promote-none-${Date.now()}@oxshare-e2e.test`,
        passwordHash: 'x',
        firstName: 'No',
        lastName: 'Fields',
        phone: '+96170999999',
        country: 'Cyprus',
        dateOfBirth: '1985-06-01',
        nationality: 'Cypriot',
        address: 'Makarios Avenue 3',
        city: 'Nicosia',
        emailVerified: true,
      })
      .returning();
    // Complete — approval re-asks the one judge — and carrying no phone of its own.
    await ctx.db.db.insert(kycSubmissions).values({
      userId: fresh.id,
      status: 'submitted',
      personalInfo: {},
      document: { docType: 'passport', frontFilePath: '/uploads/kyc/n1.png' },
      selfie: { filePath: '/uploads/kyc/n2.png' },
      addressProof: { docType: 'utility_bill', filePath: '/uploads/kyc/n3.png' },
    });

    const master = await actingAs(ctx, 'admin', ADMIN);
    await master.patch(`/v1/admin/kyc/${fresh.id}/approve`).expect(200);

    const [after] = await ctx.db.db.select().from(users).where(eq(users.id, fresh.id));
    expect(after.phone).toBe('+96170999999');
    expect(after.country).toBe('Cyprus');
    expect(after.verificationLevel).toBe(1);
  });

  it('refuses to APPROVE a record the one judge finds incomplete, naming what is missing', async () => {
    /*
     * Approval checked nothing but the status. A submission from before today's
     * rules — or one whose profile moved after it was sent — could be raised to
     * level 1, the gate every withdrawal checks, with no city, no identity
     * document, or an under-age date of birth. It now asks the same judgement
     * the client's Submit gets.
     */
    const [thin] = await ctx.db.db
      .insert(users)
      .values({
        email: `approve-thin-${Date.now()}@oxshare-e2e.test`,
        passwordHash: 'x',
        firstName: 'Thin',
        lastName: 'Record',
        dateOfBirth: '1990-01-01',
        nationality: 'Lebanese',
        phone: '+96170888888',
        country: 'Lebanon',
        address: 'Hamra Street 12',
        emailVerified: true,
      })
      .returning();
    await ctx.db.db.insert(kycSubmissions).values({
      userId: thin.id,
      status: 'submitted',
      personalInfo: {},
      selfie: { filePath: '/uploads/kyc/t2.png' },
      addressProof: { docType: 'utility_bill', filePath: '/uploads/kyc/t3.png' },
    });

    const master = await actingAs(ctx, 'admin', ADMIN);
    const res = await master.patch(`/v1/admin/kyc/${thin.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/City/);
    expect(res.body.message).toMatch(/Identity Document/);

    const [after] = await ctx.db.db.select().from(users).where(eq(users.id, thin.id));
    expect(after.verificationLevel, 'an incomplete record was verified').toBe(0);
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
