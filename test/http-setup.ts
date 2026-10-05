import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppModule } from '../src/app.module';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation.config';
import { applyApiPrefix, createHttpAdapter } from '../src/common/api-prefix';
import { CSRF_HEADER } from '../src/common/security/csrf.guard';
import { COOKIE_BASES } from '../src/common/security/session-cookies';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { totpCode, totpStepAt } from '../src/common/security/totp';

/**
 * An authenticated request, through the whole real stack.
 *
 * THE GAP THIS CLOSES. Guards were tested thoroughly but only ever in
 * isolation — `rbac.spec.ts` and `csrf.spec.ts` drive them with hand-built
 * `ExecutionContext` mocks, and `route-authorization.spec.ts` reads Nest
 * metadata to prove a guard is ATTACHED. Nothing proved the assembled chain
 * admits a legitimate request and refuses an illegitimate one. Parts that each
 * behave correctly can still be wired together wrongly, and the wiring is
 * exactly where the CSRF/`/v1` prefix bug landed (see `api-prefix.ts`: the
 * guard matched a literal `/admin`, the prefix moved the path, and every admin
 * write went through with no anti-forgery check at all).
 *
 * MIRRORS `main.ts`, importing the same option objects rather than copying
 * them. A harness that constructs its own pipe, or its own prefix, keeps
 * passing after someone weakens the real bootstrap — which is the failure mode
 * `VALIDATION_PIPE_OPTIONS` and `applyApiPrefix()` were both extracted to
 * prevent. Anything added to `main.ts` that affects request handling belongs
 * here too.
 *
 * Deliberately NOT mirrored: Swagger (documents nothing at runtime), the
 * uploads `mkdirSync` (suites that need it make their own), and `runSeeds()` —
 * a suite states the identities it needs rather than inheriting a fixture it
 * did not ask for.
 *
 * RATE LIMITING is neutralised by default, and that is the one deviation worth
 * arguing about. Login allows 5 attempts per minute PER IP; a suite proving the
 * guard chain signs in a dozen times from 127.0.0.1, so the limiter and the
 * suite are fundamentally incompatible — and a suite that fails on request six
 * is a suite that gets deleted.
 *
 * What is swapped is the COUNTER, not the guard: `ThrottlerGuard` still runs on
 * every request, still resolves its per-route limits, still builds its key. Only
 * the storage returns "one hit, never blocked". So a wiring mistake that stops
 * the guard executing at all is still visible here, and the limits themselves
 * are asserted for real in `test/throttling-http.spec.ts`, which opts in with
 * `{ throttling: 'real' }`.
 */
export interface HttpTestContext {
  app: INestApplication;
  server: Server;
  db: MoneyTestContext;
}

export interface HttpTestOptions {
  /** 'real' keeps the per-IP rate limiter in play. Default 'off' — see above. */
  throttling?: 'real' | 'off';
  /**
   * Providers to replace before `compile()`.
   *
   * For the routes that cross to a service we do not own — the MT5 bridge, the
   * Rival rail. A spec asserting the SHAPE of our own response needs the real
   * controller, service, DTO and interceptor to run; it does not need MT5 to be
   * reachable. Stubbing the far end keeps such a route testable instead of
   * skipped, and a skipped test reports as passing.
   */
  overrides?: { token: unknown; value: unknown }[];
}

export async function startHttpTestApp(options: HttpTestOptions = {}): Promise<HttpTestContext> {
  process.env['NODE_ENV'] ??= 'test';

  // Must precede AppModule: the stores resolve DATABASE_URL through a lazy
  // singleton on first use, and Nest instantiates providers during compile().
  const db = await startMoneyTestDb();

  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.throttling !== 'real') {
    builder.overrideProvider(ThrottlerStorage).useValue({
      increment: (): Promise<ThrottlerStorageRecord> =>
        Promise.resolve({
          totalHits: 1,
          timeToExpire: 60,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
    });
  }
  for (const { token, value } of options.overrides ?? []) {
    builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  // Same adapter as main.ts — the case-sensitive-routing setting is a security
  // control (common/api-prefix.ts), and a harness serving requests through a
  // differently-configured router would prove nothing about the real one.
  // `rawBody: true` for the same mirroring reason: signed webhooks verify an
  // HMAC over the exact bytes received, and a harness without it hands every
  // webhook spec an undefined body — making "signature mismatch" untestable
  // and, worse, testable wrongly.
  const app = moduleRef.createNestApplication<NestExpressApplication>(createHttpAdapter(), {
    rawBody: true,
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  applyApiPrefix(app);

  await app.init();

  return { app, server: app.getHttpServer(), db };
}

export async function stopHttpTestApp(ctx: HttpTestContext | undefined): Promise<void> {
  await ctx?.app?.close();
  if (ctx?.db) await stopMoneyTestDb(ctx.db);
}

/**
 * The two surfaces, which are separate sessions by design (R-3.1).
 *
 * Naming them keeps a spec from asserting against the wrong cookie and passing
 * for the wrong reason — the failure this harness exists to catch.
 */
export const SURFACES = {
  admin: {
    loginPath: '/v1/admin/auth/login',
    accessCookie: COOKIE_BASES.adminAccess,
    refreshCookie: COOKIE_BASES.adminRefresh,
    csrfCookie: COOKIE_BASES.adminCsrf,
    origin: process.env['ADMIN_URL'] ?? 'http://localhost:3002',
  },
  portal: {
    loginPath: '/v1/auth/login',
    accessCookie: COOKIE_BASES.clientAccess,
    refreshCookie: COOKIE_BASES.clientRefresh,
    csrfCookie: COOKIE_BASES.portalCsrf,
    origin: process.env['PORTAL_URL'] ?? 'http://localhost:3000',
  },
} as const;

export type SurfaceName = keyof typeof SURFACES;

/** Cookie name → value, parsed from a response's Set-Cookie headers. */
export function parseSetCookies(res: request.Response): Record<string, string> {
  const raw: unknown = res.headers['set-cookie'];
  const headers: string[] = Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === 'string'
      ? [raw]
      : [];
  const jar: Record<string, string> = {};
  for (const header of headers) {
    const [pair] = header.split(';');
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    // A cleared cookie comes back with an empty value; record it as absent so a
    // spec can assert "logout removed this" without special-casing the shape.
    if (value !== '') jar[name] = value;
    else delete jar[name];
  }
  return jar;
}

/**
 * A signed-in caller: cookies plus the anti-forgery token, attached the way a
 * browser and the frontends actually attach them.
 *
 * `get`/`post`/`patch`/`put`/`del` send the session cookies. State-changing
 * verbs also send the `Origin` header and echo the CSRF cookie into
 * `X-OxShare-CSRF` — the double-submit the guard checks. Every part is
 * overridable so a spec can prove the guard refuses a request missing one.
 */
export interface Session {
  cookies: Record<string, string>;
  csrfToken: string | undefined;
  cookieHeader(): string;
  get(path: string): request.Test;
  post(path: string, body?: unknown, opts?: RequestOptions): request.Test;
  patch(path: string, body?: unknown, opts?: RequestOptions): request.Test;
  put(path: string, body?: unknown, opts?: RequestOptions): request.Test;
  del(path: string, opts?: RequestOptions): request.Test;
}

export interface RequestOptions {
  /** Omit the CSRF header, to prove the guard refuses the request. */
  omitCsrf?: boolean;
  /** Send a different CSRF token — a forged or stale one. */
  csrfToken?: string;
  /** Send a different Origin, or none at all with `null`. */
  origin?: string | null;
  /**
   * Extra headers. `idempotency-key` is the one that matters: the money
   * routes declare `@Idempotent()` and refuse 400 without it, so a test that
   * drives approve/reject/settle has to send one.
   */
  headers?: Record<string, string>;
}

function buildSession(
  server: Server,
  surface: (typeof SURFACES)[SurfaceName],
  cookies: Record<string, string>,
): Session {
  const cookieHeader = () =>
    Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');

  const csrfToken = cookies[surface.csrfCookie];

  const mutate = (test: request.Test, body: unknown, opts: RequestOptions = {}) => {
    test.set('Cookie', cookieHeader());
    if (opts.origin !== null) test.set('Origin', opts.origin ?? surface.origin);
    const token = opts.csrfToken ?? csrfToken;
    if (!opts.omitCsrf && token !== undefined) test.set(CSRF_HEADER, token);
    for (const [name, value] of Object.entries(opts.headers ?? {})) test.set(name, value);
    if (body !== undefined) test.send(body as object);
    return test;
  };

  return {
    cookies,
    csrfToken,
    cookieHeader,
    get: (path) => request(server).get(path).set('Cookie', cookieHeader()),
    post: (path, body, opts) => mutate(request(server).post(path), body, opts),
    patch: (path, body, opts) => mutate(request(server).patch(path), body, opts),
    put: (path, body, opts) => mutate(request(server).put(path), body, opts),
    del: (path, opts) => mutate(request(server).delete(path), undefined, opts),
  };
}

/**
 * Log in over HTTP and return a Session carrying whatever the server set.
 *
 * Credentials go through the real login route, so a spec cannot accidentally
 * mint itself a token the application would never have issued — the reason
 * these tests are worth more than the guard unit tests they sit beside.
 */
/**
 * What these specs look like from the server's side.
 *
 * Recognisable on purpose: a `user_agent` column full of this string in a real
 * database means seed or test traffic reached it.
 */
export const TEST_USER_AGENT = 'oxshare-e2e-suite/1.0 (supertest)';

export async function actingAs(
  ctx: HttpTestContext,
  surfaceName: SurfaceName,
  credentials: { email: string; password: string },
): Promise<Session> {
  const surface = SURFACES[surfaceName];
  const res = await request(ctx.server)
    .post(surface.loginPath)
    .set('Origin', surface.origin)
    /*
     * A browser always sends one; supertest never does.
     *
     * The session list stores whatever the login request carried, so with no
     * header there is nothing to store and `user_agent` is honestly null — which
     * made "captures what the request looked like" fail against a feature that
     * works. The gap was in the harness, not the code: every session these specs
     * create was unlike every session a real client creates.
     *
     * Set here rather than per spec because it is a property of being a client
     * at all, and the next spec to assert on device fingerprints should not have
     * to rediscover this.
     */
    .set('User-Agent', TEST_USER_AGENT)
    .send(credentials);

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `actingAs(${surfaceName}) failed to log in as ${credentials.email}: ` +
        `${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  if (surfaceName === 'admin') {
    return buildSession(
      ctx.server,
      surface,
      await completeAdminTotp(ctx, credentials.email, res.body as { challengeToken: string }),
    );
  }

  return buildSession(ctx.server, surface, parseSetCookies(res));
}

/**
 * The admin sign-in's second half (0191): every admin session is password AND
 * authenticator code, so the harness does both through the real routes.
 *
 * The admin's authenticator is FORGOTTEN first and enrolled afresh: a code is
 * single-use per 30-second step, and a spec signing the same admin in twice
 * inside one step would otherwise be refused as a replay — correctly. Specs
 * about the authenticator itself (admin-totp-http.spec.ts) drive the routes by
 * hand instead of through this.
 */
export async function completeAdminTotp(
  ctx: HttpTestContext,
  email: string,
  challenge: { challengeToken: string },
): Promise<Record<string, string>> {
  await ctx.db.pool.query(
    `UPDATE admins SET totp_secret = NULL, totp_pending_secret = NULL,
       totp_enabled_at = NULL, totp_last_step = NULL WHERE email = $1`,
    [email.toLowerCase()],
  );
  const origin = SURFACES.admin.origin;
  const setup = await request(ctx.server)
    .post('/v1/admin/auth/totp/setup')
    .set('Origin', origin)
    .send({ challengeToken: challenge.challengeToken });
  if (setup.status !== 200) {
    throw new Error(
      `authenticator setup failed for ${email}: ${setup.status} ${JSON.stringify(setup.body)}`,
    );
  }
  const { secret } = setup.body as { secret: string };
  const verify = await request(ctx.server)
    .post('/v1/admin/auth/totp/verify')
    .set('Origin', origin)
    .set('User-Agent', TEST_USER_AGENT)
    .send({
      challengeToken: challenge.challengeToken,
      code: totpCode(secret, totpStepAt(new Date())),
    });
  if (verify.status !== 200) {
    throw new Error(
      `authenticator code refused for ${email}: ${verify.status} ${JSON.stringify(verify.body)}`,
    );
  }
  return parseSetCookies(verify);
}

/** A Session built from cookies you already hold — for asserting on rotation. */
export function sessionFrom(
  ctx: HttpTestContext,
  surfaceName: SurfaceName,
  cookies: Record<string, string>,
): Session {
  return buildSession(ctx.server, SURFACES[surfaceName], cookies);
}

/** An unauthenticated caller, for the "no cookie" half of every assertion. */
export function anonymous(ctx: HttpTestContext) {
  return request(ctx.server);
}
