import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { EmailService } from '../src/modules/email/email.service';
import {
  adminClientTagScopes,
  admins,
  auditLog,
  clientTags,
  roles,
  users,
} from '../src/database/schema';

/**
 * "NEW CLIENT" — staff create a client for somebody who cannot sign up (0211).
 *
 * What must hold: the client is created by the SAME checks a sign-up passes
 * and nobody but the client ever knows their password; the record says who
 * created them; a double click is one client; a client the creator could not
 * open afterwards is never kept; and the welcome link works once, confirms the
 * address and expires. Each case tries the thing that must not happen.
 */

const PASSWORD = 'admin-password-123';
const FULL = { email: 'create-full@oxshare.com', name: 'Create Full' };
const DESK = { email: 'create-desk@oxshare.com', name: 'Lebanon Desk' };
const VIEWER = { email: 'create-viewer@oxshare.com', name: 'Viewer Only' };

let ctx: HttpTestContext;
const adminIds: Record<string, string> = {};
const welcomes: { to: string; token: string; locale: string }[] = [];

const details = (over: Record<string, unknown> = {}) => ({
  email: `new-${randomUUID().slice(0, 8)}@oxshare-e2e.test`,
  firstName: 'Samir',
  lastName: 'Khoury',
  dateOfBirth: '1948-03-02',
  nationality: 'Lebanese',
  phone: `+9617${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
  country: 'Lebanon',
  ...over,
});

function signIn(who: { email: string }) {
  return actingAs(ctx, 'admin', { email: who.email, password: PASSWORD });
}

async function userByEmail(email: string) {
  const [row] = await ctx.db.db.select().from(users).where(eq(users.email, email));
  return row;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();
  const [lebanon] = await db.select().from(clientTags).where(eq(clientTags.countryCode, 'LB'));

  for (const [who, permissions, seesAll] of [
    [FULL, ALL_PERMISSIONS, true],
    // A country desk: sees Lebanon's clients and nobody else's.
    [DESK, ['clients.view', 'clients.create'], false],
    [VIEWER, ['clients.view'], true],
  ] as const) {
    const [role] = await db
      .insert(roles)
      .values({ name: who.name, permissions: [...permissions] })
      .returning();
    const [admin] = await db
      .insert(admins)
      .values({
        email: who.email,
        passwordHash: await passwords.hash(PASSWORD),
        name: who.name,
        role: 'sub_admin',
        roleId: role.id,
        permissions: [],
        status: 'active',
        seesAllClients: seesAll,
      })
      .returning();
    adminIds[who.email] = admin.id;
  }
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: adminIds[DESK.email], tagId: lebanon.id, createdBy: adminIds[FULL.email] });

  // The token goes in the email and nowhere else — so the email is where the test reads it.
  vi.spyOn(ctx.app.get(EmailService), 'sendClientWelcomeEmail').mockImplementation(
    (to: string, token: string, _name: string, _id: number, locale = 'en') => {
      welcomes.push({ to, token, locale });
      return Promise.resolve();
    },
  );
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('staff create a client', () => {
  it('by the sign-up’s checks, with no password anybody knows, and the record says who', async () => {
    const staff = await signIn(FULL);
    const body = details({ locale: 'ar' });
    const res = await staff.post('/v1/admin/clients', body).set('Idempotency-Key', randomUUID());
    expect(res.status).toBe(201);

    const user = await userByEmail(body.email);
    expect(res.body.id).toBe(user.id);
    expect(user.createdByAdminId).toBe(adminIds[FULL.email]);
    expect(user.passwordSetAt).toBeNull();
    expect(user.emailVerified).toBe(false);
    expect(user.verificationLevel).toBe(0);
    expect(user.locale).toBe('ar');

    const [row] = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'client.created'), eq(auditLog.subjectId, String(user.id))));
    expect(row.actorId).toBe(adminIds[FULL.email]);
    expect(welcomes.at(-1)).toMatchObject({ to: body.email, locale: 'ar' });
    // A welcome link lives days, not a reset's 30 minutes.
    expect(user.passwordResetExpiry!.getTime() - Date.now()).toBeGreaterThan(6 * 86_400_000);
  });

  it('a retried click is one client, not two', async () => {
    const staff = await signIn(FULL);
    const body = details();
    const key = randomUUID();
    const first = await staff.post('/v1/admin/clients', body).set('Idempotency-Key', key);
    const again = await staff.post('/v1/admin/clients', body).set('Idempotency-Key', key);
    expect(first.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    const rows = await ctx.db.db.select().from(users).where(eq(users.email, body.email));
    expect(rows).toHaveLength(1);
  });

  it('a taken email or phone is refused under its field, exactly as at sign-up', async () => {
    const staff = await signIn(FULL);
    const taken = details();
    await staff.post('/v1/admin/clients', taken).set('Idempotency-Key', randomUUID());

    const sameEmail = await staff
      .post('/v1/admin/clients', details({ email: taken.email }))
      .set('Idempotency-Key', randomUUID());
    expect(sameEmail.status).toBe(409);
    expect(sameEmail.body.code).toBe('EMAIL_ALREADY_REGISTERED');

    const samePhone = await staff
      .post('/v1/admin/clients', details({ phone: taken.phone }))
      .set('Idempotency-Key', randomUUID());
    expect(samePhone.status).toBe(409);
    expect(samePhone.body.code).toBe('PHONE_ALREADY_REGISTERED');
  });

  it('a client the creator could not open afterwards is refused, and nothing is kept', async () => {
    const desk = await signIn(DESK);
    const elsewhere = details({ country: 'Jordan', nationality: 'Jordanian' });
    const res = await desk
      .post('/v1/admin/clients', elsewhere)
      .set('Idempotency-Key', randomUUID());
    expect(res.status).toBe(409);
    expect(await userByEmail(elsewhere.email)).toBeUndefined();

    const theirs = details();
    const ok = await desk.post('/v1/admin/clients', theirs).set('Idempotency-Key', randomUUID());
    expect(ok.status).toBe(201);
  });

  it('creating clients is its own key', async () => {
    const viewer = await signIn(VIEWER);
    const res = await viewer
      .post('/v1/admin/clients', details())
      .set('Idempotency-Key', randomUUID());
    expect(res.status).toBe(403);
  });
});

describe('the welcome link', () => {
  it('sets the client’s password once, confirms the address, and lets them sign in', async () => {
    const staff = await signIn(FULL);
    const body = details();
    await staff.post('/v1/admin/clients', body).set('Idempotency-Key', randomUUID());
    const { token } = welcomes.at(-1)!;

    const set = await request(ctx.server)
      .post('/v1/auth/reset-password')
      .set('Origin', 'http://localhost:3000')
      .send({ token, newPassword: 'client-chosen-123' });
    expect(set.status).toBeLessThan(300);
    const user = await userByEmail(body.email);
    expect(user.passwordSetAt).not.toBeNull();
    expect(user.emailVerified).toBe(true);

    const replay = await request(ctx.server)
      .post('/v1/auth/reset-password')
      .set('Origin', 'http://localhost:3000')
      .send({ token, newPassword: 'someone-else-123' });
    expect(replay.status).toBe(400);
    expect(
      (await actingAs(ctx, 'portal', { email: body.email, password: 'client-chosen-123' })).cookies,
    ).toBeDefined();

    // Chosen: there is no welcome left to send.
    const resend = await staff.post(`/v1/admin/clients/${user.id}/welcome`, {});
    expect(resend.status).toBe(409);
  });

  it('expires', async () => {
    const staff = await signIn(FULL);
    const body = details();
    await staff.post('/v1/admin/clients', body).set('Idempotency-Key', randomUUID());
    const { token } = welcomes.at(-1)!;
    await ctx.db.db
      .update(users)
      .set({ passwordResetExpiry: new Date(Date.now() - 1000) })
      .where(eq(users.email, body.email));
    const res = await request(ctx.server)
      .post('/v1/auth/reset-password')
      .set('Origin', 'http://localhost:3000')
      .send({ token, newPassword: 'client-chosen-123' });
    expect(res.status).toBe(400);
  });

  it('a mistyped address is fixed by changing it: the welcome goes to the new one', async () => {
    const staff = await signIn(FULL);
    const body = details();
    const created = await staff
      .post('/v1/admin/clients', body)
      .set('Idempotency-Key', randomUUID());
    const verification = vi.spyOn(ctx.app.get(EmailService), 'sendVerificationEmail');
    const fixed = `fixed-${randomUUID().slice(0, 8)}@oxshare-e2e.test`;
    const res = await staff.patch(`/v1/admin/clients/${created.body.id}/email`, { email: fixed });
    expect(res.status).toBe(200);
    expect(welcomes.at(-1)?.to).toBe(fixed);
    expect(verification).not.toHaveBeenCalled();
  });
});
