import type { Request } from 'express';

/**
 * The caller's real IP address — the one fact everything below depends on.
 *
 * WHY THIS FILE EXISTS, and why it is not a one-liner.
 *
 * `req.ip` is only the client when Express has been told how many reverse
 * proxies sit in front of it. Behind nginx, a load balancer or CloudFront —
 * that is, in any real deployment — an untuned `req.ip` is the PROXY's address.
 * Every request then looks like it came from the same place, and three separate
 * things quietly break:
 *
 *   - the per-IP rate limiter throttles the whole world as one caller,
 *   - an IP allowlist admits everyone or no-one, depending which side the proxy
 *     falls on,
 *   - the audit trail records the proxy for every action, which is worse than
 *     recording nothing because it looks like an answer.
 *
 * The naive fix is worse than the bug: reading `X-Forwarded-For` and taking the
 * first entry lets ANY caller set that header themselves and claim to be any
 * address they like — which turns an IP allowlist from a control into a
 * decoration, and lets a rate limiter be evaded with a random header per
 * request. The header is only trustworthy to the extent that a proxy WE control
 * appended to it.
 *
 * So the trust boundary is configuration, not inference. `TRUSTED_PROXY_HOPS`
 * says how many proxies we operate. Express counts that many entries in from
 * the right — the rightmost entries are the ones our own infrastructure wrote,
 * and anything further left was supplied by the caller and is worthless.
 *
 * Getting the number wrong is a security bug in BOTH directions, which is why
 * it is explicit and required rather than guessed:
 *   - too low  → we read our own proxy's address; controls key on the wrong thing
 *   - too high → we read further left than our infrastructure reaches, into
 *                caller-supplied text, and the caller chooses their own IP
 */

/**
 * How many reverse proxies we operate in front of this process.
 *
 * 0 means "none" — the socket address is the client, correct for local
 * development and for a process exposed directly. One nginx or one load
 * balancer is 1. nginx behind CloudFront is 2.
 */
export function trustedProxyHops(): number {
  const raw = process.env['TRUSTED_PROXY_HOPS'];
  if (raw === undefined || raw.trim() === '') return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(
      `TRUSTED_PROXY_HOPS must be a non-negative integer (got ${JSON.stringify(raw)}). ` +
        'It is the number of reverse proxies YOU operate in front of this API — ' +
        '0 for none, 1 for a single nginx or load balancer. Guessing it wrong ' +
        'either keys every security control on the proxy address or lets callers ' +
        'choose their own IP.',
    );
  }
  return hops;
}

/**
 * The client address, as Express resolved it under the configured trust setting.
 *
 * Returns `undefined` rather than a placeholder when there is genuinely no
 * address — an unknown IP must never be recorded as a real-looking one, and an
 * allowlist must never match on a fallback string.
 */
export function clientIp(req: Request): string | undefined {
  // `req.ip` already honours the `trust proxy` setting applied in main.ts, so
  // this is the one place the decision is made and every caller inherits it.
  const ip = req.ip ?? req.socket?.remoteAddress;
  if (!ip) return undefined;
  return normalizeIp(ip);
}

/**
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) reduced to its IPv4 form.
 *
 * Node hands back the mapped form on a dual-stack socket, so the same caller is
 * spelled two ways depending on how the listener was bound. An allowlist that
 * stores `127.0.0.1` would silently never match, and an audit trail would carry
 * two spellings of one address.
 */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
  return (mapped ? mapped[1] : ip.trim()).toLowerCase();
}
