import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Mt5WebhookController } from '../src/modules/trading/mt5-webhook.controller';
import { ReplayNonceStore, type NonceRedis } from '../src/common/security/replay-nonce.store';

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

/**
 * Redis `SET key value NX PX ttl`, faithfully.
 *
 * Set-if-absent with an expiry: `OK` when the key was written, `null` when it
 * already existed. That atomicity is Redis's guarantee, not ours — the same
 * status as Postgres's UNIQUE index, which we test against a real Postgres only
 * because Testcontainers makes it free. Adding a container for Redis would mean
 * a new dev dependency, so what is asserted here is that the store issues the
 * right command and reads the reply correctly.
 */
function fakeRedis(): NonceRedis & { keys: Map<string, number> } {
  const keys = new Map<string, number>();
  return {
    keys,
    set(key, _value, _mode, ttlMs, _condition) {
      const expiry = keys.get(key);
      if (expiry !== undefined && expiry > Date.now()) return Promise.resolve(null);
      keys.set(key, Date.now() + ttlMs);
      return Promise.resolve('OK');
    },
  };
}

let redis: ReturnType<typeof fakeRedis>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
  redis = fakeRedis();
  controller = new Mt5WebhookController(config, {} as never, new ReplayNonceStore(redis));
});

afterEach(() => vi.useRealTimers());

/** The private verifier, reached the way the route reaches it. */
const verify = (req: Request) =>
  (controller as unknown as { assertAuthentic(r: Request): Promise<void> }).assertAuthentic(req);

describe('R-5.3 the deal feed verifies before it parses', () => {
  const now = '2026-08-05T12:00:00.000Z';

  it('accepts a correctly signed, freshly timestamped push', async () => {
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': now,
        'X-Bridge-Signature': sign(now, BODY),
      },
      BODY,
    );
    await expect(verify(req)).resolves.toBeUndefined();
  });

  it('REFUSES a push with no timestamp', async () => {
    // The regression. Previously this verified against the body alone and
    // passed, so a captured push replayed indefinitely.
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Signature': createHmac('sha256', SECRET).update(BODY).digest('hex'),
      },
      BODY,
    );
    await expect(verify(req)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a captured push replayed after the window', async () => {
    const old = '2026-08-05T11:50:00.000Z'; // ten minutes stale
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': old,
        'X-Bridge-Signature': sign(old, BODY),
      },
      BODY,
    );
    await expect(verify(req)).rejects.toThrow(/replay window/);
  });

  it('refuses a future timestamp as readily as a stale one', async () => {
    const ahead = '2026-08-05T12:10:00.000Z';
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': ahead,
        'X-Bridge-Signature': sign(ahead, BODY),
      },
      BODY,
    );
    await expect(verify(req)).rejects.toThrow(/replay window/);
  });

  it('tolerates modest clock skew against the Windows bridge host', async () => {
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
    await expect(verify(req)).resolves.toBeUndefined();
  });

  it('will not let an old signature be reused under a fresh timestamp', async () => {
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
    await expect(verify(req)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a body altered after signing', async () => {
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': now,
        'X-Bridge-Signature': sign(now, BODY),
      },
      JSON.stringify({ deals: [{ mt5Ticket: 'T-1', volume: '999999' }] }),
    );
    await expect(verify(req)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a malformed timestamp rather than treating it as now', async () => {
    const bad = 'yesterday';
    const req = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': bad,
        'X-Bridge-Signature': sign(bad, BODY),
      },
      BODY,
    );
    await expect(verify(req)).rejects.toThrow(/ISO-8601/);
  });

  it('refuses a wrong bridge token before looking at anything else', async () => {
    const req = push(
      {
        'X-Bridge-Token': 'not-the-secret',
        'X-Bridge-Timestamp': now,
        'X-Bridge-Signature': sign(now, BODY),
      },
      BODY,
    );
    await expect(verify(req)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses every push when no secret is configured', async () => {
    // An unauthenticated deal feed can mint commission out of thin air, so a
    // missing secret must fail closed rather than open.
    const unconfigured = new Mt5WebhookController(
      { get: () => '' } as unknown as ConfigService,
      {} as never,
      new ReplayNonceStore(fakeRedis()),
    );
    const req = push({ 'X-Bridge-Token': SECRET, 'X-Bridge-Timestamp': now }, BODY);
    await expect(
      (unconfigured as unknown as { assertAuthentic(r: Request): Promise<void> }).assertAuthentic(
        req,
      ),
    ).rejects.toThrow(/not configured/);
  });
});

/**
 * Single use, not merely recent — R-5.3, §8.4.
 *
 * Every test above proves the signed timestamp BOUNDS a replay. None of them
 * stops one: inside those five minutes a captured push is perfectly signed,
 * perfectly fresh, and accepted. That is the half the window cannot do, and
 * this endpoint mints commission — an accepted deal becomes an accrual,
 * matures, confirms and pays, with no clawback in Phase 1.
 *
 * Deals happen to survive it because ingest is idempotent on `mt5_ticket`. That
 * is a property of the downstream handler rather than of this endpoint, and the
 * Whish and USDT callbacks will arrive at code with no equivalent guarantee.
 */
describe('R-5.3 a signed payload may be used exactly once', () => {
  const now = '2026-08-05T12:00:00.000Z';
  const validPush = () =>
    push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': now,
        'X-Bridge-Signature': sign(now, BODY),
      },
      BODY,
    );

  it('accepts the first delivery', async () => {
    await expect(verify(validPush())).resolves.toBeUndefined();
  });

  it('REFUSES the identical push replayed inside the window', async () => {
    // THE assertion. Everything about this second request is valid — same
    // secret, same signature, same timestamp, well inside five minutes. Only
    // the fact that it has been seen makes it refusable.
    await verify(validPush());
    await expect(verify(validPush())).rejects.toThrow(/already been delivered/);
  });

  it('claims the signature itself, so no new header can be omitted', async () => {
    // The nonce is the signature: already unique per (timestamp, body), so the
    // bridge needs no change — and unlike a caller-supplied id it CANNOT be
    // left out, which is precisely how the timestamp check used to be defeated.
    await verify(validPush());
    expect([...redis.keys.keys()]).toEqual([`replay:${sign(now, BODY)}`]);
  });

  it('keeps the marker alive longer than the window it guards', async () => {
    // A shorter TTL would let a replay arrive after its own marker expired and
    // still pass every other check. One timestamp is acceptable across a
    // ten-minute span (±5), so the marker must outlive that.
    await verify(validPush());
    const expiry = redis.keys.get(`replay:${sign(now, BODY)}`);
    expect(expiry).toBeGreaterThan(Date.now() + 2 * 5 * 60 * 1000);
  });

  it('does not confuse two different pushes', async () => {
    const other = JSON.stringify({ deals: [{ mt5Ticket: 'T-2' }] });
    await verify(validPush());

    const second = push(
      {
        'X-Bridge-Token': SECRET,
        'X-Bridge-Timestamp': now,
        'X-Bridge-Signature': sign(now, other),
      },
      other,
    );
    await expect(verify(second)).resolves.toBeUndefined();
  });

  it('FAILS CLOSED when Redis is unreachable', async () => {
    // The opposite of what this endpoint used to do. A control that disables
    // itself when a dependency is missing is not a control — the timestamp was
    // optional, so omitting a header switched replay protection off. An outage
    // must refuse pushes, never wave them through unchecked.
    const broken = new Mt5WebhookController(
      config,
      {} as never,
      {
        claim: () => Promise.reject(new Error('redis down')),
      } as unknown as ReplayNonceStore,
    );

    await expect(
      (broken as unknown as { assertAuthentic(r: Request): Promise<void> }).assertAuthentic(
        validPush(),
      ),
    ).rejects.toThrow();
  });

  it('refuses rather than bypasses when Redis is not configured at all', async () => {
    // Unreachable in any configuration that boots — env.validation requires
    // REDIS_URL wherever MT5_BRIDGE_SECRET is set — but the fallback has to be
    // a refusal, so that a misconfiguration costs a rejected webhook rather
    // than an accepted replay.
    const unconfigured = new Mt5WebhookController(config, {} as never, new ReplayNonceStore(null));

    await expect(
      (unconfigured as unknown as { assertAuthentic(r: Request): Promise<void> }).assertAuthentic(
        validPush(),
      ),
    ).rejects.toThrow(/Replay protection is unavailable/);
  });
});
