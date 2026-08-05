import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Anti-forgery tokens, bound to the session they were minted for.
 *
 * PLATFORM-CONVENTIONS R-3.6. The usual double-submit check — "the cookie value
 * equals the header value" — assumes an attacker cannot set our cookies. On a
 * shared registrable domain that assumption is false: any page on any
 * `*.oxshare.com` host can set a `Domain=.oxshare.com` cookie that this API
 * receives, so a naive double-submit is bypassed by setting BOTH halves.
 *
 * So the token carries a proof:
 *
 *   token = base64url(nonce) "." base64url(HMAC-SHA256(secret, subject "." nonce))
 *
 * `subject` is the authenticated principal's id, taken from the verified session
 * JWT — never from anything the caller supplies. An attacker can set a cookie,
 * but cannot compute an HMAC for the victim's subject without the server secret,
 * so a tossed token fails verification even when it is echoed perfectly into the
 * header.
 *
 * Two independent things must therefore hold for a request to pass, which is the
 * point: the header must match the cookie (a cross-origin page cannot set a
 * custom header without a CORS preflight this API refuses), AND the token must
 * prove it was minted for this exact session.
 */
@Injectable()
export class CsrfService {
  /** Long enough to be worth rotating on login, short enough that a leaked
   *  token is not indefinitely useful. Matches the admin access-token life. */
  static readonly TTL_MS = 8 * 60 * 60 * 1000;

  constructor(private readonly config: ConfigService) {}

  /**
   * The signing key.
   *
   * Derived from the admin JWT secret rather than introduced as a fourth secret
   * to configure, deploy and rotate. The `oxshare.csrf.v1` label is what keeps
   * it a genuinely separate key: HMAC with a distinct label cannot produce a
   * value usable as, or derived back to, the JWT key. One less thing to get
   * wrong at deploy time, with no loss of separation.
   *
   * env.validation.ts already refuses to boot in production without
   * ADMIN_JWT_SECRET and enforces a 32-character minimum, so this inherits both.
   */
  private key(): Buffer {
    const root = this.config.getOrThrow<string>('ADMIN_JWT_SECRET');
    return createHmac('sha256', root).update('oxshare.csrf.v1').digest();
  }

  /** A fresh token for a principal. Called on login and on refresh. */
  issue(subject: string): string {
    const nonce = randomBytes(18).toString('base64url');
    return `${nonce}.${this.sign(subject, nonce)}`;
  }

  /**
   * Does `token` prove it was minted for `subject`?
   *
   * Returns a boolean rather than throwing: the guard owns the HTTP meaning of a
   * failure, and this stays a pure predicate that is trivial to test.
   */
  verify(subject: string, token: string | undefined): boolean {
    if (!token) return false;

    const separator = token.indexOf('.');
    if (separator <= 0) return false;

    const nonce = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!nonce || !signature) return false;

    return this.constantTimeEquals(signature, this.sign(subject, nonce));
  }

  private sign(subject: string, nonce: string): string {
    return createHmac('sha256', this.key()).update(`${subject}.${nonce}`).digest('base64url');
  }

  /**
   * Constant-time comparison that does not leak length.
   *
   * `timingSafeEqual` throws on differing lengths, and branching on that would
   * itself be a timing signal, so both sides are hashed to a fixed width first —
   * the same treatment the MT5 webhook gives its signature.
   */
  private constantTimeEquals(a: string, b: string): boolean {
    const ha = createHmac('sha256', 'oxshare.compare').update(a).digest();
    const hb = createHmac('sha256', 'oxshare.compare').update(b).digest();
    return timingSafeEqual(ha, hb);
  }
}
