import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { anonymous, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { users } from '../src/database/schema';

/**
 * REGISTRATION MUST NOT SAY WHETHER AN ADDRESS IS TAKEN.
 *
 * ⚠️ IT DID, AND EVERY OTHER DEFENCE IN THAT FUNCTION WAS CORRECT.
 *
 * `auth.service.ts` does not throw on an existing address, emails the real
 * holder, logs it, and returns the same 201 with the same sentence. All of that
 * is what a careful implementation does. And the response carried an optional
 * `userId` — present for a new address, absent for a taken one — so:
 *
 *   unused address      201  { message, userId }
 *   client@oxshare.com  201  { message }
 *
 * Same status, same message, and THE PRESENCE OF THE KEY is the oracle. POST an
 * address, read one field, learn whether it holds an account. The DTO's own
 * docblock said the endpoint "deliberately does not disclose" exactly the fact
 * its shape disclosed.
 *
 * ## Why these cases assert IDENTITY rather than "no userId"
 *
 * "The existing-address response has no `userId`" passes against a response
 * that later grows a `createdAt`, a `verified: false`, or anything else that
 * differs between the two paths. The property is INDISTINGUISHABILITY, not the
 * absence of one field, so the bodies are compared whole.
 *
 * ## And why the positive control is not optional
 *
 * "The two responses match" is perfectly satisfied by a register endpoint that
 * has stopped working — two identical failures are identical. So one case
 * proves a genuinely new registration still CREATES THE ROW.
 *
 * ## Timing was checked and is not a second channel
 *
 * Measured on a known pair: 0.097s existing against 0.119s new. Noise at that
 * separation. Recorded so the next person does not have to re-establish it, and
 * so that a future change which makes the existing path much cheaper — skipping
 * the password hash, say — is understood to reopen the question.
 */

let ctx: HttpTestContext;

const REGISTER = '/v1/auth/register';
/*
 * The ORIGIN header, on every request. `CsrfGuard` checks origin on every state
 * change INCLUDING the session-establishing routes — deliberately, because a
 * forged register is how an attacker signs a victim's browser into an account
 * the attacker controls, and the victim then uploads their passport into it.
 * Without this every case below answers 403 and proves nothing about the
 * oracle.
 */
const ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';

const body = (email: string) => ({
  firstName: 'Oracle',
  lastName: 'Probe',
  email,
  password: 'probe-password-123',
});

beforeAll(async () => {
  ctx = await startHttpTestApp();
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('POST /auth/register is not a membership oracle', () => {
  it('answers a TAKEN address exactly as it answers a fresh one', async () => {
    const taken = `oracle-taken-${Date.now()}@oxshare-e2e.test`;
    const fresh = `oracle-fresh-${Date.now()}@oxshare-e2e.test`;

    // Make the first address genuinely taken, through the real endpoint.
    const first = await anonymous(ctx).post(REGISTER).set('Origin', ORIGIN).send(body(taken));
    expect(first.status, 'the setup registration failed, so nothing below is taken').toBe(201);

    const repeat = await anonymous(ctx).post(REGISTER).set('Origin', ORIGIN).send(body(taken));
    const brandNew = await anonymous(ctx).post(REGISTER).set('Origin', ORIGIN).send(body(fresh));

    expect(repeat.status, 'the two paths answer different statuses').toBe(brandNew.status);
    expect(
      repeat.body,
      'registering a TAKEN address answers differently from a fresh one, so the endpoint ' +
        'is a membership oracle: POST an address, compare the body, learn whether it holds ' +
        'an account. Compared whole rather than field by field — the property is that the ' +
        'two are indistinguishable, not that one particular key is missing.',
    ).toEqual(brandNew.body);
  });

  it('still CREATES the account — two identical failures are also identical', async () => {
    /*
     * The positive control, and it is the half that would be easy to skip.
     * Without it the case above is satisfied by an endpoint that answers the
     * same thing to everybody because it has stopped registering anyone.
     */
    const email = `oracle-control-${Date.now()}@oxshare-e2e.test`;
    const res = await anonymous(ctx).post(REGISTER).set('Origin', ORIGIN).send(body(email));
    expect(res.status).toBe(201);

    const [row] = await ctx.db.db.select().from(users).where(eq(users.email, email));
    expect(
      row,
      'the responses match because registration no longer creates anything',
    ).toBeDefined();
    expect(row?.emailVerified, 'a new registration must not arrive pre-verified').toBe(false);
    expect(row?.verificationLevel, 'a new registration must not arrive verified').toBe(0);
  });

  it('returns NO user id to anybody — there is nothing to be present or absent', async () => {
    /*
     * Narrower than the identity case and kept beside it deliberately: this one
     * names the specific field that was the oracle, so a reader of a future
     * failure sees WHICH thing came back rather than only that two bodies
     * differ. The case above is the guarantee; this is the diagnosis.
     */
    const email = `oracle-nofield-${Date.now()}@oxshare-e2e.test`;
    const res = await anonymous(ctx).post(REGISTER).set('Origin', ORIGIN).send(body(email));
    expect(Object.keys(res.body as Record<string, unknown>)).toEqual(['message']);
  });
});
