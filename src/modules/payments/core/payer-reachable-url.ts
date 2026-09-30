/**
 * Can a PAYER'S PHONE open this URL? — a pure seam.
 *
 * Mirrors Rival's own redirect-URL rule byte-for-byte
 * (`transactions-system/packages/shared/src/schemas/whish.ts`, whose spec was
 * measured against the live Whish sandbox): Whish itself answers a bare 403
 * for localhost/127.0.0.1 redirect URLs, and Rival additionally refuses ::1,
 * 0.0.0.0 and *.localhost because a customer's phone cannot reach those
 * either.
 *
 * The CRM's use is the INVERSE of Rival's: Rival refuses the request, we
 * simply OMIT the redirect URLs when the portal address is not
 * payer-reachable — Rival then serves its own platform result pages, the
 * client still sees a real outcome, and settlement still lands through the
 * webhook/poll path which never depended on the redirect. Without this, every
 * deposit from a deployment whose PORTAL_URL is not public (local dev, a
 * private staging box) dies at create time with a validation error the client
 * cannot act on.
 */
export function isPayerReachableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '0.0.0.0' || host === '[::]') return false;
  // Loopback ranges: 127.0.0.0/8 and IPv6 ::1 (URL brackets it).
  if (host === '[::1]' || host === '::1') return false;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  return true;
}
