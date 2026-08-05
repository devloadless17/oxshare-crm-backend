import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthenticationError } from '../errors/domain-errors';

/**
 * Single-use replay protection for signed webhooks — R-5.3, ARCHITECTURE §8.4.
 *
 * The signed `±5 minute` timestamp window BOUNDS a replay; it does not stop one.
 * Inside that window a captured request is still perfectly valid, and the deal
 * feed mints commission: a deal it accepts becomes an accrual, matures, confirms
 * and pays, with no clawback in Phase 1. Deals happen to survive it because
 * ingest is idempotent on `mt5_ticket` — but that is a property of the DOWNSTREAM
 * handler, and the Whish and USDT callbacks will arrive at code with no
 * equivalent guarantee.
 *
 * Redis, not Postgres, and §8.4 is explicit about it. This is a short-lived
 * single-use marker with a TTL, which is the one thing Redis does natively and
 * the database does badly: in Postgres it becomes a table that grows forever and
 * needs a sweep, plus a write on the hot path of every webhook.
 *
 * The primitive is `SET key value NX PX ttl` — set-if-absent with an expiry, in
 * ONE round trip. That atomicity is the whole guarantee: two copies of the same
 * request racing each other cannot both receive `OK`. A `GET` then `SET` would
 * be the check-then-insert race §6.3 warns about, in a different store.
 *
 * FAILS CLOSED. If Redis is unreachable the webhook is refused, not waved
 * through. That is deliberate and is the opposite of what this endpoint used to
 * do — the timestamp was optional at the caller's discretion, so omitting a
 * header disabled the check. A control an attacker can switch off is not a
 * control, and neither is one an outage switches off.
 */

/** The injected client. Narrow on purpose: one command, so a fake is honest. */
export interface NonceRedis {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    condition: 'NX',
  ): Promise<string | null>;
}

export const NONCE_REDIS = Symbol('NONCE_REDIS');

/**
 * The commands the withdrawal OTP needs — FR-CORE-08, §8.4.
 *
 * A SECOND token over the SAME connection, not a second client: one Redis
 * process, one socket, two narrowly-typed views of it. Declaring only the
 * commands each use actually issues keeps a fake honest — a test double that has
 * to implement `set/get/del/incr/pexpire` and nothing else cannot quietly
 * diverge from the real client's behaviour on commands nobody calls.
 */
export interface OtpRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
}

export const OTP_REDIS = Symbol('OTP_REDIS');

@Injectable()
export class ReplayNonceStore {
  private readonly logger = new Logger(ReplayNonceStore.name);

  constructor(@Inject(NONCE_REDIS) private readonly redis: NonceRedis | null) {}

  /**
   * Claims a nonce, or refuses because it has been seen.
   *
   * `ttlMs` should comfortably exceed the full span a timestamp can be accepted
   * over. The window is ±5 minutes, so one signature is valid across a
   * ten-minute span; the marker has to outlive that or a replay could arrive
   * after its own marker expired and still pass the timestamp check.
   */
  async claim(nonce: string, ttlMs: number): Promise<void> {
    if (!this.redis) {
      // Unreachable in any configuration that boots: env validation requires
      // REDIS_URL wherever the bridge secret is set. Kept as a refusal rather
      // than a non-null assertion, because the failure mode this guards is
      // "accepted silently".
      throw new AuthenticationError(
        'Replay protection is unavailable: no Redis connection is configured. Refusing the ' +
          'request rather than accepting one that cannot be checked.',
      );
    }

    let reply: string | null;
    try {
      reply = await this.redis.set(`replay:${nonce}`, '1', 'PX', ttlMs, 'NX');
    } catch (error) {
      this.logger.error(
        `Replay check failed against Redis: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new AuthenticationError(
        'Replay protection is unavailable. Refusing the request rather than accepting one that ' +
          'cannot be checked.',
      );
    }

    // Redis answers `OK` when it set the key and `null` when it already existed.
    // Null therefore means "somebody has already used this exact signature".
    if (reply === null) {
      throw new AuthenticationError(
        'This request has already been delivered. A signed payload may be used exactly once.',
      );
    }
  }
}
