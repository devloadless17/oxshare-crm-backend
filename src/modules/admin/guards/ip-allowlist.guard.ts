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

    const rules = await this.allowlist.listCidrs();
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
