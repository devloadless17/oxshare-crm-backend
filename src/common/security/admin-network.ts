import { ipMatchesAny } from './ip-range';

/**
 * RBAC-08's decision, in one place: may a caller at `ip` exercise ADMIN
 * authority, given the configured allowlist?
 *
 * Extracted from `IpAllowlistGuard` because the guard is not the only place
 * that has to ask. The guard covers the `/admin` surface by path, which is the
 * right default and misses one route that matters: `GET /uploads/kyc/:file`
 * lives under `/uploads` and serves a client's passport, national ID and proof
 * of address to any admin holding `kyc.documents.view`. Every client's identity
 * documents were readable from any network on earth with a valid admin session,
 * while the allowlist reported itself as enforcing.
 *
 * That route cannot simply be added to the guard's path test: it serves BOTH
 * surfaces — a client fetching their own document, and an admin fetching
 * anyone's — and putting a network restriction on the client's path would lock
 * customers out of their own files. Which principal is acting is only known
 * after authorization, so the check has to happen there, with this function as
 * the shared definition of the rule (PLATFORM-CONVENTIONS R-4.3: the guard is a
 * fast reject at the edge, not the only check).
 *
 * BOTH properties below are load-bearing and must survive any refactor:
 *
 *   1. An EMPTY list means the feature is OFF. The deploy that created the
 *      table must not lock every administrator out before anyone can add a rule
 *      (DECISIONS D-10). Enforcement begins with the first row.
 *   2. A NON-EMPTY list DENIES an unknown address. Once someone has said "only
 *      these addresses", failing open on a caller we cannot identify defeats
 *      the entire point — so `undefined` is a denial, not a pass.
 */
export function adminNetworkAdmits(rules: readonly string[], ip: string | undefined): boolean {
  if (!ipAllowlistEnforced()) return true; // (0) switched off by configuration
  if (rules.length === 0) return true; // (1) not configured
  return ipMatchesAny(ip, rules); // (2) `ipMatchesAny(undefined, …)` is false
}

/**
 * THE WAY BACK IN. `ADMIN_IP_ALLOWLIST_ENABLED=false` stops enforcement without
 * touching a single row.
 *
 * This feature was deleted once because it caused problems in practice, and the
 * shape of that problem is inherent rather than a bug: the guard can only see
 * the address of whoever opened the socket. In local development that is the
 * Next.js rewrite, so the API correctly reports `::1` while the operator is
 * looking at their own public address in a browser — and a rule for the address
 * they can see is a rule the server can never match. In production it is
 * whatever `TRUSTED_PROXY_HOPS` resolves to, which is right when configured and
 * silently wrong when it is not.
 *
 * The lockout protections in the service refuse the two rules that would lock
 * you out AT THE MOMENT YOU WRITE THEM, and they cannot help with what happens
 * afterwards: a dynamic address changing overnight, a VPN dropping, a laptop
 * moving office. Without an escape hatch the only recovery is a `DELETE` on the
 * table by somebody with database access — during an incident, which is exactly
 * when nobody has it.
 *
 * So: an environment variable, because it is recoverable by whoever can restart
 * the process, needs no database client, and leaves the rules in place to be
 * re-enabled once the address is right. It is reported on the status endpoint so
 * the console can SAY enforcement is off — a screen claiming to protect a system
 * it is not protecting is the failure mode this whole feature exists to avoid.
 */
export function ipAllowlistEnforced(): boolean {
  return process.env['ADMIN_IP_ALLOWLIST_ENABLED'] !== 'false';
}
