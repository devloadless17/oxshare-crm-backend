import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import type { Session } from './http-setup';
import { KYC_TEST_PNG } from './support/kyc-upload';
import { PasswordService } from '../src/common/security/password.service';
import {
  admins,
  auditLog,
  clientVerifications,
  kycConfigSteps,
  kycSubmissions,
  notifications,
  roles,
  storedObjects,
  users,
} from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * "COMPLETE KYC" — staff do a client's KYC FOR them (0210, 8 Oct 2026).
 *
 * For clients who cannot do it themselves. What must hold is that it is
 * EXACTLY as correct as the client doing it — the client's own actions, the
 * client's own rules, no second road to "verified" — and that the record says
 * who did what. Each case below tries the thing that must not happen.
 */

const PASSWORD = 'admin-password-123';
const ASSIST = { email: 'assist-staff@oxshare.com', password: PASSWORD, name: 'Assist Staff' };
const FULL = { email: 'assist-full@oxshare.com', password: PASSWORD, name: 'Assist Full' };
const OUTSIDER = { email: 'assist-outsider@oxshare.com', password: PASSWORD, name: 'Outsider' };
const NO_ASSIST = { email: 'assist-reviewer@oxshare.com', password: PASSWORD, name: 'Reviewer' };
const MASKED = { email: 'assist-masked@oxshare.com', password: PASSWORD, name: 'Masked Staff' };

const ASSIST_KEYS = ['clients.view', 'kyc.view', 'kyc.documents.view', 'kyc.assist'];

let ctx: HttpTestContext;
let clientId: number;
const adminIds: Record<string, string> = {};

function upload(session: Session, field: string, docType?: string) {
  const req = session
    .post(`/v1/admin/kyc/${clientId}/assist/upload`, undefined)
    .field('field', field);
  if (docType) req.field('docType', docType);
  return req.attach('file', KYC_TEST_PNG, { filename: `${field}.png`, contentType: 'image/png' });
}

/** Signs a staff member in — the login takes their email and password only. */
function signIn(who: { email: string; password: string }) {
  return actingAs(ctx, 'admin', { email: who.email, password: who.password });
}

async function kycRow() {
  const [row] = await ctx.db.db
    .select()
    .from(kycSubmissions)
    .where(eq(kycSubmissions.userId, clientId));
  return row;
}

/** The parts of the page layout these cases read. */
type Page = { target: { field: string; docType?: string }; filePath?: string };
type Step = {
  slug: string;
  fields: { name: string; hidden: boolean }[];
  document?: { types: { value: string; pages: Page[] }[] };
};

function stepOf(body: unknown, slug: string): Step {
  const step = (body as { steps: Step[] }).steps.find((s) => s.slug === slug);
  if (!step) throw new Error(`no ${slug} step on the page`);
  return step;
}

function passportPages(body: unknown): Page[] {
  const passport = stepOf(body, 'document').document?.types.find((t) => t.value === 'passport');
  if (!passport) throw new Error('passport is not offered');
  return passport.pages;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  await db.insert(kycConfigSteps).values(
    DEFAULT_KYC_STEPS.map((step) => ({
      id: step.id,
      stepNumber: step.stepNumber,
      slug: step.slug,
      title: step.title,
      description: step.description,
      icon: step.icon,
      enabled: step.enabled,
      fields: step.fields as unknown as Record<string, unknown>[],
    })),
  );

  for (const [who, permissions, extra] of [
    [ASSIST, ASSIST_KEYS, {}],
    [FULL, ALL_PERMISSIONS, {}],
    // Holds every key and sees no client: an empty territory is no sight (0154).
    [OUTSIDER, ALL_PERMISSIONS, { seesAllClients: false }],
    [NO_ASSIST, ['clients.view', 'kyc.view', 'kyc.documents.view', 'kyc.review'], {}],
    [MASKED, ASSIST_KEYS, {}],
  ] as const) {
    const [role] = await db
      .insert(roles)
      .values({
        name: who.name,
        permissions: [...permissions],
        ...(who === MASKED ? { maskedFields: ['client.phone'] } : {}),
      })
      .returning();
    const [admin] = await db
      .insert(admins)
      .values({
        email: who.email,
        passwordHash: await passwords.hash(who.password),
        name: who.name,
        role: 'sub_admin',
        roleId: role.id,
        permissions: [],
        status: 'active',
        ...extra,
      })
      .returning();
    adminIds[who.email] = admin.id;
  }

  // Signed up, details complete, and never started the KYC.
  const [client] = await db
    .insert(users)
    .values({
      email: 'assist-client@oxshare-e2e.test',
      passwordHash: await passwords.hash('client-password-123'),
      firstName: 'Samir',
      lastName: 'Khoury',
      dateOfBirth: '1948-03-02',
      nationality: 'Lebanese',
      phone: '+96170555123',
      country: 'Lebanon',
      address: 'Rue Gouraud 4',
      city: 'Beirut',
      emailVerified: true,
    })
    .returning();
  clientId = client.id;
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('who may open a client’s KYC to complete it', () => {
  it('opening it writes nothing, and lays the form out server-side', async () => {
    const staff = await signIn(ASSIST);
    const res = await staff.get(`/v1/admin/kyc/${clientId}/assist`);
    expect(res.status).toBe(200);
    // A client who never started is not put in the queue's counts by being looked at.
    expect(await kycRow()).toBeUndefined();

    expect(res.body.status).toBe('not_started');
    expect(res.body.editable).toBe(true);
    expect(res.body.complete).toBe(false);
    // The console sends the slot back as given — it never derives one.
    expect(passportPages(res.body)[0].target).toEqual({ field: 'doc_front', docType: 'passport' });
  });

  it('a client outside the reader’s territory is not found, for a read or a write', async () => {
    const outsider = await signIn(OUTSIDER);
    expect((await outsider.get(`/v1/admin/kyc/${clientId}/assist`)).status).toBe(404);
    const write = await outsider.post(`/v1/admin/kyc/${clientId}/assist/step`, {
      step: 'personal',
      data: { city: 'Tyre' },
    });
    expect(write.status).toBe(404);
  });

  it('a suspended client’s KYC is read, never changed: the page says so, and writes are refused', async () => {
    await ctx.db.db.update(users).set({ status: 'suspended' }).where(eq(users.id, clientId));
    try {
      const staff = await signIn(ASSIST);
      const page = await staff.get(`/v1/admin/kyc/${clientId}/assist`);
      expect(page.status).toBe(200);
      expect(page.body).toMatchObject({ suspended: true, editable: false });
      const write = await staff.post(`/v1/admin/kyc/${clientId}/assist/step`, {
        step: 'personal',
        data: { city: 'Tyre' },
      });
      expect(write.status).toBe(403);
      expect((await upload(staff, 'doc_front', 'passport')).status).toBe(403);
      expect(await kycRow()).toBeUndefined();
    } finally {
      await ctx.db.db.update(users).set({ status: 'active' }).where(eq(users.id, clientId));
    }
  });

  it('reviewing is not completing: without kyc.assist the page is refused', async () => {
    const reviewer = await signIn(NO_ASSIST);
    expect((await reviewer.get(`/v1/admin/kyc/${clientId}/assist`)).status).toBe(403);
  });

  it('a detail the role hides is hidden on the page, not just in the review', async () => {
    const masked = await signIn(MASKED);
    const res = await masked.get(`/v1/admin/kyc/${clientId}/assist`);
    expect(res.status).toBe(200);
    expect(res.body.personalInfo.phone).toBeUndefined();
    expect(res.body.personalInfo.city).toBe('Beirut');
    const phone = stepOf(res.body, 'personal').fields.find((f) => f.name === 'phone');
    expect(phone?.hidden).toBe(true);
  });
});

describe('completing it, under the client’s own rules', () => {
  it('a detail changed for the client is the profile, audited under the staff member', async () => {
    const staff = await signIn(ASSIST);
    const res = await staff.post(`/v1/admin/kyc/${clientId}/assist/step`, {
      step: 'personal',
      data: { city: 'Tripoli' },
    });
    expect(res.status).toBe(201);
    const [user] = await ctx.db.db.select().from(users).where(eq(users.id, clientId));
    expect(user.city).toBe('Tripoli');
    const [row] = await ctx.db.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'client.profile_update'), eq(auditLog.subjectId, String(clientId))),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row.actorKind).toBe('admin');
    expect(row.actorId).toBe(adminIds[ASSIST.email]);
    expect(row.details).toMatchObject({ via: 'kyc_assist' });
  });

  it('a page uploaded for the client is recorded as uploaded by the staff member', async () => {
    const staff = await signIn(ASSIST);
    const res = await upload(staff, 'doc_front', 'passport');
    expect(res.status).toBe(201);
    expect(passportPages(res.body)[0].filePath).toMatch(/^uploads\/kyc\//);

    const [object] = await ctx.db.db
      .select()
      .from(storedObjects)
      .where(eq(storedObjects.ownerUserId, clientId))
      .orderBy(desc(storedObjects.createdAt))
      .limit(1);
    expect(object.uploadedByKind).toBe('admin');
    expect(object.uploadedById).toBe(adminIds[ASSIST.email]);

    const docs = await staff.get(`/v1/admin/clients/${clientId}/documents`);
    const items = (docs.body as { items: { category: string; uploadedByStaff: string | null }[] })
      .items;
    expect(items.find((d) => d.category === 'identity')?.uploadedByStaff).toBe(ASSIST.name);
  });

  it('submit runs the client’s judge: an incomplete KYC is refused', async () => {
    const staff = await signIn(ASSIST);
    const res = await staff.post(`/v1/admin/kyc/${clientId}/assist/submit`, {});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await kycRow()).status).toBe('in_progress');
  });

  it('approving needs kyc.review, and is refused BEFORE anything is submitted', async () => {
    const staff = await signIn(ASSIST);
    expect((await upload(staff, 'selfie')).status).toBe(201);
    expect((await upload(staff, 'address_proof', 'utility_bill')).status).toBe(201);

    const res = await staff.post(`/v1/admin/kyc/${clientId}/assist/submit`, { approve: true });
    expect(res.status).toBe(403);
    expect((await kycRow()).status).toBe('in_progress');
  });

  it('a submission sent for the client records who sent it, and then cannot be edited', async () => {
    const staff = await signIn(ASSIST);
    const res = await staff.post(`/v1/admin/kyc/${clientId}/assist/submit`, {});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('submitted');
    expect(res.body.submittedByName).toBe(ASSIST.name);
    expect((await kycRow()).submittedByAdminId).toBe(adminIds[ASSIST.email]);

    // Never swapped under a reviewer: changing it means returning it first.
    const edit = await upload(staff, 'doc_front', 'passport');
    expect(edit.status).toBe(403);
    expect(edit.body.message).toMatch(/Return it/);
  });

  it('Return to edit records a return and sends the client nothing', async () => {
    const full = await signIn(FULL);
    const res = await full.post(`/v1/admin/kyc/${clientId}/assist/return`, {
      reason: 'Staff are completing the documents with the client.',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('rejected');
    expect(res.body.editable).toBe(true);

    const [decision] = await ctx.db.db
      .select()
      .from(clientVerifications)
      .where(eq(clientVerifications.userId, clientId))
      .orderBy(desc(clientVerifications.seq))
      .limit(1);
    expect(decision.outcome).toBe('returned');
    const told = await ctx.db.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientId, String(clientId)),
          eq(notifications.kind, 'kyc.rejected'),
        ),
      );
    expect(told).toHaveLength(0);
  });

  it('Submit & approve verifies through the same approval, and the record says who', async () => {
    const full = await signIn(FULL);
    const res = await full.post(`/v1/admin/kyc/${clientId}/assist/submit`, { approve: true });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('approved');

    const [user] = await ctx.db.db.select().from(users).where(eq(users.id, clientId));
    expect(user.verificationLevel).toBe(1);
    const [decision] = await ctx.db.db
      .select()
      .from(clientVerifications)
      .where(eq(clientVerifications.userId, clientId))
      .orderBy(desc(clientVerifications.seq))
      .limit(1);
    expect(decision.outcome).toBe('verified');
    expect(decision.adminEmail).toBe(FULL.email);

    const review = await full.get(`/v1/admin/kyc/${clientId}`);
    expect(review.body.submittedByName).toBe(FULL.name);

    await vi.waitFor(
      async () => {
        const [row] = await ctx.db.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'kyc.assist_submit'),
              eq(auditLog.actorId, adminIds[FULL.email]),
            ),
          )
          .limit(1);
        expect(row?.details).toMatchObject({ approve: true });
      },
      { timeout: 5_000, interval: 50 },
    );

    // Verified is verified: a document changes only through re-verification.
    const after = await upload(full, 'doc_front', 'passport');
    expect(after.status).toBe(403);
    expect(after.body.message).toMatch(/re-verification/);
  });
});
