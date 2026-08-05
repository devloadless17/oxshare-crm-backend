import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { AdminMoneyController } from '../src/modules/admin/admin-money.controller';
import { IDEMPOTENT_KEY } from '../src/common/security/idempotency.interceptor';
import { EmailVerifiedGuard } from '../src/modules/identity/guards/email-verified.guard';
import { EmailNotVerifiedError } from '../src/common/errors/domain-errors';
import { validateEnv } from '../src/config/env.validation';

/**
 * The three cross-repo gaps closed on 5 August, pinned at the backend end.
 *
 * Each was a Group C item in the audit — real, but needing a decision because
 * the fix spans repos or changes a user-facing flow. They share a shape worth
 * naming: in every one the backend and a frontend were each individually
 * defensible and wrong together.
 */

/** The committed contract — what the server actually serves. */
const contract = () =>
  JSON.parse(readFileSync('openapi.json', 'utf8')) as {
    paths: Record<string, Record<string, { requestBody?: unknown; parameters?: unknown[] }>>;
    components: { schemas: Record<string, { properties: Record<string, unknown> }> };
  };

describe('R-3.9 — no state change behind GET', () => {
  /*
   * Asserted against the DOCUMENT rather than the decorator, deliberately.
   *
   * The decorator is what a reader checks; the document is what the frontends
   * generate from and what an attacker meets. Reading the served contract also
   * makes this test fail if the route is reachable under a second prefix that
   * still uses GET — `identity/` aliases every `auth/` handler, and a fix
   * applied to one spelling is exactly the kind of thing a decorator-level test
   * would miss.
   */
  it('serves email verification as POST under every prefix', () => {
    // A GET marked the address verified, cleared the token and moved the
    // verification level. The threat is not a browser: corporate mail gateways
    // and link scanners fetch every URL in an inbound message, and a preview
    // pane prefetches. Any of those silently verified the address — the one
    // thing the email exists to prove.
    const paths = contract().paths;
    for (const route of ['/v1/auth/verify-email', '/v1/identity/verify-email']) {
      expect(paths[route]).toBeDefined();
      expect(paths[route]['post']).toBeDefined();
      expect(paths[route]['get']).toBeUndefined();
    }
  });

  it('takes the token in a body, not a query string', () => {
    // A token in the query string also lands in access logs, Referer headers and
    // browser history. redact.ts strips it from ours; it cannot strip it from a
    // proxy's.
    const post = contract().paths['/v1/auth/verify-email']['post'];
    expect(post.requestBody).toBeDefined();
    expect(post.parameters ?? []).toHaveLength(0);
  });
});

describe('R-2.2 — the error envelope is machine-readable', () => {
  it('gives an unverified email its own code, not a generic FORBIDDEN', () => {
    /*
     * The portal decided whether to offer "resend verification" by matching the
     * ENGLISH TEXT of the message: `.includes('verify your email')`. That breaks
     * when the wording changes, and again on the day Arabic ships — which FSD
     * §10 and D-16 require. A client should never read prose to make a decision.
     */
    const guard = new EmailVerifiedGuard();
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user: { emailVerified: false } }) }),
    } as never;

    expect(() => guard.canActivate(ctx)).toThrow(EmailNotVerifiedError);
    try {
      guard.canActivate(ctx);
    } catch (error) {
      expect((error as EmailNotVerifiedError).code).toBe('EMAIL_NOT_VERIFIED');
    }
  });

  it('lets a verified user through', () => {
    const guard = new EmailVerifiedGuard();
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user: { emailVerified: true } }) }),
    } as never;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('publishes the envelope as a schema the frontends can generate from', () => {
    // AllExceptionsFilter is not a route handler, so nothing put this shape in
    // the document and both frontends hand-wrote their own picture of it. A
    // renamed field would have compiled clean in both and degraded every error
    // to a fallback string.
    const schema = contract().components.schemas['ErrorResponseDto'];

    expect(schema).toBeDefined();
    for (const field of ['statusCode', 'code', 'message', 'requestId', 'timestamp', 'path']) {
      expect(schema.properties[field]).toBeDefined();
    }
  });
});

describe('R-5.2 — the admin money routes require an idempotency key', () => {
  // Nothing was broken: the backend declared none and the admin app sent none,
  // consistently. But a double-clicked "Mark Paid" had no request-level dedupe
  // on either side — the `WHERE state = ?` rowcount guards catch a replayed
  // CAUSE, not a replayed REQUEST.
  it.each(['approveWithdrawal', 'rejectWithdrawal', 'settleWithdrawal'])('%s', (method) => {
    const handler = (AdminMoneyController.prototype as unknown as Record<string, unknown>)[method];
    expect(typeof handler).toBe('function');
    expect(Reflect.getMetadata(IDEMPOTENT_KEY, handler as object)).toBe(true);
  });
});

describe('§12.4 — the money bounds are validated at boot', () => {
  // Four DISTINCT secrets: validateEnv refuses a config that reuses one, and it
  // is right to — identical keys silently merge two auth surfaces.
  const base = {
    ADMIN_JWT_SECRET: `admin-access-${'x'.repeat(24)}`,
    ADMIN_JWT_REFRESH_SECRET: `admin-refresh-${'x'.repeat(24)}`,
    JWT_ACCESS_SECRET: `portal-access-${'x'.repeat(24)}`,
    JWT_REFRESH_SECRET: `portal-refresh-${'x'.repeat(24)}`,
  };

  it('accepts the documented defaults being absent', () => {
    // Every bound is optional; money-limits.ts supplies a documented default.
    expect(() => validateEnv({ ...base })).not.toThrow();
  });

  it('REFUSES to start on a malformed limit', () => {
    // The failure this closes: money-limits.ts falls back to its default when a
    // value will not parse, which is the safe reading at runtime but means a
    // typo silently becomes a number nobody chose — on the ceilings that exist
    // for when the commercial rules are wrong.
    expect(() => validateEnv({ ...base, WITHDRAWAL_MAX: '50,000' })).toThrow(/WITHDRAWAL_MAX/);
    expect(() => validateEnv({ ...base, COMMISSION_MAX_PER_DEAL: '$1000' })).toThrow(
      /COMMISSION_MAX_PER_DEAL/,
    );
  });

  it('REFUSES a negative or zero limit', () => {
    expect(() => validateEnv({ ...base, WITHDRAWAL_MIN: '-5' })).toThrow(/WITHDRAWAL_MIN/);
    expect(() => validateEnv({ ...base, WITHDRAWAL_MAX: '0' })).toThrow(/WITHDRAWAL_MAX/);
  });

  it('REFUSES bounds that are individually valid and collectively nonsense', () => {
    // Each of these parses. Together they refuse every withdrawal, and the
    // error a client would see says nothing about why.
    expect(() => validateEnv({ ...base, WITHDRAWAL_MIN: '100', WITHDRAWAL_MAX: '50' })).toThrow(
      /WITHDRAWAL_MIN/,
    );
    expect(() =>
      validateEnv({ ...base, WITHDRAWAL_MAX: '50000', WITHDRAWAL_DAILY_MAX: '1000' }),
    ).toThrow(/WITHDRAWAL_DAILY_MAX/);
  });

  it('accepts a well-formed override', () => {
    expect(() =>
      validateEnv({
        ...base,
        WITHDRAWAL_MIN: '10',
        WITHDRAWAL_MAX: '50000',
        WITHDRAWAL_DAILY_MAX: '100000',
        COMMISSION_MAX_SHARE_OF_DEAL: '0.5',
      }),
    ).not.toThrow();
  });
});
