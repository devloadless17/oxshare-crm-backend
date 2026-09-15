import { lookup } from 'node:dns/promises';
import { ValidationError } from '../errors/domain-errors';
import { ipMatchesAny, type IpRule } from './ip-range';

/**
 * "May this server be told to connect THERE?" — the guard on every host an
 * administrator can choose.
 *
 * ## The attack this stops
 *
 * Two settings let an operator point the server at an arbitrary host: the Rival
 * base URL (`rival-settings.service.ts`) and the SMTP host
 * (`settings.service.ts`). Both were validated for SHAPE only — Rival with
 * `startsWith('https://')`, SMTP with nothing but a length — so both accepted
 * an address inside the network the server is standing in.
 *
 * That turns an admin session into two primitives:
 *
 *   - **Read the infrastructure.** `https://169.254.169.254/latest/meta-data/`
 *     is the cloud metadata endpoint, reachable only from the instance itself
 *     and historically the fastest route from "I can make the server fetch a
 *     URL" to "I have the machine's credentials". `10.0.0.0/8` and friends reach
 *     anything else sharing the network, including Postgres and Redis, which are
 *     firewalled from the internet precisely so that only this host may reach
 *     them.
 *   - **Redirect credentials.** Whoever owns the Rival base URL receives every
 *     payout instruction and the `Bearer` key sent with it; whoever owns the
 *     SMTP host receives every verification link, every password reset, and the
 *     admin invite — which `email.service.ts` calls the most dangerous
 *     credential this system sends.
 *
 * Neither is an authorization hole: both settings are already behind a
 * permission and both write an audit row naming the before and after. This is
 * the layer under that — it costs an attacker holding an admin session the
 * easiest move available to them, and it costs a legitimate operator nothing,
 * because no real Rival deployment and no real mail provider lives on a private
 * address.
 *
 * ## ⚠️ WHAT THIS DOES NOT STOP, STATED PLAINLY
 *
 * The hostname is resolved HERE, at the moment the setting is saved, and the
 * connection happens LATER from somewhere else. Between the two, the DNS answer
 * can change — the attacker owns the name, so they own its TTL. That is DNS
 * rebinding, and this check cannot see it.
 *
 * So this is a configuration-time gate, not a connect-time one. The complete
 * answer is to check the address the socket actually connected to, which means
 * a custom agent/`lookup` on each client. That is worth doing if either of these
 * settings ever stops being admin-only; it is not worth the weight today, and
 * writing that down is better than implying a guarantee this does not give.
 *
 * What it DOES stop completely is the literal form — `https://169.254.169.254`,
 * `http://10.0.0.5:6379` — which is the shape every one of these attacks takes
 * when nobody has bothered to register a domain for it.
 */

/**
 * Everything that is not the public internet.
 *
 * Wider than "private" in the RFC-1918 sense on purpose: the question is not
 * "is this address routable" but "could reaching it tell an attacker something
 * about, or let them act on, the network this server sits in".
 */
export const NON_PUBLIC_RANGES: readonly IpRule[] = [
  // ── IPv4 ────────────────────────────────────────────────────────────────
  '0.0.0.0/8', //        "this network" — and a bare `0.0.0.0` reaches localhost
  '10.0.0.0/8', //       RFC 1918 private
  '100.64.0.0/10', //    RFC 6598 carrier-grade NAT
  '127.0.0.0/8', //      loopback — the API, Postgres and Redis all listen here
  '169.254.0.0/16', //   link-local. Cloud metadata lives at 169.254.169.254
  '172.16.0.0/12', //    RFC 1918 private — the default Docker bridge range
  '192.0.0.0/24', //     IETF protocol assignments
  '192.168.0.0/16', //   RFC 1918 private
  '198.18.0.0/15', //    RFC 2544 benchmarking
  '224.0.0.0/4', //      multicast
  '240.0.0.0/4', //      reserved, includes 255.255.255.255 broadcast
  // ── IPv6 ────────────────────────────────────────────────────────────────
  '::/128', //           unspecified
  '::1/128', //          loopback
  'fc00::/7', //         unique local (the IPv6 equivalent of RFC 1918)
  'fe80::/10', //        link-local
  'ff00::/8', //         multicast
];

/** Is this a literal address inside a range we refuse to dial? */
export function isNonPublicAddress(ip: string): boolean {
  return ipMatchesAny(ip, NON_PUBLIC_RANGES);
}

/** Loopback only — the development exception, which is narrower than the above. */
const LOOPBACK_RANGES: readonly IpRule[] = ['127.0.0.0/8', '::1/128'];

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || ipMatchesAny(hostname, LOOPBACK_RANGES);
}

export interface OutboundHostOptions {
  /**
   * What the operator is setting, for the error message — "the Rival base URL",
   * "the SMTP host". The sentence has to name the field, or an admin who typed
   * one of two hosts on the same screen cannot tell which was refused.
   */
  subject: string;
  /**
   * Permit `localhost`/`127.0.0.1`. Development only: Rival and Mailpit both run
   * beside the CRM on a developer's machine, and refusing that would push local
   * work onto the env floor or onto a real provider.
   */
  allowLoopback?: boolean;
}

/**
 * Refuse a host that is not on the public internet.
 *
 * Takes a URL or a bare hostname, so one guard serves both settings: Rival
 * stores `https://api.rival…` and SMTP stores `smtp.provider.com`.
 *
 * Resolves the name. A name that does not resolve is ACCEPTED — DNS is not this
 * function's business, the connection will fail on its own with an error about
 * the real problem, and refusing to save a setting because a resolver was
 * briefly unreachable would be an outage of our own making.
 */
export async function assertPublicOutboundHost(
  urlOrHost: string,
  options: OutboundHostOptions,
): Promise<void> {
  const hostname = hostnameOf(urlOrHost);
  if (hostname === null) {
    throw new ValidationError(`${options.subject} is not a valid host.`);
  }

  // `new URL()` keeps the brackets on an IPv6 literal (`[::1]`), and neither the
  // matcher nor the resolver accepts them. Strip once, here, so every branch
  // below sees the same address the socket eventually would.
  const bare = hostname.replace(/^\[|\]$/g, '');

  if (isLoopbackHostname(bare)) {
    if (options.allowLoopback) return;
    throw new ValidationError(`${options.subject} may not point at this server itself (${bare}).`);
  }
  if (isNonPublicAddress(bare)) {
    throw new ValidationError(
      `${options.subject} may not point at a private or internal address (${bare}). ` +
        'It has to be a host on the public internet.',
    );
  }

  // A name, not a literal. Resolve it — `evil.example` pointing at
  // 169.254.169.254 is the same attack wearing a domain.
  let addresses: readonly { address: string }[];
  try {
    addresses = await lookup(bare, { all: true });
  } catch {
    return; // Does not resolve. See the doc comment: not our call to make.
  }

  const blocked = addresses.find((entry) => isNonPublicAddress(entry.address));
  if (blocked) {
    throw new ValidationError(
      `${options.subject} resolves to a private or internal address ` +
        `(${bare} → ${blocked.address}). It has to be a host on the public internet.`,
    );
  }
}

/**
 * The hostname out of a URL, or the input itself when it is already bare.
 *
 * `new URL()` needs a scheme, and the SMTP setting stores none. Prepending one
 * is what makes a single guard serve both fields — and it has to be done
 * carefully, because `new URL('smtp://user:pass@host')` parses credentials that
 * a bare hostname cannot contain, which is why the bare branch rejects anything
 * carrying `/`, `@`, `?` or `#` rather than trying to interpret it.
 */
function hostnameOf(urlOrHost: string): string | null {
  const value = urlOrHost.trim();
  if (value === '') return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const { hostname } = new URL(value);
      return hostname === '' ? null : hostname;
    } catch {
      return null;
    }
  }

  if (/[/@?#\s]/.test(value)) return null;
  return value;
}
