import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { anonymous, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { users } from '../src/database/schema';
import { SIGN_UP_DETAILS } from './support/registration';

/**
 * SIGN-UP SAYS PLAINLY WHEN AN ADDRESS ALREADY HAS AN ACCOUNT.
 *
 * ⚠️ This file used to pin the OPPOSITE, as `auth-registration-oracle.spec.ts`:
 * a taken address had to be answered exactly like a fresh one, so the form told
 * nobody who holds an account, and the holder was emailed instead. The owner
 * reversed that on 28 Sep 2026. A client who already had an account was shown a
 * code screen for a code that never came, while their inbox said the opposite,
 * and clients found it confusing.
 *
 * So a taken address is now refused with 409 `EMAIL_ALREADY_REGISTERED`, the
 * sentence under the email field, and nothing is created or sent. The portal
 * shows it and offers a password reset and sign-in. The first sign-up step asks
 * `register/email-available` before the details are typed.
 *
 * The accepted cost: anyone can test whether an address has an account. Both
 * routes are rate limited.
 *
 * The positive control stays, for the reason it was written: a sign-up that
 * refuses everybody would satisfy "refuses the taken address" perfectly.
 */

let ctx: HttpTestContext;

const REGISTER = '/v1/auth/register';
const AVAILABLE = '/v1/auth/register/email-available';
/*
 * The ORIGIN header, on every request: `CsrfGuard` checks origin on every state
 * change including the session-establishing routes — a forged register is how
 * an attacker signs a victim's browser into an account the attacker controls.
 */
const ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';

const body = (email: string) => ({
  firstName: 'Taken',
  lastName: 'Probe',
  email,
  password: 'probe-password-123',
  ...SIGN_UP_DETAILS,
});

beforeAll(async () => {
  ctx = await startHttpTestApp();
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('POST /auth/register with an address that already has an account', () => {
  it('refuses it plainly, with the sentence under the email field', async () => {
    const taken = `taken-${Date.now()}@oxshare-e2e.test`;
    const first = await anonymous(ctx).post(REGISTER).set('Origin', ORIGIN).send(body(taken));
    expect(first.status, 'the setup registration failed, so nothing below is taken').toBe(201);

    // Upper-cased: addresses match case-insensitively, so this is the same one.
    const again = await anonymous(ctx)
      .post(REGISTER)
      .set('Origin', ORIGIN)
      .send(body(taken.toUpperCase()));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('EMAIL_ALREADY_REGISTERED');
    expect(again.body.fields?.email).toMatch(/already has an OxShare account/i);
    expect(again.body.fields?.email).toMatch(/reset your password/i);

    // Still ONE account for the address.
    const rows = await ctx.db.db.select().from(users).where(eq(users.email, taken));
    expect(rows).toHaveLength(1);
  });

  it('still CREATES a new account — a sign-up refusing everybody would pass the case above', async () => {
    const email = `taken-control-${Date.now()}@oxshare-e2e.test`;
    const res = await anonymous(ctx).post(REGISTER).set('Origin', ORIGIN).send(body(email));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ message: expect.stringMatching(/6-digit code/) as unknown });

    const [row] = await ctx.db.db.select().from(users).where(eq(users.email, email));
    expect(row, 'registration no longer creates anything').toBeDefined();
    expect(row?.emailVerified, 'a new registration must not arrive pre-verified').toBe(false);
    expect(row?.verificationLevel, 'a new registration must not arrive verified').toBe(0);
  });
});

describe('POST /auth/register/email-available — the first sign-up step', () => {
  it('answers false for a taken address and true for a free one', async () => {
    const taken = `taken-avail-${Date.now()}@oxshare-e2e.test`;
    await anonymous(ctx).post(REGISTER).set('Origin', ORIGIN).send(body(taken)).expect(201);

    const takenRes = await anonymous(ctx)
      .post(AVAILABLE)
      .set('Origin', ORIGIN)
      .send({ email: taken.toUpperCase() });
    expect(takenRes.status).toBe(200);
    expect(takenRes.body).toEqual({ available: false });

    const free = await anonymous(ctx)
      .post(AVAILABLE)
      .set('Origin', ORIGIN)
      .send({ email: `free-${Date.now()}@oxshare-e2e.test` });
    expect(free.body).toEqual({ available: true });
  });

  it('refuses something that is not an address', async () => {
    const res = await anonymous(ctx)
      .post(AVAILABLE)
      .set('Origin', ORIGIN)
      .send({ email: 'not-an-address' });
    expect(res.status).toBe(400);
  });
});
