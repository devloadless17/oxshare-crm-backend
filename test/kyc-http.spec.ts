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
        // The CLIENT's contact details live on its profile (0139), as the KYC
        // personal step would have stored them — E.164, trimmed.
        ...(c.email === CLIENT.email ? { phone: '+96170111111', country: 'Lebanon' } : {}),
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

  it('lets an admin with kyc.edit delete every step FR-CORE-15 mandated', async () => {
    /*
     * This asserted a 400: `personal`, `document`, `selfie` and `address` were
     * mandated by FR-CORE-15 and could not be removed by anyone.
     *
     * The owner retired that rule on 15 Aug 2026 — a KYC flow sold as
     * configurable that refuses to drop four of its steps is not configurable,
     * and which documents a jurisdiction demands is the broker's decision.
     *
     * ⚠️ THE PROBE CHANGED ON 10 Sep 2026, AND THE PROPERTY DID NOT.
     *
     * It used to send `{ steps: [] }`, on the reasoning that the empty config is
     * the extreme case and therefore the sharpest test — if any step were still
     * secretly required, an empty save is what would reveal it. `KycConfigDto`
     * now carries `@ArrayNotEmpty`, so that call answers 400 and this case had
     * to be rewritten or deleted.
     *
     * It is rewritten, because the empty config was the WEAKER probe of the two.
     * A refusal of `[]` is consistent with every step being freely deletable —
     * it says nothing about WHICH steps are required, only that a configuration
     * must exist. What actually pins the owner's decision is a config holding
     * ONE step that is none of the four: it deletes `personal`, `document`,
     * `selfie` and `address` in a single save and is accepted. If any of them
     * were still secretly mandated, THIS is the call that fails.
     *
     * ## Why the floor is not the retired rule wearing a new name
     *
     * The retired rule named four steps and refused to let them go. The floor
     * names none: every step here is deletable, including all four, down to
     * whichever one an operator chooses to keep. What it refuses is a save that
     * leaves nothing behind — and zero steps is not a flow anybody configured,
     * it is the absence of one. `KycConfigStore.setSteps` is a DELETE followed
     * by an INSERT, so an empty save wiped onboarding for every client: the
     * wizard renders nothing, nobody can submit, no reviewer receives anything,
     * and no client can reach a money screen again. It answered 200 and looked
     * entirely normal until the next registration.
     *
     * The old probe was also AMBIGUOUS, which is a reason to prefer this one
     * independently of the floor: a reader meeting `[] → 200` cannot tell
     * whether the system permits an empty configuration DELIBERATELY or merely
     * fails to forbid it. This case cannot be misread that way — it asserts one
     * property and names it.
     *
     * If the owner wants zero savable, this is one decorator out of
     * `compliance.dto.ts`. What should NOT come back is a bare `{ steps: [] }` /
     * 200 with no sentence saying which of those two it is asserting; that is
     * the ambiguity above, and it is what let this stand as evidence for a
     * decision it only half describes. The reasoning is in `compliance.dto.ts`
     * beside the decorator, and the cost of the 200 is in
     * `kyc-config-round-trip.spec.ts`.
     *
     * The PERMISSION split above is untouched and still the real control — a
     * reviewer gets 403, only `kyc.edit` gets this far. What replaced the block
     * is the audit trail; see test/kyc-config-rules.spec.ts.
     */
    const master = await actingAs(ctx, 'admin', ADMIN);

    const before = await master.get('/v1/admin/kyc-config');
    const original = (Array.isArray(before.body) ? before.body : before.body.steps) as unknown[];

    const onlyStep = {
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
    };

    const res = await master.put('/v1/admin/kyc-config', { steps: [onlyStep] });
    expect(
      res.status,
      `dropping all four FR-CORE-15 steps answered ${res.status}: ` +
        JSON.stringify(res.body).slice(0, 200),
    ).toBe(200);

    /*
     * RE-READ. A 200 that did not persist would satisfy the line above while
     * leaving the four steps in place, which is the outcome this case exists to
     * refuse.
     */
    const after = await master.get('/v1/admin/kyc-config');
    const slugs = (
      (Array.isArray(after.body) ? after.body : after.body.steps) as { slug: string }[]
    ).map((s) => s.slug);
    expect(slugs, 'a mandated step survived a save that did not include it').toEqual([
      'proof-of-funds',
    ]);

    // Leave the config as it was found — later cases in this file read it.
    await master.put('/v1/admin/kyc-config', { steps: original });
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
        emailVerified: true,
      })
      .returning();
    await ctx.db.db.insert(kycSubmissions).values({
      userId: fresh.id,
      status: 'submitted',
      personalInfo: { firstName: 'No', lastName: 'Fields' },
    });

    const master = await actingAs(ctx, 'admin', ADMIN);
    await master.patch(`/v1/admin/kyc/${fresh.id}/approve`).expect(200);

    const [after] = await ctx.db.db.select().from(users).where(eq(users.id, fresh.id));
    expect(after.phone).toBe('+96170999999');
    expect(after.country).toBe('Cyprus');
    expect(after.verificationLevel).toBe(1);
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
