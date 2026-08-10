import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * Authenticates the MT5 bridge, and nothing else.
 *
 * ── Why this is not `AdminGuard` or `JwtAuthGuard` ─────────────────────────
 *
 * The bridge is not a person and holds no session. It is one service on a
 * private network with one credential, exactly as ARCHITECTURE §3.1 specifies:
 * "mTLS or a shared secret header between bridge and API — never expose it
 * publicly." Handing it an admin account instead would put a login that can
 * approve withdrawals into a config file on a Windows box, to authenticate a
 * caller that only ever posts deals.
 *
 * ── The comparison is fixed-time ───────────────────────────────────────────
 *
 * `===` on strings returns at the first differing byte, so how long a rejection
 * takes leaks how much of the secret was right — recoverable byte by byte given
 * enough attempts, and this endpoint is reachable from wherever the bridge is.
 * The length check first is safe to short-circuit: the length of a secret is not
 * the secret.
 */
@Injectable()
export class BridgeSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('MT5_BRIDGE_SECRET');

    /*
     * An unconfigured secret DENIES rather than allows.
     *
     * The opposite — treating "no secret set" as "no authentication required" —
     * is how an ingestion endpoint that writes to the ledger ends up open on a
     * deployment where somebody forgot an environment variable, with nothing in
     * any log to say so.
     */
    if (!expected) {
      throw new UnauthorizedException('The MT5 bridge secret is not configured on this server.');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const presented = request.headers['x-bridge-secret'];

    if (typeof presented !== 'string' || presented.length !== expected.length) {
      throw new UnauthorizedException('Invalid or missing X-Bridge-Secret.');
    }

    if (!timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
      throw new UnauthorizedException('Invalid or missing X-Bridge-Secret.');
    }

    return true;
  }
}
