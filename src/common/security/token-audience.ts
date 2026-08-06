/**
 * Who each token is for — PLATFORM-CONVENTIONS R-3.1.
 *
 * The two auth surfaces are already separated by distinct signing secrets, which
 * is cryptographically sufficient TODAY. These claims exist because that
 * separation rests entirely on three environment variables staying distinct: the
 * day someone reuses one — in a deploy script, a staging shortcut, a rushed
 * rotation — an admin token silently becomes valid on the client portal and
 * nothing anywhere notices.
 *
 * With `aud` verified, that mistake produces a failed login instead of a
 * privilege escalation. It is defence against a config error, not against an
 * attacker, and that is exactly the kind of error worth defending against.
 */
export const TOKEN_ISSUER = 'oxshare-crm-api';

export const TOKEN_AUDIENCE = {
  admin: 'oxshare-crm-admin',
  portal: 'oxshare-crm-portal',
} as const;

/**
 * WHAT each token is, as opposed to who it is for.
 *
 * The bug this closes, on the admin surface: access and refresh tokens were
 * signed with the same `ADMIN_JWT_SECRET`, carried the same `aud` and `iss`, and
 * both carried `sub`. `AdminAuthenticator` verified signature, audience, issuer
 * and then read `sub` — so nothing anywhere distinguished the two kinds, and an
 * admin **refresh** token was accepted as an **access** token.
 *
 * That matters because their lifetimes differ by three orders of magnitude: 15
 * minutes against 30 days. A short access token exists so that leaking one is
 * survivable, and a refresh token is meant to be usable only at `/refresh`,
 * where rotation and the `jti` reuse-detection family (R-3.3) can notice a
 * stolen one. Replayed straight at a protected route it bypassed all of that,
 * for a month, leaving no trace.
 *
 * The portal was already immune — its refresh token is signed with a different
 * key, so it fails signature verification against the access secret. That is
 * the asymmetry that made this visible: two secrets on one surface, one on the
 * other, for no stated reason.
 *
 * Checked on BOTH surfaces rather than only the broken one, for the same reason
 * `aud` is: the portal's immunity rests entirely on two environment variables
 * staying distinct, and this holds even if they stop being.
 */
export const TOKEN_KIND = {
  access: 'access',
  refresh: 'refresh',
} as const;

export type TokenKind = (typeof TOKEN_KIND)[keyof typeof TOKEN_KIND];

/**
 * HOW each token is signed — and the only algorithm any verifier will accept.
 *
 * `jsonwebtoken` derives the permitted algorithms from the KEY when `algorithms`
 * is omitted: a string secret restricts it to the HS family, so `alg: none` is
 * already refused today and HS/RS confusion is not reachable. That safety is a
 * property of the key type, not of anything written down — and it evaporates the
 * moment a secret becomes a `KeyObject` or a PEM, which is exactly what an
 * asymmetric migration or a KMS integration does.
 *
 * So the allow-list is stated rather than inherited. A verifier that names its
 * algorithm cannot be talked into another one by a token that asks nicely, and
 * the day someone introduces an RSA key the failure is a refused token instead
 * of a signature check that trusts the attacker's choice of `alg`.
 *
 * One array, exported, because seven call sites verifying with seven local
 * spellings is how six of them get updated and the seventh does not.
 */
export const TOKEN_ALGORITHM = 'HS256' as const;
export const TOKEN_ALGORITHMS: [typeof TOKEN_ALGORITHM] = [TOKEN_ALGORITHM];

/**
 * Leeway, in seconds, on every `exp`/`iat` comparison.
 *
 * There was none, at any of the six verification sites. With a fifteen-minute
 * access token that is not a rounding concern: clocks between two API replicas,
 * or between a replica and the database host, drift by seconds routinely and by
 * minutes when NTP is misconfigured — and the symptom is intermittent 401s that
 * reproduce for nobody and look like a session bug.
 *
 * Thirty seconds is deliberately small. It widens every token's effective life
 * by that much, which is the cost, and it is far below the fifteen minutes the
 * access token lives anyway. Anything larger would start to matter for
 * revocation; anything smaller does not cover real-world skew.
 *
 * Stated in ONE place so the six sites cannot drift apart — the same reason
 * `TOKEN_ALGORITHMS` is here rather than written out per call.
 */
export const TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

/**
 * True when a verified payload is the kind of token the caller expected.
 *
 * Deliberately strict: a token with no `typ` at all is refused. Tokens minted
 * before this claim existed therefore stop working, which forces a re-login —
 * correct here, because the alternative is accepting an unlabelled token
 * forever and keeping the hole open for the full 30-day refresh lifetime. There
 * are no production sessions to preserve; the system has not launched.
 */
export function isTokenKind(payload: { typ?: unknown }, expected: TokenKind): boolean {
  return payload.typ === expected;
}
