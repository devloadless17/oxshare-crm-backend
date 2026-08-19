import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisThrottlerStorage } from '../src/common/security/redis-throttler.storage';
import type { OtpRedis } from '../src/common/security/replay-nonce.store';

/**
 * Rate-limit counters in Redis — PLATFORM-CONVENTIONS R-3.5.
 *
 * The default in-memory storage has two properties nobody chose: counters reset
 * on every deploy, and they are per-process, so two replicas double every limit.
 * Both are invisible in development and both matter in production, which is the
 * only place the limits are load-bearing.
 *
 * The case worth reading first is the LAST one: this fails OPEN when Redis is
 * gone, which is the opposite of the OTP and the replay nonce. The reasoning is
 * in the service; these pin that it is deliberate rather than an unhandled
 * rejection somebody will "fix" into a refusal.
 */

function fakeRedis(): OtpRedis & { store: Map<string, string>; expiries: Map<string, number> } {
  const store = new Map<string, string>();
  const expiries = new Map<string, number>();
  return {
    store,
    expiries,
    set: (key, value) => {
      store.set(key, value);
      return Promise.resolve('OK');
    },
    get: (key) => Promise.resolve(store.get(key) ?? null),
    del: (...keys: string[]) => {
      let n = 0;
      for (const k of keys) {
        expiries.delete(k);
        if (store.delete(k)) n++;
      }
      return Promise.resolve(n);
    },
    incr: (key) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    },
    pexpire: (key, ttlMs) => {
      expiries.set(key, ttlMs);
      return Promise.resolve(1);
    },
    /*
     * Real Redis semantics, which is the whole point of the case below: -1 for
     * a key that exists with no expiry, -2 for one that does not exist. Time
     * does not advance here, so a live key reports the full window.
     */
    pttl: (key) => {
      const ttl = expiries.get(key);
      if (ttl !== undefined) return Promise.resolve(ttl);
      return Promise.resolve(store.has(key) ? -1 : -2);
    },
  };
}

const TTL = 60_000;
const LIMIT = 5;
const BLOCK = 60_000;

let redis: ReturnType<typeof fakeRedis>;
let storage: RedisThrottlerStorage;

const hit = (key = 'ip:1.2.3.4') => storage.increment(key, TTL, LIMIT, BLOCK, 'default');

beforeEach(() => {
  redis = fakeRedis();
  storage = new RedisThrottlerStorage(redis);
});

describe('counting', () => {
  it('counts each request', async () => {
    expect((await hit()).totalHits).toBe(1);
    expect((await hit()).totalHits).toBe(2);
    expect((await hit()).totalHits).toBe(3);
  });

  it('does not block below the limit', async () => {
    for (let i = 0; i < LIMIT; i++) expect((await hit()).isBlocked).toBe(false);
  });

  it('blocks once the limit is exceeded', async () => {
    for (let i = 0; i < LIMIT; i++) await hit();
    const over = await hit();
    expect(over.isBlocked).toBe(true);
    expect(over.timeToBlockExpire).toBe(BLOCK / 1000);
  });

  it('counts each caller separately', async () => {
    // The key is the whole point of a rate limiter; sharing one across callers
    // would throttle the world as one client.
    for (let i = 0; i < LIMIT + 1; i++) await hit('ip:1.1.1.1');
    expect((await hit('ip:2.2.2.2')).isBlocked).toBe(false);
  });

  it('sets the window expiry ONCE, on the first hit', async () => {
    /*
     * A fixed window, not a sliding one. Re-setting the expiry on every request
     * would mean a caller who keeps knocking never falls out of the window and
     * is throttled forever — the limit becomes a permanent ban with extra steps.
     */
    await hit();
    await hit();
    await hit();
    const setCalls = [...redis.expiries.keys()].filter((k) => k.startsWith('throttle:'));
    expect(setCalls).toHaveLength(1);
    expect(redis.expiries.get(setCalls[0])).toBe(TTL);
  });
});

describe('a counter that lost its expiry', () => {
  /*
   * INCR and PEXPIRE are two round trips. Kill the process in between — a
   * restart mid-request — and the counter survives with no expiry. Because the
   * expiry was only ever set on `hits === 1`, nothing would set one again: the
   * count climbs forever and that caller is refused indefinitely, while the
   * block key expiring and re-arming every minute makes the limiter look
   * healthy. Observed in dev as a counter at 393 with PTTL = -1, 429ing a
   * once-a-minute poll.
   */
  const KEY = 'throttle:default:ip:1.2.3.4';

  it('repairs it on the next hit instead of refusing that caller forever', async () => {
    redis.store.set(KEY, '393'); // orphaned: a value, and no entry in `expiries`
    expect(await redis.pttl(KEY)).toBe(-1);

    const record = await hit();

    expect(redis.expiries.get(KEY)).toBe(TTL);
    expect(await redis.pttl(KEY)).toBeGreaterThan(0);
    // Still refused on THIS request — the count is genuinely over the limit —
    // but the window now ends, which is the difference that matters.
    expect(record.isBlocked).toBe(true);
    expect(record.timeToExpire).toBe(TTL / 1000);
  });

  it('says so, because a lost PEXPIRE is not a normal event', async () => {
    redis.store.set(KEY, '393');
    const warn = vi.spyOn(storage['logger'], 'warn').mockImplementation(() => undefined);

    await hit();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/no expiry/);
    warn.mockRestore();
  });

  it('does not slide the window on a healthy counter', async () => {
    // The repair must not become "re-set the expiry on every request", which
    // is the permanent-ban bug in the opposite direction.
    await hit();
    redis.expiries.set(KEY, TTL - 30_000); // time has passed
    await hit();
    await hit();

    expect(redis.expiries.get(KEY)).toBe(TTL - 30_000);
  });
});

describe('while blocked', () => {
  it('keeps answering blocked without advancing the counter', async () => {
    // Otherwise a client hammering a blocked endpoint extends their own block,
    // and an accidental retry loop becomes an indefinite lockout.
    for (let i = 0; i <= LIMIT; i++) await hit();
    const counterAfterBlock = redis.store.get('throttle:default:ip:1.2.3.4');

    const again = await hit();
    expect(again.isBlocked).toBe(true);
    expect(redis.store.get('throttle:default:ip:1.2.3.4')).toBe(counterAfterBlock);
  });

  it('lets the caller back in once the block timestamp has passed', async () => {
    for (let i = 0; i <= LIMIT; i++) await hit();
    // Age the block rather than waiting a real minute.
    redis.store.set('throttle:default:ip:1.2.3.4:blocked', String(Date.now() - 1));
    redis.store.delete('throttle:default:ip:1.2.3.4');

    expect((await hit()).isBlocked).toBe(false);
  });
});

describe('when Redis is unavailable — FAILS OPEN, deliberately', () => {
  it('permits the request when there is no client at all', async () => {
    const offline = new RedisThrottlerStorage(null);
    const record = await offline.increment('ip:1.2.3.4', TTL, LIMIT, BLOCK, 'default');
    expect(record.isBlocked).toBe(false);
  });

  it('permits the request when a command throws, and says so loudly', async () => {
    /*
     * The opposite direction from ReplayNonceStore and WithdrawalOtpService,
     * which both refuse. The difference is what the control protects: an OTP is
     * the ONLY thing behind an action, whereas a rate limit bounds abuse of paths
     * that are independently authenticated AND independently locked out per
     * account in Postgres. Failing closed here would turn a Redis blip into a
     * total outage of login and password reset for everyone at once.
     */
    const broken = {
      ...fakeRedis(),
      incr: () => Promise.reject(new Error('connection refused')),
    } as unknown as OtpRedis;
    const degraded = new RedisThrottlerStorage(broken);
    const errors = vi.spyOn(degraded['logger'], 'error').mockImplementation(() => undefined);

    const record = await degraded.increment('ip:1.2.3.4', TTL, LIMIT, BLOCK, 'default');

    expect(record.isBlocked).toBe(false);
    // Loud is what makes failing open acceptable rather than merely convenient.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toMatch(/DEGRADED/);
    errors.mockRestore();
  });

  it('does not log once per request during a sustained outage', async () => {
    // A Redis outage on the login path would otherwise write a line per request,
    // which buries the one line anybody needed to see.
    const broken = {
      ...fakeRedis(),
      incr: () => Promise.reject(new Error('connection refused')),
    } as unknown as OtpRedis;
    const degraded = new RedisThrottlerStorage(broken);
    const errors = vi.spyOn(degraded['logger'], 'error').mockImplementation(() => undefined);

    for (let i = 0; i < 50; i++) {
      await degraded.increment('ip:1.2.3.4', TTL, LIMIT, BLOCK, 'default');
    }

    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
