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
import { adminNetworkAdmits } from '../../../common/security/admin-network';
import { isAdminSurface } from '../../../common/api-prefix';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';

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

  constructor(private readonly allowlist: AdminIpAllowlistStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();

    // Match on the ROUTE, never on a literal path, and never case-sensitively:
    // the `/v1` prefix already turned one such comparison false and silently
    // disarmed CSRF on every admin write, and a single uppercase letter later
    // did the same thing to THIS guard. `isAdminSurface` is the one definition
    // both guards share — see common/api-prefix.ts.
    if (!isAdminSurface(req.path)) return true;

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

    const ip = clientIp(req);
    // The decision itself lives in `common/security/admin-network.ts`, because
    // this guard is not the only caller: `GET /uploads/kyc/:file` serves client
    // PII to admins from outside the `/admin` path and has to ask the same
    // question after it knows which principal is acting.
    if (adminNetworkAdmits(rules, ip)) return true;

    // Logged because a legitimate admin locked out by a bad rule needs to be
    // diagnosable, and because repeated denials are worth seeing. The address is
    // the whole point of the record, so it is not redacted here.
    this.logger.warn(
      `Admin request from ${ip ?? 'an unknown address'} refused: not in the IP allowlist ` +
        `(${rules.length} rule(s) configured).`,
    );
    throw new ForbiddenException('Your network is not permitted to reach the administration API.');
  }
}
