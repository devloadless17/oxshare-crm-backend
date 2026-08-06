import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { AppModule } from '../src/app.module';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation.config';

/**
 * Request validation, at the transport edge.
 *
 * Two things are pinned here, and neither was covered before:
 *
 *  1. `forbidNonWhitelisted`. With `whitelist` alone an unexpected property was
 *     silently stripped and the request SUCCEEDED, so a caller sending a typo'd key
 *     got a 200 and a half-applied change. On a money system, "the caller and the
 *     contract disagree" has to be an error.
 *  2. That every DTO actually reflects. The global pipe can only validate a body it
 *     can reflect a class off, so a `@Body()` typed as an inline object literal is
 *     validated by nothing at all — which is how `POST /kyc/step` accepted `{}` and
 *     reached the service with `data` undefined.
 *
 * These run without a database: the routes below reject at the pipe, before any
 * handler or repository is reached. Auth guards are not in play either — a 400 from
 * the pipe precedes them for these payloads, and where a guard does answer first
 * the assertion below allows for it explicitly.
 */

let app: INestApplication;
// app.getHttpServer() is typed `any`, so narrow it once here rather than taking an
// unsafe argument at every call site below.
let db: MoneyTestContext | undefined;
let server: Server;

beforeAll(async () => {
  process.env['NODE_ENV'] ??= 'test';
  /*
   * A REAL database, started before AppModule is built.
   *
   * This spec is about the ValidationPipe, so it looks like it should need no
   * database — but it boots the whole `AppModule`, and the assembled guard chain
   * queries one: `IpAllowlistGuard` reads `admin_ip_allowlist` on every admin
   * request. With nothing to connect to, that query throws and the guard answers
   * 500, so assertions expecting 400 or 401 fail for a reason unrelated to what
   * they test.
   *
   * It passed locally because a developer machine has Postgres running from
   * `docker compose up` and the store falls back to the default connection. CI
   * has no such thing — only the suites that start Testcontainers get a
   * database — so this spec has been failing there and passing everywhere else,
   * which is the worst combination.
   *
   * Must precede the module build: the stores resolve DATABASE_URL through a
   * lazy singleton, so anything constructed before this points at the wrong
   * place. `http-setup.ts` does the same thing for the same reason.
   */
  db = await startMoneyTestDb();

  /*
   * The rate limiter is NEUTRALISED here, and it did not used to need to be.
   *
   * Throttle counters moved from an in-memory Map to REDIS (R-3.5), so that "5
   * login attempts per minute" survives a deploy and holds across replicas
   * rather than being per-process. The same durability means the counters now
   * survive between TEST RUNS: `/auth/register` is capped at 10 per hour per IP,
   * and every suite runs from 127.0.0.1, so after a few `npm test` invocations
   * these cases started answering 429 instead of the 400 they assert.
   *
   * That is the limiter working, not a bug — but it makes an assertion about the
   * ValidationPipe depend on how many times somebody has run the suite today.
   * `http-setup.ts` has swapped the storage for exactly this reason since it was
   * written; this spec builds its own app and had no equivalent.
   *
   * What is replaced is the COUNTER, not the guard: `ThrottlerGuard` still runs,
   * still resolves per-route limits, still builds its key. The limits themselves
   * are asserted for real in `credential-route-throttling.spec.ts`.
   */
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ThrottlerStorage)
    .useValue({
      increment: (): Promise<ThrottlerStorageRecord> =>
        Promise.resolve({
          totalHits: 1,
          timeToExpire: 60,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
    })
    .compile();
  app = moduleRef.createNestApplication();
  // The SAME options object main.ts uses — not a copy. Constructing a pipe here
  // with its own settings would mean this spec kept passing after someone turned
  // forbidNonWhitelisted off in production code.
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  await app.init();
  server = app.getHttpServer() as Server;
}, 180_000);

afterAll(async () => {
  await app?.close();
  if (db) await stopMoneyTestDb(db);
});

/*
 * Every POST below goes through this, because Origin is now checked on EVERY
 * state change — not only on ones carrying a session cookie (csrf.guard.ts).
 *
 * That closed login CSRF: `/admin/auth/login` and `/auth/register` have no
 * cookie yet by definition, so the guard used to return before it ever looked
 * at where the request came from. The consequence for this spec is that a POST
 * with no Origin is now refused with 403 BEFORE the ValidationPipe sees the
 * body — guards run ahead of pipes — so a request without one would assert
 * against the wrong rejection entirely.
 *
 * Either configured origin is accepted for any route (the allowlist is the pair),
 * but each call uses the one a real browser would send.
 */
const ADMIN_ORIGIN = process.env['ADMIN_URL'] ?? 'http://localhost:3002';
const PORTAL_ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';

const post = (path: string) =>
  request(server)
    .post(path)
    .set('Origin', path.startsWith('/admin') ? ADMIN_ORIGIN : PORTAL_ORIGIN);

/** The pipe answers before the guard for these bodies; 401/403 means the guard won. */
const REJECTED = [400, 401, 403];

describe('global ValidationPipe — unknown properties', () => {
  it('rejects an unknown property instead of silently dropping it', async () => {
    const res = await post('/admin/auth/login').send({
      email: 'admin@oxshare.com',
      password: 'admin123',
      isAdmin: true,
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/should not exist/i);
  });

  it('names the offending property, so the caller can fix it', async () => {
    const res = await post('/admin/auth/login').send({
      email: 'a@b.com',
      password: 'x',
      passwrod: 'typo',
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/passwrod/);
  });
});

describe('global ValidationPipe — required and typed fields', () => {
  it('rejects a login with no body', async () => {
    const res = await post('/admin/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('rejects a non-email in an @IsEmail field', async () => {
    const res = await post('/admin/auth/login').send({ email: 'not-an-email', password: 'x' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/email/i);
  });

  it('rejects a KYC step with no data — this used to reach the service as undefined', async () => {
    const res = await post('/kyc/step').send({ step: 'personal' });

    expect(REJECTED).toContain(res.status);
    if (res.status === 400) {
      expect(JSON.stringify(res.body)).toMatch(/data/i);
    }
  });
});

describe('error envelope', () => {
  it('answers a validation failure in the standard shape', async () => {
    const res = await post('/admin/auth/login').send({});

    // AllExceptionsFilter is the single mapping point, and every consumer reads
    // `message` through apiErrorMessage.
    expect(res.body).toMatchObject({
      statusCode: 400,
      path: '/admin/auth/login',
    });
    expect(res.body).toHaveProperty('requestId');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('message');
  });
});

describe('R-2.2 the error envelope carries a field map', () => {
  /*
   * class-validator's default output is `message: string[]` — e.g.
   * `["amount must be a number string"]`. A form cannot map that back to an
   * input without string-matching English, which breaks the moment a validator
   * is reworded and cannot work at all once the UI is translated (Rev 8 §10
   * lists RTL Arabic as a requirement).
   *
   * These assert the structure, not the prose.
   */
  it('names the field that failed, not just what went wrong', async () => {
    const res = await post('/auth/register').send({ email: 'not-an-email', password: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.fields).toBeDefined();
    expect(Object.keys(res.body.fields)).toContain('email');
  });

  it('keeps the sentence list, so nothing reading it today breaks', async () => {
    const res = await post('/auth/register').send({ email: 'not-an-email', password: 'x' });

    expect(Array.isArray(res.body.message)).toBe(true);
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it('gives one message per field, which is what a form renders', async () => {
    const res = await post('/auth/register').send({ email: 'not-an-email', password: 'x' });

    for (const value of Object.values(res.body.fields as Record<string, unknown>)) {
      expect(typeof value).toBe('string');
    }
  });

  it('never answers with a humanized status name as the machine code', async () => {
    // The old fallback was `body.error`, which for a 400 is the literal string
    // "Bad Request" — prose that changes when Nest changes, and that cannot
    // distinguish two different 400s from each other.
    const res = await post('/auth/register').send({});

    expect(res.body.code).not.toBe('Bad Request');
    expect(res.body.code).toMatch(/^[A-Z_]+$/);
  });

  it('omits `fields` entirely when the failure is not a validation failure', async () => {
    // A consumer checking `if (body.fields)` must not also have to check for an
    // empty object.
    const res = await request(server).get('/admin/clients');

    expect(res.status).toBe(401);
    expect(res.body.fields).toBeUndefined();
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });
});
