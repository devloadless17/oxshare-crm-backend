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
       */
      const hits = await this.redis.incr(hitKey);
      if (hits === 1) await this.redis.pexpire(hitKey, ttl);

      if (hits > limit) {
        const until = Date.now() + blockDuration;
        await this.redis.set(blockKey, String(until), 'PX', blockDuration);
        return {
          totalHits: hits,
          timeToExpire: Math.ceil(ttl / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockDuration / 1000),
        };
      }

      return {
        totalHits: hits,
        timeToExpire: Math.ceil(ttl / 1000),
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
