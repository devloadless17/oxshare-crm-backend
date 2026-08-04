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
