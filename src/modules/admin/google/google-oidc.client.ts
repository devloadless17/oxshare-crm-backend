import { Inject, Injectable, Logger } from '@nestjs/common';
import { createPublicKey, timingSafeEqual, verify, type KeyObject } from 'crypto';
import { GoogleSignInError } from './google-sign-in.error';

/**
 * Google's OpenID Connect endpoints, and the ONE thing this file trusts them
 * for: an ID token whose RS256 signature verifies against Google's published
 * keys. No new dependency — Node's `crypto` reads a JWK directly
 * (`createPublicKey({ format: 'jwk' })`) and verifies RS256 natively.
 */
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** Clock skew tolerated on `exp` and `iat`. */
const SKEW_SECONDS = 60;
/** Never cache Google's keys longer than this, whatever Cache-Control says. */
const MAX_KEY_CACHE_MS = 24 * 60 * 60 * 1000;
/** When Cache-Control names no max-age. */
const DEFAULT_KEY_CACHE_MS = 60 * 60 * 1000;
/** An unknown `kid` refetches the keys at most this often — a forged kid must not become a fetch amplifier. */
const UNKNOWN_KID_REFETCH_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

/**
 * The HTTP seam. Production passes global `fetch`; the specs pass a fake that
 * answers the token and JWKS URLs with tokens signed by a local RSA key, so
 * every verification line below runs for real in the tests.
 */
export const GOOGLE_FETCH = Symbol('GOOGLE_FETCH');
export type GoogleFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface VerifiedGoogleIdentity {
  sub: string;
  email: string;
  hd?: string;
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  hd?: unknown;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

/** Constant-time string equality. Unequal lengths are simply unequal. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `max-age=19951, must-revalidate, …` → ms, capped. */
function cacheLifetime(cacheControl: string | null): number {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '');
  if (!match) return DEFAULT_KEY_CACHE_MS;
  return Math.min(Number.parseInt(match[1], 10) * 1000, MAX_KEY_CACHE_MS);
}

@Injectable()
export class GoogleOidcClient {
  private readonly logger = new Logger(GoogleOidcClient.name);
  private keys = new Map<string, KeyObject>();
  private keysExpireAt = 0;
  private lastFetchAt = 0;

  constructor(@Inject(GOOGLE_FETCH) private readonly http: GoogleFetch) {}

  /**
   * Spend the authorization code (with the PKCE verifier) for an ID token.
   * Anything but a 200 carrying an `id_token` is `exchange` — Google's own
   * error text is logged by its code only and never forwarded.
   */
  async exchangeCode(params: {
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<string> {
    const body = new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier,
    });
    let response: Response;
    try {
      response = await this.http(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn(`Google token endpoint unreachable: ${(error as Error).name}`);
      throw new GoogleSignInError('exchange');
    }
    if (response.status !== 200) {
      let reason = 'unknown';
      try {
        const payload = (await response.json()) as { error?: unknown };
        if (typeof payload.error === 'string') reason = payload.error.slice(0, 64);
      } catch {
        /* not JSON */
      }
      this.logger.warn(`Google token exchange refused: HTTP ${response.status} (${reason})`);
      throw new GoogleSignInError('exchange');
    }
    let payload: { id_token?: unknown };
    try {
      payload = (await response.json()) as { id_token?: unknown };
    } catch {
      throw new GoogleSignInError('exchange');
    }
    if (typeof payload.id_token !== 'string' || payload.id_token === '') {
      throw new GoogleSignInError('exchange');
    }
    return payload.id_token;
  }

  /**
   * Verify an ID token completely: algorithm, key, signature, issuer,
   * audience, authorized party, lifetime, nonce, subject, verified email and
   * the domain rule. Every structural or cryptographic failure is `token`;
   * the two that a REAL Google account can trip have their own codes so the
   * console can say something useful.
   */
  async verifyIdToken(
    idToken: string,
    expected: { clientId: string; nonce: string; allowedDomains: readonly string[]; now?: number },
  ): Promise<VerifiedGoogleIdentity> {
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some((p) => p === '')) throw new GoogleSignInError('token');
    const [headerSegment, payloadSegment, signatureSegment] = parts;

    let header: JwtHeader;
    let claims: IdTokenClaims;
    try {
      header = decodeSegment<JwtHeader>(headerSegment);
      claims = decodeSegment<IdTokenClaims>(payloadSegment);
    } catch {
      throw new GoogleSignInError('token');
    }
    if (typeof header !== 'object' || header === null) throw new GoogleSignInError('token');
    if (typeof claims !== 'object' || claims === null) throw new GoogleSignInError('token');

    // RS256 and nothing else — `none`, HS256 (a public key used as an HMAC
    // secret) and every other algorithm are refused before any key is touched.
    if (header.alg !== 'RS256') throw new GoogleSignInError('token');
    if (typeof header.kid !== 'string' || header.kid === '') throw new GoogleSignInError('token');

    const key = await this.keyFor(header.kid);
    if (!key) throw new GoogleSignInError('token');

    const signed = Buffer.from(`${headerSegment}.${payloadSegment}`, 'ascii');
    const signature = Buffer.from(signatureSegment, 'base64url');
    let valid = false;
    try {
      valid = verify('RSA-SHA256', signed, key, signature);
    } catch {
      valid = false;
    }
    if (!valid) throw new GoogleSignInError('token');

    const now = Math.floor((expected.now ?? Date.now()) / 1000);
    if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) {
      throw new GoogleSignInError('token');
    }
    if (Array.isArray(claims.aud)) {
      // A token for several audiences is only ours if Google says WE asked.
      if (!claims.aud.includes(expected.clientId) || claims.azp !== expected.clientId) {
        throw new GoogleSignInError('token');
      }
    } else if (claims.aud !== expected.clientId) {
      throw new GoogleSignInError('token');
    }
    if (claims.azp !== undefined && claims.azp !== expected.clientId) {
      throw new GoogleSignInError('token');
    }
    if (typeof claims.exp !== 'number' || claims.exp <= now - SKEW_SECONDS) {
      throw new GoogleSignInError('token');
    }
    if (typeof claims.iat !== 'number' || claims.iat > now + SKEW_SECONDS) {
      throw new GoogleSignInError('token');
    }
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, expected.nonce)) {
      throw new GoogleSignInError('token');
    }
    if (typeof claims.sub !== 'string' || claims.sub.trim() === '') {
      throw new GoogleSignInError('token');
    }
    if (typeof claims.email !== 'string' || !claims.email.includes('@')) {
      throw new GoogleSignInError('token');
    }
    if (claims.email_verified !== true) throw new GoogleSignInError('unverified_email');

    const email = claims.email.trim().toLowerCase();
    const hd = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : undefined;
    if (expected.allowedDomains.length > 0) {
      // BOTH: `hd` proves a Workspace account of that domain, and the address
      // must be in it too (a Workspace account can carry a secondary address).
      if (!hd || !expected.allowedDomains.includes(hd) || !email.endsWith(`@${hd}`)) {
        throw new GoogleSignInError('domain');
      }
    }
    return { sub: claims.sub, email, ...(hd ? { hd } : {}) };
  }

  /** Google's key for `kid`, from cache, refetching per Cache-Control or (rate-limited) on a miss. */
  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    const now = Date.now();
    if (now >= this.keysExpireAt) {
      await this.fetchKeys(now);
    } else if (!this.keys.has(kid) && now - this.lastFetchAt >= UNKNOWN_KID_REFETCH_MS) {
      // Google rotates keys; an unknown kid may simply be newer than our cache.
      await this.fetchKeys(now);
    }
    return this.keys.get(kid);
  }

  private async fetchKeys(now: number): Promise<void> {
    this.lastFetchAt = now;
    let response: Response;
    try {
      response = await this.http(GOOGLE_JWKS_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn(`Google JWKS unreachable: ${(error as Error).name}`);
      throw new GoogleSignInError('exchange');
    }
    if (response.status !== 200) {
      this.logger.warn(`Google JWKS answered HTTP ${response.status}`);
      throw new GoogleSignInError('exchange');
    }
    let body: { keys?: unknown };
    try {
      body = (await response.json()) as { keys?: unknown };
    } catch {
      throw new GoogleSignInError('exchange');
    }
    const keys = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(body.keys) ? (body.keys as Record<string, unknown>[]) : []) {
      if (typeof jwk?.kid !== 'string' || jwk.kty !== 'RSA') continue;
      if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
      if (jwk.use !== undefined && jwk.use !== 'sig') continue;
      try {
        keys.set(
          jwk.kid,
          createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e } as never, format: 'jwk' }),
        );
      } catch {
        /* a malformed key is skipped, not fatal */
      }
    }
    this.keys = keys;
    this.keysExpireAt = now + cacheLifetime(response.headers.get('cache-control'));
  }
}
