import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Mt5WebhookController } from '../src/modules/trading/mt5-webhook.controller';

/**
 * Replay protection on the deal feed — R-5.3.
 *
 * The endpoint mints commission: a deal it accepts becomes an accrual, matures,
 * confirms and pays, with no clawback in Phase 1. It had no test at all.
 *
 * The timestamp used to be optional at the CALLER's discretion — omit the
 * header and the signature was computed over the body alone, so a captured
 * push replayed forever. That was harmless for deals only because ingest is
 * idempotent on `mt5_ticket`, which is a property of the downstream handler
 * rather than of this endpoint. The Whish and USDT callbacks will arrive at
 * code with no such guarantee, and they are meant to inherit this check rather
 * than re-derive it.
 *
 * A control the attacker can switch off by omitting a header is not a control.
 */

const SECRET = 'bridge-secret-for-tests-only';

function sign(timestamp: string, body: string): string {
  return createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
}

/** A request as the controller reads it: raw body, headers, nothing else. */
function push(headers: Record<string, string | undefined>, body: string): Request {
  return {
    rawBody: Buffer.from(body, 'utf8'),
    header: (name: string) => headers[name],
  } as unknown as Request;
}

const config = { get: (_k: string, _d?: string) => SECRET } as unknown as ConfigService;

let controller: Mt5WebhookController;
const BODY = JSON.stringify({ deals: [{ mt5Ticket: 'T-1' }] });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
  controller = new Mt5WebhookController(config, {} as never);
});

afterEach(() => vi.useRealTimers());

/** The private verifier, reached the way the route reaches it. */
const verify = (req: Request) =>
  (controller as unknown as { assertAuthentic(r: Request): void }).assertAuthentic(req);

describe('R-5.3 the deal feed verifies before it parses', () => {
  const now = '2026-08-05T12:00:00.000Z';

  it('accepts a correctly signed, freshly timestamped push', () => {
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': now,
        'X-Bridge-Signature': sign(now, BODY),
      },
      BODY,
    );
    expect(() => verify(req)).not.toThrow();
  });

  it('REFUSES a push with no timestamp', () => {
    // The regression. Previously this verified against the body alone and
    // passed, so a captured push replayed indefinitely.
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Signature': createHmac('sha256', SECRET).update(BODY).digest('hex'),
      },
      BODY,
    );
    expect(() => verify(req)).toThrow(UnauthorizedException);
  });

  it('refuses a captured push replayed after the window', () => {
    const old = '2026-08-05T11:50:00.000Z'; // ten minutes stale
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': old,
        'X-Bridge-Signature': sign(old, BODY),
      },
      BODY,
    );
    expect(() => verify(req)).toThrow(/replay window/);
  });

  it('refuses a future timestamp as readily as a stale one', () => {
    const ahead = '2026-08-05T12:10:00.000Z';
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': ahead,
        'X-Bridge-Signature': sign(ahead, BODY),
      },
      BODY,
    );
    expect(() => verify(req)).toThrow(/replay window/);
  });

  it('tolerates modest clock skew against the Windows bridge host', () => {
    // A window tight enough to reject normal skew would be disabled the first
    // time it rejected a real push (§12.5).
    const skewed = '2026-08-05T12:01:30.000Z';
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': skewed,
        'X-Bridge-Signature': sign(skewed, BODY),
      },
      BODY,
    );
    expect(() => verify(req)).not.toThrow();
  });

  it('will not let an old signature be reused under a fresh timestamp', () => {
    // Why the timestamp is INSIDE the signed payload rather than beside it.
    const captured = sign('2026-08-05T11:50:00.000Z', BODY);
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': now,
        'X-Bridge-Signature': captured,
      },
      BODY,
    );
    expect(() => verify(req)).toThrow(UnauthorizedException);
  });

  it('refuses a body altered after signing', () => {
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': now,
        'X-Bridge-Signature': sign(now, BODY),
      },
      JSON.stringify({ deals: [{ mt5Ticket: 'T-1', volume: '999999' }] }),
    );
    expect(() => verify(req)).toThrow(UnauthorizedException);
  });

  it('refuses a malformed timestamp rather than treating it as now', () => {
    const bad = 'yesterday';
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': bad,
        'X-Bridge-Signature': sign(bad, BODY),
      },
      BODY,
    );
    expect(() => verify(req)).toThrow(/ISO-8601/);
  });

  it('refuses a wrong bridge token before looking at anything else', () => {
    const req = push(
      {
        'X-Bridge-Token': 'not-the-secret',
        'X-Bridge-Timestamp': now,
        'X-Bridge-Signature': sign(now, BODY),
      },
      BODY,
    );
    expect(() => verify(req)).toThrow(UnauthorizedException);
  });

  it('refuses every push when no secret is configured', () => {
    // An unauthenticated deal feed can mint commission out of thin air, so a
    // missing secret must fail closed rather than open.
    const unconfigured = new Mt5WebhookController(
      { get: () => '' } as unknown as ConfigService,
      {} as never,
    );
    const req = push({ 'X-Bridge-Token': SECRET, 'X-Bridge-Timestamp': now }, BODY);
    expect(() =>
      (unconfigured as unknown as { assertAuthentic(r: Request): void }).assertAuthentic(req),
    ).toThrow(/not configured/);
  });
});
