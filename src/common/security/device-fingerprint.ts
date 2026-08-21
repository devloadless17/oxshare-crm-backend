import type { Request } from 'express';
import type { DeviceFingerprint } from './refresh-tokens.service';

/**
 * What the request looked like, for the session list to show back.
 *
 * `req.ip` is Express's, which respects `trust proxy`, so behind a load
 * balancer this is the client address rather than the balancer's.
 *
 * Truncated to the column width rather than rejected: refusing a login because
 * somebody sent a 900-character User-Agent would be an availability bug wearing
 * a validation costume.
 *
 * ONE definition for BOTH surfaces. The portal had this and the admin console
 * did not — `AdminAuthService` never passed a device to `record`/`rotate`, so
 * `GET /admin/auth/sessions` answered `userAgent: null, ip: null` for every
 * row, and the one control for noticing "I am signed in somewhere I am not"
 * showed nothing on the console that approves payouts.
 */
export function deviceOf(req: Request): DeviceFingerprint {
  const ua = req.get('user-agent');
  return {
    userAgent: ua ? ua.slice(0, 400) : null,
    ip: req.ip ? req.ip.slice(0, 64) : null,
  };
}
