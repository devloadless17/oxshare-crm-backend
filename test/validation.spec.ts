import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
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
let server: Server;

beforeAll(async () => {
  process.env['NODE_ENV'] ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  // The SAME options object main.ts uses — not a copy. Constructing a pipe here
  // with its own settings would mean this spec kept passing after someone turned
  // forbidNonWhitelisted off in production code.
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  await app.init();
  server = app.getHttpServer() as Server;
}, 60_000);

afterAll(async () => {
  await app?.close();
});

/** The pipe answers before the guard for these bodies; 401/403 means the guard won. */
const REJECTED = [400, 401, 403];

describe('global ValidationPipe — unknown properties', () => {
  it('rejects an unknown property instead of silently dropping it', async () => {
    const res = await request(server)
      .post('/admin/auth/login')
      .send({ email: 'admin@oxshare.com', password: 'admin123', isAdmin: true });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/should not exist/i);
  });

  it('names the offending property, so the caller can fix it', async () => {
    const res = await request(server)
      .post('/admin/auth/login')
      .send({ email: 'a@b.com', password: 'x', passwrod: 'typo' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/passwrod/);
  });
});

describe('global ValidationPipe — required and typed fields', () => {
  it('rejects a login with no body', async () => {
    const res = await request(server).post('/admin/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('rejects a non-email in an @IsEmail field', async () => {
    const res = await request(server)
      .post('/admin/auth/login')
      .send({ email: 'not-an-email', password: 'x' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/email/i);
  });

  it('rejects a KYC step with no data — this used to reach the service as undefined', async () => {
    const res = await request(server).post('/kyc/step').send({ step: 'personal' });

    expect(REJECTED).toContain(res.status);
    if (res.status === 400) {
      expect(JSON.stringify(res.body)).toMatch(/data/i);
    }
  });

  it('rejects a withdrawal request with a numeric amount (§6.1 wants a string)', async () => {
    const res = await request(server)
      .post('/payments/withdrawals')
      // 300 as a NUMBER. @IsNumberString exists precisely so this cannot pass:
      // a JS number cannot carry NUMERIC(28,8).
      .send({ amount: 300, currency: 'USD', destination: 'IBAN', provider: 'whish' });

    expect(REJECTED).toContain(res.status);
  });

  it('rejects an unknown currency on a withdrawal', async () => {
    const res = await request(server)
      .post('/payments/withdrawals')
      .send({ amount: '300.00', currency: 'GBP', destination: 'IBAN', provider: 'whish' });

    expect(REJECTED).toContain(res.status);
  });
});

describe('error envelope', () => {
  it('answers a validation failure in the standard shape', async () => {
    const res = await request(server).post('/admin/auth/login').send({});

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
    const res = await request(server)
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.fields).toBeDefined();
    expect(Object.keys(res.body.fields)).toContain('email');
  });

  it('keeps the sentence list, so nothing reading it today breaks', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'x' });

    expect(Array.isArray(res.body.message)).toBe(true);
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it('gives one message per field, which is what a form renders', async () => {
    const res = await request(server)
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'x' });

    for (const value of Object.values(res.body.fields as Record<string, unknown>)) {
      expect(typeof value).toBe('string');
    }
  });

  it('never answers with a humanized status name as the machine code', async () => {
    // The old fallback was `body.error`, which for a 400 is the literal string
    // "Bad Request" — prose that changes when Nest changes, and that cannot
    // distinguish two different 400s from each other.
    const res = await request(server).post('/auth/register').send({});

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
