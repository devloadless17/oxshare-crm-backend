import { createHash, createHmac, hkdfSync, randomBytes } from 'crypto';
import type { CookieOptions } from 'express';
import { isSecureContext } from '../../../common/security/session-cookies';
import { safeEqual } from './google-oidc.client';

/**
 * The signed cookie that carries one Google sign-in from `start` to
 * `callback` — state, nonce, the PKCE verifier, where to land, and the invite
 * token in invite mode. Pure functions; no Nest.
 *
 * WHY A COOKIE AND NOT A TABLE. The round trip leaves this API for Google and
 * comes back as a top-level GET from accounts.google.com, in the SAME browser.
 * A cookie binds the callback to that browser (a stolen `code`+`state` pasted
 * elsewhere arrives without it), needs no cleanup job, and the HMAC means the
 * browser can hold it without being able to change a byte of it.
 *
 * WHY NOT `__Host-`. That prefix forces `Path=/`, and this cookie is scoped to
 * the Google routes so it travels with no other request. `__Secure-` (Secure
 * required, browser-enforced) is the strongest prefix that allows a path;
 * the HMAC is what stops a sibling host forging one.
 *
 * SameSite=Lax: the callback is a top-level navigation from Google, which Lax
 * sends; Strict would drop it and every sign-in would fail `state`.
 */

export const GOOGLE_FLOW_COOKIE_BASE = 'oxshare_crm_admin_gflow';
export const GOOGLE_FLOW_TTL_MS = 10 * 60 * 1000;

export interface GoogleFlowState {
  state: string;
  nonce: string;
  verifier: string;
  mode: 'login' | 'invite';
  /** The invite token — stored ONLY here, never sent to Google. */
  invite?: string;
  /** A same-origin console path, already sanitised. */
  next: string;
  /** Epoch ms. */
  exp: number;
}

export function googleFlowCookieName(): string {
  return isSecureContext() ? `__Secure-${GOOGLE_FLOW_COOKIE_BASE}` : GOOGLE_FLOW_COOKIE_BASE;
}

/** Read under either spelling, preferring the prefixed one (as session-cookies does). */
export function readGoogleFlowCookie(
  cookies: Record<string, string | undefined> | undefined,
): string | undefined {
  return cookies?.[`__Secure-${GOOGLE_FLOW_COOKIE_BASE}`] ?? cookies?.[GOOGLE_FLOW_COOKIE_BASE];
}

export function googleFlowCookieOptions(path: string, maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureContext(),
    sameSite: 'lax',
    path,
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}

/**
 * A key of its own, DERIVED (HKDF-SHA256) from the admin JWT secret rather
 * than the secret itself: one configured secret, but a flow cookie can never
 * be confused with — or used to forge — a token signed by that secret.
 */
export function googleFlowKey(adminJwtSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', adminJwtSecret, 'oxshare-crm', 'admin-google-flow-cookie/v1', 32),
  );
}

export const randomToken = (): string => randomBytes(32).toString('base64url');

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function mac(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function sealGoogleFlow(flow: GoogleFlowState, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${mac(key, payload)}`;
}

/**
 * The flow, or a reason it is not usable. The MAC is checked (constant time)
 * BEFORE the payload is parsed, so nothing attacker-written is interpreted.
 */
export function openGoogleFlow(
  value: string | undefined,
  key: Buffer,
  now = Date.now(),
): { ok: true; flow: GoogleFlowState } | { ok: false; reason: 'missing' | 'invalid' | 'expired' } {
  if (!value) return { ok: false, reason: 'missing' };
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return { ok: false, reason: 'invalid' };
  const payload = value.slice(0, dot);
  if (!safeEqual(value.slice(dot + 1), mac(key, payload))) return { ok: false, reason: 'invalid' };

  let flow: GoogleFlowState;
  try {
    flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GoogleFlowState;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const wellFormed =
    typeof flow === 'object' &&
    flow !== null &&
    typeof flow.state === 'string' &&
    typeof flow.nonce === 'string' &&
    typeof flow.verifier === 'string' &&
    (flow.mode === 'login' || flow.mode === 'invite') &&
    (flow.invite === undefined || typeof flow.invite === 'string') &&
    typeof flow.next === 'string' &&
    typeof flow.exp === 'number';
  if (!wellFormed) return { ok: false, reason: 'invalid' };
  if (flow.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, flow };
}

export const DEFAULT_GOOGLE_NEXT = '/dashboard';

/**
 * Where to land after signing in: a RELATIVE console path, or the dashboard.
 *
 * Refused: anything not starting with `/`, protocol-relative `//host`, the
 * backslash spelling browsers normalise to it (`/\host`), and control
 * characters. The result is appended to ADMIN_URL, so a path is all it can be.
 */
export function safeGoogleNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > 2048) return DEFAULT_GOOGLE_NEXT;
  if (!raw.startsWith('/')) return DEFAULT_GOOGLE_NEXT;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_GOOGLE_NEXT;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return DEFAULT_GOOGLE_NEXT;
  return raw;
}
