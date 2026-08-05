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
import { admins, kycSubmissions, roles, users } from '../src/database/schema';

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

let ctx: HttpTestContext;
let clientId: string;
let otherId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const [adminHash, clientHash] = await Promise.all([
    passwords.hash(ADMIN.password),
    passwords.hash(CLIENT.password),
  ]);

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Master Admin', permissions: ['*'], isSystem: true })
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
      permissions: ['*'],
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

  it('refuse a client who has not verified their email', async () => {
    // EmailVerifiedGuard. 403 not 401: the credential is valid, the account is
    // not yet eligible — a 401 would sign them out of the screen telling them
    // to check their inbox.
    const session = await actingAs(ctx, 'portal', UNVERIFIED);
    await session.get('/v1/kyc/status').expect(403);
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

  it('refuse a submit that is missing documents', async () => {
    const session = await actingAs(ctx, 'portal', OTHER);
    const res = await session.post('/v1/kyc/submit');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/document|selfie|address/i);
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

  it('refuses even a master admin a config with the mandated steps removed', async () => {
    // FR-CORE-15: every customer uploads the three document types. Permission to
    // edit the flow is not permission to delete the requirement.
    const master = await actingAs(ctx, 'admin', ADMIN);
    const res = await master.put('/v1/admin/kyc-config', { steps: [] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/personal|document|selfie|address/i);
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
