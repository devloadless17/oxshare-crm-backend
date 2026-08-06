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
  if (rules.length === 0) return true; // (1) not configured
  return ipMatchesAny(ip, rules); // (2) `ipMatchesAny(undefined, …)` is false
}
