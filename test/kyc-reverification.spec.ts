import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { uploadKycFile } from './support/kyc-upload';
import { PasswordService } from '../src/common/security/password.service';
import {
  admins,
  auditLog,
  kycConfigSteps,
  kycSubmissions,
  roles,
  users,
} from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';
import { EmailService } from '../src/modules/email/email.service';

/**
 * AN APPROVED CLIENT WHOSE DETAILS CHANGED — the dead end, closed (26 Sep 2026).
 *
 * A verified detail that changes materially — a new passport, a move abroad —
 * had no path: the reviewer's screen offered nothing, and the API's one lever
 * was a REJECTION, which emails the client "your application needs correction"
 * and reads as a verdict on them.
 *
 * The owner's ruling: a typo is a CORRECTION (`kyc-identity-correction.spec.ts`);
 * a material change is a RE-VERIFICATION — the verification goes back to the
 * client with what to update, deposits and withdrawals pause until it is
 * approved again, and every screen says "please update your verification". This
 * walks the whole of it over HTTP, and the layout that lets a reviewer read any
 * submission without the builder.
 */

const ADMIN = { email: 'reverify-admin@oxshare.com', password: 'admin-password-123' };
const REVIEWER = { email: 'reverify-reviewer@oxshare.com', password: 'admin-password-123' };
const VIEWER = { email: 'reverify-viewer@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'reverify-client@oxshare-e2e.test', password: 'client-password-123' };
const REASON = 'Your passport on file has expired. Please upload your new one.';

let ctx: HttpTestContext;
let clientId: number;

async function row() {
  const [submission] = await ctx.db.db
    .select()
    .from(kycSubmissions)
    .where(eq(kycSubmissions.userId, clientId));
  const [user] = await ctx.db.db.select().from(users).where(eq(users.id, clientId));
  return { submission, user };
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

  for (const [who, name, permissions] of [
    [ADMIN, 'Reverify Full', ALL_PERMISSIONS],
    // Decides submissions, and cannot read the step builder — the layout must suffice.
    [REVIEWER, 'Reverify Reviewer', ['kyc.review']],
    [VIEWER, 'Reverify Viewer', ['kyc.view']],
  ] as const) {
    const [role] = await db
      .insert(roles)
      .values({ name, permissions: [...permissions] })
      .returning();
    await db.insert(admins).values({
      email: who.email,
      passwordHash: await passwords.hash(who.password),
      name,
      role: 'sub_admin',
      roleId: role.id,
      permissions: [],
      status: 'active',
    });
  }

  const [client] = await db
    .insert(users)
    .values({
      email: CLIENT.email,
      passwordHash: await passwords.hash(CLIENT.password),
      firstName: 'Layla',
      lastName: 'Haddad',
      dateOfBirth: '1990-04-12',
      nationality: 'Lebanese',
      phone: '+96170123456',
      country: 'Lebanon',
      address: 'Hamra Street 12',
      city: 'Beirut',
      emailVerified: true,
      verificationLevel: 1,
    })
    .returning();
  clientId = client.id;
  await db.insert(kycSubmissions).values({
    userId: clientId,
    status: 'approved',
    submittedAt: new Date(),
    reviewedAt: new Date(),
    personalInfo: {},
    document: { docType: 'passport', frontFilePath: '/uploads/kyc/old-passport.png' },
    selfie: { filePath: '/uploads/kyc/old-selfie.png' },
    addressProof: { docType: 'utility_bill', filePath: '/uploads/kyc/old-bill.png' },
  });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the review is laid out by the server', () => {
  it('reads whole for a role that decides submissions and cannot open the builder', async () => {
    const reviewer = await actingAs(ctx, 'admin', REVIEWER);
    expect((await reviewer.get('/v1/admin/kyc-config')).status).toBe(403);

    const detail = await reviewer.get(`/v1/admin/kyc/${clientId}`);
    expect(detail.status).toBe(200);
    const layout = detail.body.layout as {
      identity: { key: string; label: string }[];
      identityDocument: { label: string; pages: { slot: string; label: string }[] };
      proofOfAddress: { asked: boolean; label: string };
      selfie: { asked: boolean };
    };
    expect(layout.identity.map((field) => field.label)).toEqual([
      'First Name',
      'Last Name',
      'Date of Birth',
      'Nationality',
      'Phone Number',
      'Country of Residence',
      'Residential Address',
      'City',
      'State / Province',
      'Postal / ZIP code',
    ]);
    // Named precisely, never guessed: the document on file, with its own pages.
    expect(layout.identityDocument).toMatchObject({
      label: 'Passport',
      pages: [{ slot: 'doc_front', label: 'Photo Page' }],
    });
    expect(layout.proofOfAddress).toMatchObject({ asked: true, label: 'Utility Bill' });
    expect(layout.selfie.asked).toBe(true);
  });
});

describe('returning an APPROVED verification to the client', () => {
  it('needs the power to decide submissions', async () => {
    const viewer = await actingAs(ctx, 'admin', VIEWER);
    const res = await viewer
      .post(`/v1/admin/kyc/${clientId}/reverify`)
      .send({ reason: REASON, items: ['passport'] });
    expect(res.status).toBe(403);
    expect((await row()).submission.status).toBe('approved');
  });

  it('refuses a return with no reason, or nothing to update', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    for (const body of [
      { items: ['passport'] },
      { reason: '', items: ['passport'] },
      // Trimmed first: a reason of spaces is still no reason.
      { reason: '   ', items: ['passport'] },
      { reason: REASON, items: [] },
    ]) {
      const res = await admin.post(`/v1/admin/kyc/${clientId}/reverify`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await row()).submission.status).toBe('approved');
  });

  it('returns it: the level goes to 0, each page to redo is flagged, the client asked — not rejected', async () => {
    const email = ctx.app.get(EmailService);
    const asked = vi.spyOn(email, 'sendKycReverificationEmail').mockResolvedValue(undefined);
    const refused = vi.spyOn(email, 'sendKycDecisionEmail');

    const admin = await actingAs(ctx, 'admin', ADMIN);
    const res = await admin
      .post(`/v1/admin/kyc/${clientId}/reverify`)
      .send({ reason: REASON, items: ['passport', 'address'] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const { submission, user } = await row();
    expect(submission.status).toBe('rejected');
    expect(submission.reverificationRequestedAt).toBeInstanceOf(Date);
    // A whole document returned is every page of it; an identity field stays itself.
    expect(submission.rejectedFields).toEqual(['doc_front', 'address']);
    expect(user.verificationLevel, 'the money gate stayed open').toBe(0);

    expect(asked).toHaveBeenCalledWith(CLIENT.email, 'Layla', REASON, [
      'Passport',
      'Residential Address',
    ]);
    expect(refused, 'the client was sent the REJECTION email').not.toHaveBeenCalled();
    asked.mockRestore();
    refused.mockRestore();

    let audited: { details: unknown }[] = [];
    for (let attempt = 0; attempt < 40 && audited.length === 0; attempt += 1) {
      audited = await ctx.db.db
        .select({ details: auditLog.details })
        .from(auditLog)
        .where(eq(auditLog.action, 'kyc.reverification_request'));
      if (audited.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(audited[0]?.details).toMatchObject({ reason: REASON });
  });

  it('shows the client a request to update, with what to redo', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);
    const status = await client.get('/v1/kyc/status');
    expect(status.status).toBe(200);
    expect(status.body.reverificationRequestedAt).toBeTruthy();
    expect(status.body.rejectionReason).toBe(REASON);
    const document = (status.body.steps as { slug: string; returned: { label: string }[] }[]).find(
      (step) => step.slug === 'document',
    );
    expect(document?.returned.map((item) => item.label)).toEqual(['Passport']);
  });

  it('rings the client’s bell with a request to update — never a rejection', async () => {
    // The email said "please update"; the bell must not contradict it with
    // "declined", so the return has a kind of its own (D-78's client bell).
    const client = await actingAs(ctx, 'portal', CLIENT);
    const feed = await client.get('/v1/notifications');
    expect(feed.status).toBe(200);
    const items = feed.body.items as { kind: string; params: { reason?: string } }[];
    const asked = items.filter((item) => item.kind === 'kyc.reverification_requested');
    expect(asked, 'no bell row for the return').toHaveLength(1);
    expect(asked[0]?.params.reason).toBe(REASON);
    expect(
      items.some((item) => item.kind === 'kyc.rejected'),
      'the return rang as a REJECTION',
    ).toBe(false);
  });

  it('refuses a second return — only an approved verification can be returned', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const res = await admin
      .post(`/v1/admin/kyc/${clientId}/reverify`)
      .send({ reason: REASON, items: ['passport'] });
    expect(res.status).toBe(400);
  });

  it('closes when the client updates and a reviewer approves: level 1, the request cleared', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);
    expect((await uploadKycFile(client, 'doc_front', 'passport')).status).toBe(201);
    const saved = await client.post('/v1/kyc/step', {
      step: 'personal',
      data: { address: 'Verdun Street 4' },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBeLessThan(400);
    const submitted = await client.post('/v1/kyc/submit');
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

    const admin = await actingAs(ctx, 'admin', ADMIN);
    const approved = await admin.patch(`/v1/admin/kyc/${clientId}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const { submission, user } = await row();
    expect(submission.status).toBe('approved');
    expect(submission.reverificationRequestedAt).toBeNull();
    expect(user.verificationLevel).toBe(1);
    expect(user.address).toBe('Verdun Street 4');
  });

  /*
   * Reported 28 Sep 2026: the reason had to be ten characters, so a reviewer
   * padded a complete one ("Expired") before the button would work, with
   * nothing on screen saying why. A reason must EXIST; its length is the
   * reviewer's call. It reaches the client as written, trimmed.
   */
  it('takes a SHORT reason, trimmed — what matters is that there is one', async () => {
    const email = ctx.app.get(EmailService);
    const asked = vi.spyOn(email, 'sendKycReverificationEmail').mockResolvedValue(undefined);

    const admin = await actingAs(ctx, 'admin', ADMIN);
    const res = await admin
      .post(`/v1/admin/kyc/${clientId}/reverify`)
      .send({ reason: '  Expired ', items: ['passport'] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const { submission } = await row();
    expect(submission.status).toBe('rejected');
    expect(submission.rejectionReason).toBe('Expired');
    expect(asked).toHaveBeenCalledWith(CLIENT.email, 'Layla', 'Expired', ['Passport']);
    asked.mockRestore();
  });
});
