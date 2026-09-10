import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { OTP_REDIS, type OtpRedis } from './replay-nonce.store';

/**
 * Rate-limit counters in Redis instead of process memory — PLATFORM-CONVENTIONS
 * R-3.5.
 *
 * `ThrottlerModule`'s default storage is an in-memory Map, which has two
 * properties nobody chose and both of which weaken the limits that matter:
 *
 *  1. **The counters reset on every deploy.** "5 login attempts per minute" is
 *     really "5 per minute, unless we shipped, in which case start again".
 *  2. **They are per PROCESS.** Two replicas double every limit; four quadruple
 *     it. The limit written in the decorator is not the limit in force, and
 *     nothing anywhere says so.
 *
 * Both are invisible in development, where there is one instance that restarts
 * when you tell it to. They matter in production, which is the only place the
 * limits are load-bearing.
 *
 * ── Why not `@nest-lab/throttler-storage-redis` ────────────────────────────
 *
 * The working agreement says to ask before adding a dependency, and the whole
 * implementation is three Redis commands over a client this process already
 * holds. A package here would be more code, not less — plus a version to track.
 *
 * ── FAILS OPEN, deliberately, and this is the one judgement call ───────────
 *
 * If Redis is unreachable this returns a record that permits the request rather
 * than refusing it. That is the opposite of `ReplayNonceStore` and
 * `WithdrawalOtpService`, which both fail CLOSED, and the difference is what the
 * control protects:
 *
 *  - a replay marker or an OTP is the ONLY thing standing behind an action, so
 *    losing it means the action is unprotected and must not proceed;
 *  - a rate limit is a bound on ABUSE of paths that are independently
 *    authenticated and, since 5 Aug, independently locked out per account
 *    (login-attempts.service.ts, which is in Postgres). Failing closed here
 *    would turn a Redis blip into a total outage of login, registration and
 *    password reset for every user at once — trading a throttling gap for a
 *    denial of service we inflicted on ourselves.
 *
 * The degradation is logged loudly so it is not silent, which is the property
 * that makes failing open acceptable rather than merely convenient.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  /** So a Redis outage logs once a minute, not once per request. */
  private lastWarnedAt = 0;

  constructor(@Inject(OTP_REDIS) private readonly redis: OtpRedis | null) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    /*
     * RELAX_RATE_LIMITS — the COUNTER goes permissive, the GUARD stays wired.
     *
     * Set only by the end-to-end CI jobs; `env.validation.ts` REFUSES to boot
     * with it in production, because these limits ARE the §8.4 control on
     * credential stuffing and token guessing.
     *
     * Done HERE rather than on the ThrottlerModule's limit, and that distinction
     * is the whole reason this works: routes that matter carry their own
     * `@Throttle({ default: { ttl, limit } })` — register is 10/hour, login
     * 5/min — and a per-route override REPLACES the module's figure. Raising the
     * module default would have relaxed nothing a browser suite actually meets.
     * The storage is consulted on every route whatever its limit says.
     *
     * WHY AT ALL: the browser suites met the real caps and waited them out, at
     * ~5.4 minutes of sleeping in a 20-minute CI job — and produced the largest
     * class of flakes this project has. In one day a rate limit was reported as
     * "the NEW password does not sign in", as "accept answered 429", as a
     * navigation timeout, and as a screen missing the words "already verified".
     * One defect wearing four costumes.
     *
     * WHAT IT COSTS: an E2E run no longer exercises the real limits. That is
     * acceptable only because `credential-route-throttling`,
     * `bridge-webhook-throttling` and `redis-throttler-storage` do, and because
     * no E2E spec asserts 429 behaviour — checked before this was added, not
     * assumed.
     *
     * `permit()` is reused deliberately: this is the SAME record the fail-open
     * path returns, so there is one definition of "allowed" in this file.
     */
    if (process.env['RELAX_RATE_LIMITS']) return this.permit(ttl);

    if (!this.redis) return this.permit(ttl);

    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;

    try {
      // Already serving a block? Answer without touching the counter, so a
      // client hammering a blocked endpoint cannot extend their own block.
      const blocked = await this.redis.get(blockKey);
      if (blocked) {
        const remaining = Number(blocked) - Date.now();
        if (remaining > 0) {
          return {
            totalHits: limit + 1,
            timeToExpire: Math.ceil(remaining / 1000),
            isBlocked: true,
            timeToBlockExpire: Math.ceil(remaining / 1000),
          };
        }
      }

      /*
       * INCR then PEXPIRE-on-first-hit.
       *
       * INCR is atomic, which is the whole reason this works across instances:
       * two replicas racing the same caller cannot both read "4" and both write
       * "5". The expiry is set only when the counter is created, so the window
       * is fixed from the first request rather than sliding forward on every
       * one — otherwise a caller who keeps knocking never falls out of it.
       *
       * ── The expiry is VERIFIED, not assumed ─────────────────────────────
       *
       * INCR and PEXPIRE are two round trips, so there is a window between them
       * in which this process can die, the connection can drop, or the command
       * can fail into the `catch` below. Lose the PEXPIRE and the counter is
       * IMMORTAL: `hits === 1` never comes round again, so nothing ever sets an
       * expiry, the count only climbs, and that caller is over the limit
       * FOREVER. The block key expires on schedule and the very next request
       * re-blocks them, which is what makes it so hard to read — the limiter
       * looks like it is working, one caller is just permanently locked out.
       *
       * This happened: a counter was found at 393 with `PTTL = -1` after the API
       * was restarted mid-request, 429ing a once-a-minute poll.
       *
       * So a hit past the first asks what the remaining window actually is, and
       * a key with no expiry gets one. That repairs an orphan on the next
       * request rather than requiring somebody to find and delete it by hand.
       * It is NOT a sliding window — the expiry is only ever set when there is
       * none, so a caller who keeps knocking still falls out on schedule.
       */
      const hits = await this.redis.incr(hitKey);
      let remainingMs: number;
      if (hits === 1) {
        await this.redis.pexpire(hitKey, ttl);
        remainingMs = ttl;
      } else {
        remainingMs = await this.redis.pttl(hitKey);
        if (remainingMs < 0) {
          await this.redis.pexpire(hitKey, ttl);
          remainingMs = ttl;
          this.warnOrphan(hitKey, hits);
        }
      }

      // The REAL time left, not the full window. It reaches the caller as
      // Retry-After, and telling somebody to wait 60s when the window resets in
      // 3 is an answer that is wrong in the direction of looking authoritative.
      const timeToExpire = Math.ceil(remainingMs / 1000);

      if (hits > limit) {
        const until = Date.now() + blockDuration;
        await this.redis.set(blockKey, String(until), 'PX', blockDuration);
        return {
          totalHits: hits,
          timeToExpire,
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockDuration / 1000),
        };
      }

      return {
        totalHits: hits,
        timeToExpire,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch (error) {
      this.warnOnce(error);
      return this.permit(ttl);
    }
  }

  /** The fail-open record — see the note above on why this direction. */
  private permit(ttl: number): ThrottlerStorageRecord {
    return {
      totalHits: 1,
      timeToExpire: Math.ceil(ttl / 1000),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }

  /**
   * An orphaned counter, repaired. Logged because it means a PEXPIRE was lost,
   * and the caller was over the limit for as long as it took to notice.
   */
  private warnOrphan(key: string, hits: number): void {
    this.logger.warn(
      `Rate-limit counter ${key} had no expiry and was climbing (${hits} hits) — a lost ` +
        'PEXPIRE, so this caller was being refused indefinitely. A fresh window has been set.',
    );
  }

  private warnOnce(error: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnedAt < 60_000) return;
    this.lastWarnedAt = now;
    this.logger.error(
      'Rate limiting is DEGRADED: the Redis counter is unreachable, so requests are being ' +
        'permitted without one. Per-account login lockout still applies (it is in Postgres). ' +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
