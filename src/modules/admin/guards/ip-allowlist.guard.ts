import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminIpAllowlistStore } from '../../../store/admin-ip-allowlist.store';
import { clientIp } from '../../../common/security/client-ip';
import { adminNetworkAdmits, NETWORK_REFUSED } from '../../../common/security/admin-network';
import { isAdminSurface, stripApiPrefix } from '../../../common/api-prefix';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';
import { readApiKeyHeader } from '../../../common/security/api-key';
import { COOKIE_BASES, readSessionCookie } from '../../../common/security/session-cookies';
import { AdminAuthenticator } from './admin.guard';

/**
 * The sign-in doors, open from ANY network once the list is enforcing.
 *
 * An exempt administrator (0192) must be able to sign in from anywhere, and who
 * is signing in is only known once their credentials are checked — so these
 * pass the guard and the SERVICE decides (`AdminAuthService.login`, the
 * authenticator steps, `refresh`), telling an outside caller nothing but the
 * next sign-in step or the one network refusal. Exact, lower-cased paths: a spelling not listed here
 * gets the stricter answer, which is the safe direction to be wrong in.
 * Completing a password reset is here too, so the exempt owner abroad can
 * spend a reset link; the service admits only an exempt administrator's.
 */
const OUTSIDE_SIGN_IN_PATHS: ReadonlySet<string> = new Set([
  '/admin/auth/login',
  // The authenticator steps carry a challenge, not a session; each re-judges
  // the network once it knows whose challenge it is (0191's sign-in).
  '/admin/auth/totp/setup',
  '/admin/auth/totp/verify',
  '/admin/auth/refresh',
  '/admin/password-reset/complete',
  // Ending a session grants nothing, and identifies by the refresh cookie — so
  // an administrator who carried a laptop home can still sign out of it.
  '/admin/auth/logout',
]);

/**
 * Token routes that stay INSIDE the listed networks whatever cookies come
 * with them. They act on an invite token, never on a session — so an exempt
 * administrator's session cookie in the same browser must not vouch for them.
 * A new administrator's first sign-in happens on an office network.
 */
const INSIDE_ONLY_TOKEN_PATHS: ReadonlySet<string> = new Set([
  '/admin/invite/validate',
  '/admin/invite/accept',
]);

/**
 * RBAC-08 — the admin surface answers only from allowlisted addresses.
 *
 * Registered globally rather than per-route, for the same reason `CsrfGuard` is:
 * an endpoint that forgets to opt IN is indistinguishable from one that never
 * needed it, and that is how a money-moving route ends up unprotected. Here the
 * default is protection and the exceptions are explicit and few.
 *
 * TWO PROPERTIES THAT MUST NOT BE "SIMPLIFIED" LATER:
 *
 * 1. **An empty list disables the feature.** The deploy that creates the table
 *    must not lock every administrator out of the system before anyone can add a
 *    rule (DECISIONS D-10). Enforcement begins with the first row.
 *
 * 2. **A non-empty list denies an unknown address.** Once someone has said "only
 *    these addresses", failing open on a caller we cannot identify would defeat
 *    the entire point.
 *
 * Only the ADMIN surface. The portal is public by nature; an allowlist there
 * would lock out the customers it exists to serve.
 *
 * This is defence in depth, not the primary control. A network-level restriction
 * is stronger where it is available — it keeps traffic off the process entirely.
 * This exists because the client manages the list from the admin UI, and infra
 * rules need a deploy.
 */
@Injectable()
export class IpAllowlistGuard implements CanActivate {
  private readonly logger = new Logger(IpAllowlistGuard.name);
  /**
   * When the fail-open alarm was last raised.
   *
   * The read fails per REQUEST, so an unreachable table alarms on every one of
   * them — and an alarm that fires a thousand times a minute is muted, taking
   * the real incidents with it. Same throttle, for the same reason, as
   * `RedisThrottlerStorage.warnOnce`.
   */
  private lastAlertedAt = 0;

  constructor(
    private readonly allowlist: AdminIpAllowlistStore,
    /** Identifies the session on a refused address, to ask whether it is exempt. */
    private readonly authenticator: AdminAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();

    // Match on the ROUTE, never on a literal path, and never case-sensitively:
    // the `/v1` prefix already turned one such comparison false and silently
    // disarmed CSRF on every admin write, and a single uppercase letter later
    // did the same thing to THIS guard. `isAdminSurface` is the one definition
    // both guards share — see common/api-prefix.ts.
    if (!isAdminSurface(req.path)) return true;
    if (await this.admitsAddress(clientIp(req))) return true;

    /*
     * OUTSIDE the listed networks. Before 0192 that was the end of it; now an
     * EXEMPT administrator's session passes. Four cases, in this order:
     */
    const path = stripApiPrefix(req.path).toLowerCase();
    // 1. A sign-in door — judged by the service, once it knows who is asking.
    //    An invite route is never admitted from outside, by any credential.
    if (OUTSIDE_SIGN_IN_PATHS.has(path)) return true;
    if (INSIDE_ONLY_TOKEN_PATHS.has(path)) return this.refuse(req);
    // 2. An API key is never exempt. Refused even beside an exempt admin's
    //    cookie: `AdminGuard` prefers the key, so admitting the cookie here
    //    would carry the KEY past the network check.
    if (readApiKeyHeader(req)) return this.refuse(req);
    // 3. No session at all — today's answer, so a scanner sees nothing new.
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    if (!readSessionCookie(cookies, COOKIE_BASES.adminAccess)) return this.refuse(req);
    // 4. A session. An invalid or expired one throws its own 401 here, on
    //    purpose: the console then refreshes, and the refresh door judges the
    //    network. A 403 instead would strand an exempt admin whose 15-minute
    //    token lapsed.
    const admin = await this.authenticator.authenticateSession(req);
    if (await this.isExempt(admin.id)) return true;
    return this.refuse(req);
  }

  /**
   * RBAC-08 for one request already known to be an ADMIN request — the rule
   * the guard applies by path, callable by the `/uploads` file routes, which
   * sit outside `/admin` and only learn after authentication that an admin is
   * asking. One implementation, so the route and the guard cannot disagree
   * (fail-open paging included). Resolves `true` or throws 403.
   *
   * @param adminId the authenticated SESSION's administrator, when there is
   *   one — an exempt administrator (0192) is admitted from any address.
   */
  async assertAdmitted(req: Request, adminId?: string): Promise<boolean> {
    if (await this.admitsAddress(clientIp(req))) return true;
    if (adminId !== undefined && (await this.isExempt(adminId))) return true;
    return this.refuse(req);
  }

  /**
   * Whether `adminId`, calling from `ip`, may use the console: the address is
   * admitted, or the administrator is exempt. The sign-in services' question.
   */
  async admitsAdmin(ip: string | undefined, adminId: string): Promise<boolean> {
    return (await this.admitsAddress(ip)) || this.isExempt(adminId);
  }

  /**
   * Is this administrator exempt from the network check (0192)?
   *
   * FAILS CLOSED, the opposite of the rules read below, and both are right: an
   * unreadable LIST is no configured restriction, so the console stays
   * reachable; an unreadable EXEMPTION is no grant, so the administrator is
   * treated as everyone else is. Neither can lock the console: inside the
   * listed networks this question is never asked.
   */
  async isExempt(adminId: string): Promise<boolean> {
    try {
      return await this.allowlist.isExempt(adminId);
    } catch (error) {
      this.logger.error(
        `RBAC-08 could not read the exemptions; treating admin ${adminId} as not exempt. ` +
          `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private refuse(req: Request): never {
    // Logged because a legitimate admin locked out by a bad rule needs to be
    // diagnosable, and because repeated denials are worth seeing. The address is
    // the whole point of the record, so it is not redacted here.
    const ip = clientIp(req);
    this.logger.warn(
      `Admin request from ${ip ?? 'an unknown address'} refused: not in the IP allowlist.`,
    );
    throw new ForbiddenException(NETWORK_REFUSED);
  }

  /**
   * Does the configured list admit `ip`? `true` when it is empty, switched off,
   * or cannot be read (see below).
   */
  async admitsAddress(ip: string | undefined): Promise<boolean> {
    /*
     * A GUARD MUST NOT BE ABLE TO TAKE THE CONSOLE DOWN.
     *
     * This runs on every admin request, including the login that would let
     * somebody fix it. When the table is missing — migrations pending on a
     * deploy, a restored backup, the ordering between `npm run dev` and
     * `npm run db:migrate` — the query throws, and without this catch EVERY
     * admin request answers 500. Including `POST /admin/auth/login`. Nobody can
     * sign in to the console that manages the allowlist, and the error names a
     * table most people reading it have never heard of.
     *
     * That is not hypothetical: it happened the first time this guard was
     * restored, and a browser found it within a minute of the unit suite being
     * entirely green — 1792 backend tests pass against a migrated database and
     * none of them models one that is behind.
     *
     * SO IT FAILS OPEN, LOUDLY. An unreadable list is not a configured
     * restriction: it is the same "not configured" state an empty list already
     * means, and the same answer this guard gives before anybody adds a rule.
     * Failing closed would mean an infrastructure error locks every
     * administrator out of the only place the setting can be changed.
     *
     * This is defence in depth behind an edge rule, which is where a network
     * restriction that must survive an application fault belongs — so trading a
     * window of non-enforcement for a console that stays reachable is the right
     * way round. The log line is ERROR, not WARN, because a security control
     * that is not running is worth waking somebody for.
     */
    let rules: string[];
    try {
      rules = await this.allowlist.listCidrs();
    } catch (error) {
      /*
       * RAISED, not only logged — which is what the paragraph above already
       * argued for and did not do.
       *
       * "The log line is ERROR, not WARN, because a security control that is
       * not running is worth waking somebody for" — and an ERROR line wakes
       * nobody. `RedisThrottlerStorage` makes the identical fail-open argument
       * and raises `SECURITY_CONTROL_DISABLED` at `page`; this one made the
       * argument and stopped. Two global guards, the same deliberate decision to
       * fail open, and only one of them told anybody.
       *
       * `page` rather than `notify` for the same reason the throttler pages:
       * the control is off, every admin request is being admitted regardless of
       * network, and nothing else in the system will notice.
       */
      const now = Date.now();
      if (now - this.lastAlertedAt >= 60_000) {
        this.lastAlertedAt = now;
        raiseAlert(
          this.logger,
          ALERT_KINDS.SECURITY_CONTROL_DISABLED,
          'page',
          'RBAC-08 is DEGRADED: the IP allowlist cannot be read, so it is not being enforced ' +
            'and every admin request is admitted regardless of network.',
          {
            control: 'ip-allowlist',
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      this.logger.error(
        'RBAC-08 could not read the IP allowlist, so it is NOT being enforced for this request. ' +
          'Every admin request is being admitted regardless of network. This usually means ' +
          'migrations are pending — run `npm run db:migrate`. ' +
          `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }

    // The decision itself lives in `common/security/admin-network.ts`, because
    // this guard is not the only caller: `GET /uploads/kyc/:file` serves client
    // PII to admins from outside the `/admin` path and has to ask the same
    // question after it knows which principal is acting.
    return adminNetworkAdmits(rules, ip);
  }
}
