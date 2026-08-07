import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto';
import { AuthorizationError, ValidationError } from '../../common/errors/domain-errors';
import { OTP_REDIS, type OtpRedis } from '../../common/security/replay-nonce.store';

/**
 * The email OTP that gates every withdrawal of client funds — FR-CORE-08 /
 * FR-IND-05, ARCHITECTURE §8.4, PLATFORM-CONVENTIONS R-3.7.
 *
 * ── THE PROPERTY THAT MATTERS MOST ─────────────────────────────────────────
 *
 * **A code is bound to the exact withdrawal it was issued for.**
 *
 * Neither ARCHITECTURE §8.4 nor R-3.7 says this, and the natural implementation
 * gets it wrong: key the OTP on the USER, mail a code, and accept it on the next
 * withdrawal that user submits. That builds a confirmation step which confirms
 * nothing — an attacker holding a live session triggers a send for a £10
 * withdrawal to the victim's own account, the victim reads a plausible email and
 * relays the code, and the attacker spends it on a £10,000 withdrawal to their
 * own address. The email said "confirm your withdrawal"; it did not say which.
 *
 * So the Redis key is a digest of the INTENT — user, amount, currency,
 * destination, provider — and the code is only valid for a request that hashes
 * to the same thing. Change any field and the lookup misses. The client never
 * sees the digest and cannot influence it beyond changing the withdrawal itself,
 * which is the point.
 *
 * ── WHY REDIS, NOT POSTGRES ────────────────────────────────────────────────
 *
 * §8.4 is explicit ("never in Postgres"), and the reason is the shape of the
 * data: a short-lived single-use marker with a TTL is the one thing Redis does
 * natively and the database does badly — in Postgres it is a table that grows
 * forever, needs a sweep, and takes a write on the hot path.
 *
 * ── FAILS CLOSED ───────────────────────────────────────────────────────────
 *
 * No Redis means no withdrawal. Not "no OTP required" — that is the failure mode
 * where an outage silently removes the control, which is precisely what happened
 * to the MT5 timestamp check before R-5.3 (see replay-nonce.store.ts).
 */
@Injectable()
export class WithdrawalOtpService {
  private readonly logger = new Logger(WithdrawalOtpService.name);

  /** §8.4 — five minutes. Long enough to find the mail, short enough to matter. */
  static readonly TTL_MS = 5 * 60 * 1000;
  /** R-3.7 — five verification attempts per code, then it is destroyed. */
  static readonly MAX_ATTEMPTS = 5;
  /** R-3.7 — three sends per 15 minutes per user. Also a mail-bomb bound. */
  static readonly MAX_SENDS = 3;
  static readonly SEND_WINDOW_MS = 15 * 60 * 1000;

  constructor(@Inject(OTP_REDIS) private readonly redis: OtpRedis | null) {}

  /**
   * The withdrawal a code is for, reduced to one opaque key.
   *
   * HMAC rather than a plain hash so the digest cannot be computed offline by
   * anyone who learns the scheme — it is not a secret the client should be able
   * to grind against. The label keeps it a distinct key from every other use of
   * the same secret (the same reasoning as csrf.service.ts).
   *
   * `destination` is included and is the field this exists for: the amount is
   * what a victim would notice, and the DESTINATION is what an attacker actually
   * needs to change.
   */
  private intentKey(intent: WithdrawalIntent): string {
    const canonical = [
      intent.userId,
      intent.amount,
      intent.currency,
      intent.destination.trim().toLowerCase(),
      intent.provider,
    ].join('');
    const digest = createHmac('sha256', this.secret())
      .update(`oxshare.withdrawal.otp.v1${canonical}`)
      .digest('hex');
    return `otp:withdrawal:${digest}`;
  }

  private secret(): string {
    // Reuses the portal access secret with a domain-separating label above.
    // env.validation.ts already requires it in every environment and enforces a
    // 32-character minimum, so this inherits both rather than adding a fifth
    // secret to deploy and rotate.
    return process.env['JWT_ACCESS_SECRET'] ?? '';
  }

  /** Codes are stored HASHED: a Redis dump must not yield live codes. */
  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private client(): OtpRedis {
    if (!this.redis) {
      throw new AuthorizationError(
        'Withdrawal confirmation is unavailable right now, so this withdrawal cannot be ' +
          'authorised. Please try again shortly.',
      );
    }
    return this.redis;
  }

  /**
   * Issues a code for one specific withdrawal and returns it for mailing.
   *
   * Returns the code rather than sending it, so the caller owns delivery and
   * this stays testable without a mail server. The caller must NOT log it, must
   * not return it in a response body, and must not put it anywhere but the
   * message (R-6.3).
   */
  async issue(intent: WithdrawalIntent): Promise<string> {
    const redis = this.client();

    /*
     * Send limit first, keyed on the USER rather than the intent.
     *
     * Deliberately not per-intent: an attacker who could re-key the counter by
     * changing one character of the destination would have no limit at all, and
     * the thing being protected here is the victim's INBOX as much as the
     * account.
     */
    const sendKey = `otp:withdrawal:sends:${intent.userId}`;
    const sends = await redis.incr(sendKey);
    if (sends === 1) await redis.pexpire(sendKey, WithdrawalOtpService.SEND_WINDOW_MS);
    if (sends > WithdrawalOtpService.MAX_SENDS) {
      throw new ValidationError(
        `Too many confirmation codes requested. Please wait ${Math.ceil(
          WithdrawalOtpService.SEND_WINDOW_MS / 60_000,
        )} minutes and try again.`,
      );
    }

    // `randomInt` is the CSPRNG, not `Math.random()`. Six digits is ~20 bits,
    // which is only adequate BECAUSE the attempt cap below is real: five tries
    // against a five-minute code is roughly one in forty thousand.
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    const key = this.intentKey(intent);
    await redis.set(key, this.hashCode(code), 'PX', WithdrawalOtpService.TTL_MS);
    // A fresh code resets the attempt counter — otherwise a user who mistyped
    // three times and asked for a new code would start it two attempts down.
    await redis.del(`${key}:attempts`);

    return code;
  }

  /**
   * Spends a code, or refuses.
   *
   * SINGLE USE: the key is deleted the moment it verifies, before the caller
   * moves any money. A code that has authorised one withdrawal cannot authorise
   * a second even if the request is replayed — which is a separate guarantee
   * from the idempotency key, and both are wanted.
   */
  async verify(intent: WithdrawalIntent, code: string): Promise<void> {
    const redis = this.client();
    const key = this.intentKey(intent);

    const stored = await redis.get(key);
    if (!stored) {
      /*
       * One message for "never issued", "expired", "already used" and "issued
       * for a DIFFERENT withdrawal".
       *
       * The last one is why the wording is vague: telling a caller that their
       * code is valid but the amount changed would confirm they hold a real code
       * and teach them exactly what to keep constant.
       */
      throw new ValidationError(
        'That confirmation code is not valid for this withdrawal. Request a new code and try again.',
      );
    }

    const attemptKey = `${key}:attempts`;
    const attempts = await redis.incr(attemptKey);
    if (attempts === 1) await redis.pexpire(attemptKey, WithdrawalOtpService.TTL_MS);
    if (attempts > WithdrawalOtpService.MAX_ATTEMPTS) {
      // Burn the code rather than merely refusing this attempt: an attacker who
      // can keep guessing past the cap has no cap.
      await redis.del(key, attemptKey);
      this.logger.warn(
        `Withdrawal OTP destroyed after ${WithdrawalOtpService.MAX_ATTEMPTS} failed attempts ` +
          `for user ${intent.userId}`,
      );
      throw new ValidationError(
        'Too many incorrect codes. That code has been cancelled — request a new one.',
      );
    }

    if (!this.constantTimeEquals(stored, this.hashCode(code))) {
      throw new ValidationError(
        'That confirmation code is not valid for this withdrawal. Request a new code and try again.',
      );
    }

    // Spent. Deleted BEFORE the caller acts, so a crash mid-withdrawal cannot
    // leave a reusable code behind.
    await redis.del(key, attemptKey);
  }

  /**
   * Constant-time comparison that does not leak length — the same treatment
   * CsrfService gives its token and the MT5 webhook gives its signature.
   */
  private constantTimeEquals(a: string, b: string): boolean {
    const ha = createHmac('sha256', 'oxshare.compare').update(a).digest();
    const hb = createHmac('sha256', 'oxshare.compare').update(b).digest();
    return timingSafeEqual(ha, hb);
  }
}

/** Everything a code is bound to. Any change makes a different code. */
export interface WithdrawalIntent {
  userId: string;
  /** The decimal STRING, exactly as it will be stored (§6.1). */
  amount: string;
  currency: string;
  destination: string;
  provider: string;
}
