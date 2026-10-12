/*
 * How long an admin session's tokens live — the idle rule (12 Oct 2026).
 *
 * The owner's rule: an administrator who does NOTHING on the console for the
 * idle window (15 minutes) signs in again; one who is working is never signed
 * out. "Doing something" is input in the browser — a mouse, a key, a scroll —
 * which only the console can see, so the console measures the idle age and
 * reports it with every refresh, and THIS decides what that buys:
 *
 *   refresh token  = window − idle + grace
 *   access token   = the same, never more than fifteen minutes
 *
 * So both tokens die at "last activity + window (+ grace)" on the SERVER. A
 * closed laptop, a killed browser and a sleeping tab are signed out with no
 * JavaScript running; the console's own timer is the courtesy, this is the rule.
 *
 * The idle age is a DURATION, not a timestamp, so a wrong clock on the
 * administrator's machine changes nothing.
 *
 * It is the console's word, and that is the right trust: the threat is an
 * unattended, unlocked console, which runs OUR code. Somebody who can forge the
 * report already holds the session cookie, and an idle timeout was never the
 * control for that — rotation, reuse detection and the network allowlist are.
 *
 * Pure, so the arithmetic is tested without a database.
 */

/** R-3.3: revocation must mean something within fifteen minutes, idle rule or not. */
export const ADMIN_ACCESS_CEILING_MS = 15 * 60 * 1000;

/**
 * The console signs out AT the window; the server a minute later. Without the
 * gap, an administrator returning at 14:59 would move the mouse, the console
 * would ask to renew, and the token would already be dead on arrival.
 */
export const ADMIN_IDLE_GRACE_MS = 60 * 1000;

export interface AdminSessionLifetimes {
  accessMs: number;
  refreshMs: number;
}

/**
 * The lifetimes a sign-in or a refresh buys, or `null` when the reported idle
 * age has already used up the window — that session is over.
 *
 * `idleSeconds` absent or nonsense reads as 0: a console from before this rule
 * sends nothing, and it must keep working until the new one is deployed.
 */
export function adminSessionLifetimes(
  windowMs: number,
  idleSeconds?: number | null,
): AdminSessionLifetimes | null {
  const reported = typeof idleSeconds === 'number' && idleSeconds > 0 ? idleSeconds : 0;
  const idleMs = reported * 1000;
  if (idleMs >= windowMs) return null;
  const refreshMs = windowMs - idleMs + ADMIN_IDLE_GRACE_MS;
  return { accessMs: Math.min(ADMIN_ACCESS_CEILING_MS, refreshMs), refreshMs };
}
