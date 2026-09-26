import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  anonymous,
  parseSetCookies,
  sessionFrom,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { emailRecorder } from './email-recorder';
import { EmailService } from '../src/modules/email/email.service';
import { UsersStore } from '../src/store/users.store';
import { users } from '../src/database/schema';
import { COOKIE_BASES } from '../src/common/security/session-cookies';
import { SIGN_UP_DETAILS } from './support/registration';

/**
 * SIGN-UP ENDS ON A CODE — asked for by the client, 25 Sep 2026: register, type
 * the 6-digit code from the email on the same screen, and be signed straight in.
 *
 * A code that short is safe only because of the bounds around it, so each case
 * below attempts the thing a bound forbids rather than describing it: guessing
 * past five, guessing in parallel, using a code twice, after its fifteen
 * minutes, after the address changed, and probing which addresses exist.
 */

const PORTAL_ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';
const PASSWORD = 'AGoodPassword123!';

let ctx: HttpTestContext;
let mail: ReturnType<typeof emailRecorder>;
let n = 0;

beforeAll(async () => {
  mail = emailRecorder();
  ctx = await startHttpTestApp({ overrides: [{ token: EmailService, value: mail.service }] });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

const post = (path: string, body: object) =>
  anonymous(ctx).post(`/v1${path}`).set('Origin', PORTAL_ORIGIN).send(body);

/** A fresh registration, and the code and link token its email carried. */
async function register(): Promise<{ email: string; code: string; token: string }> {
  const email = `code-${Date.now()}-${n++}@oxshare.test`;
  const res = await post('/auth/register', {
    firstName: 'Code',
    lastName: 'Client',
    email,
    password: PASSWORD,
    ...SIGN_UP_DETAILS,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const sent = mail.latest('sendVerificationEmail', email);
  expect(sent, 'no verification email was sent').toBeDefined();
  const [, token, code] = sent!.args as [string, string, string];
  expect(code, 'the email carried no code').toMatch(/^\d{6}$/);
  return { email, code, token };
}

const row = async (email: string) =>
  (await ctx.db.db.select().from(users).where(eq(users.email, email)))[0];

const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('the code arrives with the link, and only its keyed hash is kept', () => {
  it('mails a 6-digit code and stores neither the code nor a plain digest of it', async () => {
    const { email, code } = await register();
    const stored = await row(email);
    expect(stored.emailVerificationCodeHash).toMatch(/^[0-9a-f]{64}$/);
    // Not SHA-256(code): a million values would fall to a dump in a second.
    expect(stored.emailVerificationCodeHash).not.toBe(
      createHash('sha256').update(code).digest('hex'),
    );
    expect(JSON.stringify(stored)).not.toContain(code);
  });
});

describe('the right code confirms the address AND signs the client in', () => {
  it('answers with the verified user and a session that works', async () => {
    const { email, code, token } = await register();
    const res = await post('/auth/verify-email-code', { email, code });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ emailVerified: true, user: { email } });
    expect(JSON.stringify(res.body), 'a token reached the body').not.toMatch(/eyJ/);

    const cookies = parseSetCookies(res);
    expect(Object.keys(cookies).some((name) => name.includes(COOKIE_BASES.clientRefresh))).toBe(
      true,
    );
    const me = await sessionFrom(ctx, 'portal', cookies).get('/v1/auth/me');
    expect(me.status).toBe(200);

    const stored = await row(email);
    expect(stored.emailVerified).toBe(true);
    expect(stored.emailVerificationCodeHash, 'the code outlived its use').toBeNull();

    // The same email's link now answers honestly rather than "invalid".
    const link = await post('/auth/verify-email', { token });
    expect(link.body).toMatchObject({ status: 'already_verified' });
  });

  it('works once: the same code again is refused', async () => {
    const { email, code } = await register();
    expect((await post('/auth/verify-email-code', { email, code })).status).toBe(200);
    const again = await post('/auth/verify-email-code', { email, code });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ code: 'EMAIL_CODE_INVALID' });
  });
});

describe('a wrong code, and the five-attempt budget', () => {
  it('refuses a wrong code, and after five of them refuses the RIGHT one too', async () => {
    const { email, code } = await register();
    for (let i = 0; i < 5; i++) {
      const res = await post('/auth/verify-email-code', { email, code: wrong(code) });
      expect(res.body).toMatchObject({ code: 'EMAIL_CODE_INVALID' });
    }
    const late = await post('/auth/verify-email-code', { email, code });
    expect(late.status, 'a burned code still worked').toBe(400);
    expect((await row(email)).emailVerified).toBe(false);
  });

  it('counts parallel attempts exactly — ten at once spend five, not ten', async () => {
    /*
     * At the store, where the guarantee lives: the attempt is counted in the
     * same UPDATE that reads the hash, so ten simultaneous attempts against
     * real Postgres must get exactly five hashes back. (Ten simultaneous HTTP
     * requests race supertest's own listener here, not the database.)
     */
    const { email } = await register();
    const store = ctx.app.get(UsersStore);
    const id = (await row(email)).id;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.takeEmailCodeAttempt(id, 5, new Date())),
    );
    expect(results.filter((hash) => hash !== undefined)).toHaveLength(5);
    expect((await row(email)).emailVerificationCodeAttempts).toBe(5);
  });

  it('lets exactly ONE of two simultaneous right codes in', async () => {
    const { email, code } = await register();
    const results = await Promise.all([
      post('/auth/verify-email-code', { email, code }),
      post('/auth/verify-email-code', { email, code }),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
  });
});

describe('the bounds a stranger meets', () => {
  it('refuses a code past its fifteen minutes', async () => {
    const { email, code } = await register();
    await ctx.db.db
      .update(users)
      .set({ emailVerificationCodeExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(users.email, email));
    const res = await post('/auth/verify-email-code', { email, code });
    expect(res.body).toMatchObject({ code: 'EMAIL_CODE_INVALID' });
  });

  it('answers an unknown address and a confirmed one EXACTLY as a wrong code — no oracle', async () => {
    const { email, code } = await register();
    await post('/auth/verify-email-code', { email, code });
    const shapes = await Promise.all(
      [
        { email: 'nobody-here@oxshare.test', code: '123456' },
        { email, code: '123456' },
      ].map(async (body) => {
        const res = await post('/auth/verify-email-code', body);
        const answer = res.body as { code?: string; message?: string };
        return [res.status, answer.code, answer.message] as const;
      }),
    );
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[0][1]).toBe('EMAIL_CODE_INVALID');
  });

  it('refuses a code that is not six digits before it reaches anything', async () => {
    const res = await post('/auth/verify-email-code', { email: 'a@oxshare.test', code: '12a456' });
    expect(res.status).toBe(400);
  });
});

describe('a new code, and who gets one', () => {
  it('sends nothing inside the 30-second cooldown, and a new code after it — the old one then dead', async () => {
    const { email, code } = await register();
    const before = mail.sentTo(email).length;
    await post('/auth/resend-verification', { email });
    expect(mail.sentTo(email).length, 'a resend inside the cooldown mailed').toBe(before);

    await ctx.db.db
      .update(users)
      .set({ emailVerificationCodeSentAt: sql`now() - interval '31 seconds'` })
      .where(eq(users.email, email));
    await post('/auth/resend-verification', { email });
    const fresh = mail.latest('sendVerificationEmail', email)!.args[2] as string;
    expect(fresh).toMatch(/^\d{6}$/);

    if (fresh !== code) {
      const old = await post('/auth/verify-email-code', { email, code });
      expect(old.status, 'the superseded code still worked').toBe(400);
    }
    expect((await post('/auth/verify-email-code', { email, code: fresh })).status).toBe(200);
  });

  it('answers a resend for an unknown address the same, and mails nobody', async () => {
    const known = await register();
    const [unknown, real] = await Promise.all([
      post('/auth/resend-verification', { email: 'ghost@oxshare.test' }),
      post('/auth/resend-verification', { email: known.email }),
    ]);
    expect(unknown.body).toEqual(real.body);
    expect(mail.sentTo('ghost@oxshare.test')).toEqual([]);
  });

  it('mails an unconfirmed owner a fresh code when they sign in, and refuses the sign-in', async () => {
    const { email } = await register();
    await ctx.db.db
      .update(users)
      .set({ emailVerificationCodeSentAt: sql`now() - interval '31 seconds'` })
      .where(eq(users.email, email));
    const before = mail.sentTo(email).length;
    const res = await post('/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(mail.sentTo(email).length).toBe(before + 1);
    const code = mail.latest('sendVerificationEmail', email)!.args[2] as string;
    expect((await post('/auth/verify-email-code', { email, code })).status).toBe(200);
  });

  it('mails nothing for a WRONG password on an unconfirmed account', async () => {
    const { email } = await register();
    await ctx.db.db
      .update(users)
      .set({ emailVerificationCodeSentAt: sql`now() - interval '31 seconds'` })
      .where(eq(users.email, email));
    const before = mail.sentTo(email).length;
    const res = await post('/auth/login', { email, password: 'not-the-password-1' });
    expect(res.status).toBe(401);
    expect(mail.sentTo(email).length).toBe(before);
  });
});

describe('a code ends when the address or its verification changes', () => {
  it('dies when the link confirms the address first', async () => {
    const { email, code, token } = await register();
    expect((await post('/auth/verify-email', { token })).status).toBeLessThan(400);
    expect((await row(email)).emailVerificationCodeHash).toBeNull();
    expect((await post('/auth/verify-email-code', { email, code })).status).toBe(400);
  });

  it('dies when the address changes — a code mailed to the old one must not confirm the new', async () => {
    const { email, code } = await register();
    const store = ctx.app.get(UsersStore);
    const moved = `moved-${email}`;
    await store.update((await row(email)).id, { email: moved, emailVerified: false });
    expect((await row(moved)).emailVerificationCodeHash).toBeNull();
    expect((await post('/auth/verify-email-code', { email: moved, code })).status).toBe(400);
  });

  it('dies when the address is confirmed another way (a password reset)', async () => {
    const { email } = await register();
    const store = ctx.app.get(UsersStore);
    await store.update((await row(email)).id, { emailVerified: true });
    expect((await row(email)).emailVerificationCodeHash).toBeNull();
  });
});

describe('a suspended account', () => {
  it('is refused even with the right code, and says why only once the code was right', async () => {
    const { email, code } = await register();
    await ctx.db.db.update(users).set({ status: 'suspended' }).where(eq(users.email, email));
    const res = await post('/auth/verify-email-code', { email, code });
    expect(res.status).toBe(403);
    expect(parseSetCookies(res)).toEqual({});
    expect((await row(email)).emailVerified).toBe(false);
  });
});
