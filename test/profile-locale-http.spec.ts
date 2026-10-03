import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  anonymous,
  parseSetCookies,
  sessionFrom,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { emailRecorder } from './email-recorder';
import { EmailService } from '../src/modules/email/email.service';
import { users } from '../src/database/schema';
import { SIGN_UP_DETAILS } from './support/registration';

/**
 * THE CLIENT'S LANGUAGE IS STORED, so mail written while they are away can use it.
 *
 * Three doors: registration stores the language the portal was in
 * (`X-OxShare-Locale`), `PUT /profile/locale` changes it, and `GET /auth/me`
 * reports it. Mail sent while serving the client's own request (the sign-up
 * code, a password reset) follows the REQUEST, which may be anonymous.
 */

const PORTAL_ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';
const PASSWORD = 'AGoodPassword123!';
const LOCALE_HEADER = 'X-OxShare-Locale';

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

const post = (path: string, body: object, locale?: string) => {
  const test = anonymous(ctx).post(`/v1${path}`).set('Origin', PORTAL_ORIGIN);
  if (locale) test.set(LOCALE_HEADER, locale);
  return test.send(body);
};

const stored = async (email: string) =>
  (await ctx.db.db.select({ locale: users.locale }).from(users).where(eq(users.email, email)))[0]
    ?.locale;

/** Register (in `locale`, if given), confirm with the mailed code, and hold the session. */
async function signUp(locale?: string): Promise<{ email: string; session: Session }> {
  const email = `locale-${Date.now()}-${n++}@oxshare.test`;
  const res = await post(
    '/auth/register',
    { firstName: 'Lina', lastName: 'Haddad', email, password: PASSWORD, ...SIGN_UP_DETAILS },
    locale,
  );
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const sent = mail.latest('sendVerificationEmail', email)!;
  const code = sent.args[2] as string;
  const verified = await post('/auth/verify-email-code', { email, code });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return { email, session: sessionFrom(ctx, 'portal', parseSetCookies(verified)) };
}

describe('registration stores the language the portal was in', () => {
  it('stores Arabic, and writes the sign-up code mail in Arabic', async () => {
    const { email, session } = await signUp('ar');
    expect(await stored(email)).toBe('ar');
    expect(mail.latest('sendVerificationEmail', email)!.args[3]).toBe('ar');

    const me = await session.get('/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.locale).toBe('ar');
  });

  it('stores English when the portal sends no language', async () => {
    const { email, session } = await signUp();
    expect(await stored(email)).toBe('en');
    expect(mail.latest('sendVerificationEmail', email)!.args[3]).toBe('en');
    expect((await session.get('/v1/auth/me')).body.locale).toBe('en');
  });
});

describe('PUT /profile/locale', () => {
  it('stores the choice, answers 204, and /auth/me reports it', async () => {
    const { email, session } = await signUp();
    const res = await session.put('/v1/profile/locale', { locale: 'ar' });
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(await stored(email)).toBe('ar');
    expect((await session.get('/v1/auth/me')).body.locale).toBe('ar');

    expect((await session.put('/v1/profile/locale', { locale: 'en' })).status).toBe(204);
    expect(await stored(email)).toBe('en');
  });

  it('refuses a language the portal does not offer, and changes nothing', async () => {
    const { email, session } = await signUp('ar');
    for (const body of [{ locale: 'fr' }, { locale: 'AR' }, {}, { locale: 1 }]) {
      const res = await session.put('/v1/profile/locale', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await stored(email)).toBe('ar');
  });

  it('refuses a caller with no session', async () => {
    const res = await anonymous(ctx)
      .put('/v1/profile/locale')
      .set('Origin', PORTAL_ORIGIN)
      .send({ locale: 'ar' });
    expect(res.status).toBe(401);
  });

  it('refuses a write without the anti-forgery token', async () => {
    const { email, session } = await signUp();
    const res = await session.put('/v1/profile/locale', { locale: 'ar' }, { omitCsrf: true });
    expect(res.status).toBe(403);
    expect(await stored(email)).toBe('en');
  });
});

describe("a password reset follows the REQUEST's language", () => {
  it('mails Arabic to an anonymous visitor reading the portal in Arabic', async () => {
    const { email } = await signUp();
    const res = await post('/auth/forgot-password', { email }, 'ar');
    expect(res.status).toBeLessThan(300);
    expect(mail.latest('sendPasswordResetEmail', email)!.args[2]).toBe('ar');
  });
});
