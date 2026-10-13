import { canonicaliseRule, ipMatchesAny, isValidRule, matchesEverything } from './ip-range';
import { ValidationError } from '../errors/domain-errors';

/** RBAC-08's refusal, wherever it is decided (guard, refresh, file routes). */
export const NETWORK_REFUSED = 'Your network is not permitted to reach the administration API.';

/**
 * The ONE answer sign-in gives for every failure — so it names both causes
 * (network, credentials) and confirms neither. Per-person rules (0224) mean the
 * network can only be judged once we know whose account it is, and answering a
 * wrong password differently from a refused network would tell a stranger that
 * an address belongs to an administrator, or that a password was right.
 */
export const OUTSIDE_SIGN_IN_REFUSED =
  'Sign-in refused: the email or password is wrong, or this network is not permitted for this account.';

/** The most addresses one administrator may be given. */
export const MAX_ALLOWED_IPS = 20;

/** What RBAC-08 needs from an administrator: their own network setting (0224). */
export interface AdminNetworkAccess {
  accessAnywhere?: boolean;
  allowedIps?: readonly string[];
}

/**
 * RBAC-08's decision, in one place: may THIS administrator, calling from `ip`,
 * use the console?
 *
 * Per person since 0224. Each administrator either may connect from anywhere,
 * or only from the addresses on their own row — set when they are invited or
 * edited. There is no global list any more.
 *
 * Two properties are load-bearing:
 *
 *   1. A restricted administrator with an unknown address is DENIED. Once
 *      someone has said "only these addresses", failing open on a caller we
 *      cannot identify defeats the point — `ipMatchesAny(undefined, …)` is false.
 *   2. A restricted administrator with NO addresses is denied everywhere. The
 *      invite and edit paths refuse to write that state (`resolveNetworkAccess`),
 *      so it only exists if somebody edits the table by hand.
 *
 * Shared by the global guard, the sign-in steps, refresh, the reset link and the
 * `/uploads` file routes, so none of them can disagree.
 */
export function adminNetworkAdmits(admin: AdminNetworkAccess, ip: string | undefined): boolean {
  if (!ipAllowlistEnforced()) return true; // switched off by configuration
  if (admin.accessAnywhere !== false) return true;
  return ipMatchesAny(ip, admin.allowedIps ?? []);
}

/**
 * Validate and canonicalise one administrator's network setting, as typed on the
 * invite or edit screen. Returns what is stored: `allowedIps` is emptied when
 * access is from anywhere, so a stale list cannot quietly come back into force
 * the day somebody unticks the box.
 *
 * Refuses a restricted administrator with no address (they could never sign in),
 * anything that is not an IPv4 address or CIDR range, and a `/0` — that is
 * "anywhere" spelled as an address, and the switch says it plainly.
 */
export function resolveNetworkAccess(input: {
  accessAnywhere: boolean;
  allowedIps: readonly string[];
}): { accessAnywhere: boolean; allowedIps: string[] } {
  if (input.accessAnywhere) return { accessAnywhere: true, allowedIps: [] };

  const canonical: string[] = [];
  for (const raw of input.allowedIps) {
    const rule = raw.trim();
    if (rule === '') continue;
    if (!isValidRule(rule)) {
      throw new ValidationError(
        `"${rule}" is not a valid IPv4 address or CIDR range. Use 203.0.113.7 for a ` +
          'single machine or 203.0.113.0/24 for a network.',
      );
    }
    const c = canonicaliseRule(rule)!;
    if (matchesEverything(c)) {
      throw new ValidationError(
        `${c} matches every address. Choose "Access from anywhere" instead.`,
      );
    }
    if (!canonical.includes(c)) canonical.push(c);
  }
  if (canonical.length === 0) {
    throw new ValidationError(
      'Add at least one IP address, or choose "Access from anywhere" — otherwise this ' +
        'administrator could not sign in at all.',
    );
  }
  if (canonical.length > MAX_ALLOWED_IPS) {
    throw new ValidationError(`An administrator can have at most ${MAX_ALLOWED_IPS} IP addresses.`);
  }
  return { accessAnywhere: false, allowedIps: canonical };
}

/**
 * THE WAY BACK IN. `ADMIN_IP_ALLOWLIST_ENABLED=false` stops enforcement without
 * touching a single row.
 *
 * The guard can only see the address of whoever opened the socket. In local
 * development that is the Next.js rewrite, so the API reports `::1` while the
 * operator sees their own public address in a browser. In production it is
 * whatever `TRUSTED_PROXY_HOPS` resolves to, which is right when configured and
 * silently wrong when it is not. And an address that changes overnight (a
 * dynamic line, a dropped VPN) can lock out the one administrator who could fix
 * everyone else's.
 *
 * So: an environment variable, recoverable by whoever can restart the process,
 * needing no database client, and leaving every administrator's addresses in
 * place to be re-enabled once the address is right.
 */
export function ipAllowlistEnforced(): boolean {
  return process.env['ADMIN_IP_ALLOWLIST_ENABLED'] !== 'false';
}
