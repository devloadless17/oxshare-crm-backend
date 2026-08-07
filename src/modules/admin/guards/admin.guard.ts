import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Admin, AdminsStore } from '../../../store/admins.store';
import { RolesStore } from '../../../store/roles.store';
import { Request } from 'express';
import { COOKIE_BASES, readSessionCookie } from '../../../common/security/session-cookies';
import {
  isTokenKind,
  TOKEN_ALGORITHMS,
  TOKEN_CLOCK_TOLERANCE_SECONDS,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_KIND,
} from '../../../common/security/token-audience';
import { normalizePermissionKey } from '../../../common/security/actor';
import { AdminClientScopesStore } from '../../../store/admin-client-scopes.store';
import { RefreshTokensService } from '../../../common/security/refresh-tokens.service';
import { ClientFieldsService } from '../client-fields.service';
import { UNRESTRICTED, type ClientScope } from '../../../common/security/client-scope';
import { EMPTY_MASK, type FieldMask } from '../../../common/security/field-mask';

/**
 * Whether this admin is exempt from scoping and masking entirely.
 *
 * Checks BOTH the role column and the `*` wildcard. They agree today, and the
 * check is cheap; if they ever diverge, the safe reading of "is this the
 * unrestricted account" is the permissive one, because the alternative is a
 * master admin locked out of the client base by a stale scope row.
 */
function isMaster(admin: Admin, permissions: readonly string[]): boolean {
  return admin.role === 'master_admin' || permissions.includes('*');
}

/**
 * An admin as every downstream service should see them: identity plus the
 * three things that decide what they may do and see, all resolved LIVE on this
 * request.
 *
 * The type exists to make forgetting impossible rather than merely unlikely.
 * A service method that filters by client scope, or strips masked fields,
 * declares `actor: AuthenticatedAdmin` — and TypeScript then refuses a call
 * site that hands it a bare `Admin` from a store. The plumbing is enforced by
 * the compiler; the coverage tests enforce that the plumbing is used.
 */
export interface AuthenticatedAdmin extends Admin {
  /** Live from the role — editing a role takes effect on the next request. */
  permissions: string[];
  /** Which clients this admin may see at all. Empty scope = unrestricted. */
  clientScope: ClientScope;
  /** Client fields this admin may not see, already expanded with aliases. */
  fieldMask: FieldMask;
}

type AdminRequest = Request & { admin?: AuthenticatedAdmin };

/**
 * Cookie → admin, with permissions, client scope and field mask resolved live.
 *
 * Shared by all three guards below; a service so the stores arrive by
 * injection rather than being reached for from a module-level singleton.
 *
 * All three resolve HERE, in one place, on the request that will use them.
 * Resolving them per call site would mean a new endpoint could reasonably
 * resolve two of the three and look complete.
 */
@Injectable()
export class AdminAuthenticator {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly admins: AdminsStore,
    private readonly roles: RolesStore,
    private readonly scopes: AdminClientScopesStore,
    private readonly clientFields: ClientFieldsService,
    private readonly refreshTokens: RefreshTokensService,
  ) {}

  async authenticate(req: AdminRequest): Promise<AuthenticatedAdmin> {
    const token = readSessionCookie(
      req.cookies as Record<string, string | undefined> | undefined,
      COOKIE_BASES.adminAccess,
    );
    if (!token) throw new UnauthorizedException('Admin authentication required.');

    let adminId: string;
    let familyId: string | undefined;
    try {
      const payload = this.jwt.verify<{
        sub: string;
        role: string;
        typ?: string;
        fam?: string;
      }>(token, {
        secret: this.config.getOrThrow<string>('ADMIN_JWT_SECRET'),
        // R-3.1: a portal token must be worthless here, and vice versa. The
        // distinct secrets already ensure that; this survives them being mixed up.
        audience: TOKEN_AUDIENCE.admin,
        issuer: TOKEN_ISSUER,
        // Stated, never inherited from the key type — see token-audience.ts.
        algorithms: TOKEN_ALGORITHMS,
        clockTolerance: TOKEN_CLOCK_TOLERANCE_SECONDS,
      });
      // The admin surface signs both kinds with ONE secret, so signature +
      // audience cannot tell them apart. Without this check a 30-day refresh
      // token authenticates here as a 15-minute access token, skipping rotation
      // and reuse detection entirely (token-audience.ts).
      if (!isTokenKind(payload, TOKEN_KIND.access)) {
        throw new UnauthorizedException('Invalid or expired admin token.');
      }
      adminId = payload.sub;
      familyId = payload.fam;
    } catch (error) {
      /*
       * An EXPIRED token is not an invalid one, and the difference is the whole
       * reason the client can tell "renew" from "sign out" (R-2.3 / the
       * `TOKEN_EXPIRED` code). Every 401 used to look identical here, so the
       * admin console had to guess, and guessed wrong in both directions.
       *
       * `jsonwebtoken` names the expiry case, and only that case.
       */
      const expired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new UnauthorizedException({
        message: expired ? 'Admin session has expired.' : 'Invalid or expired admin token.',
        code: expired ? 'TOKEN_EXPIRED' : 'SESSION_REVOKED',
      });
    }

    const admin = await this.admins.findById(adminId);
    if (!admin) throw new UnauthorizedException('Admin not found.');
    /*
     * Suspension takes effect on the NEXT REQUEST — a live token is no shield.
     *
     * This is what makes the 15-minute access token worth its round trips: the
     * admin row is already loaded here to resolve permissions, so checking a
     * status column costs nothing and turns "suspend this administrator" into
     * something that happens now rather than whenever their token expires.
     *
     * Without it the only way to cut off an admin was to delete the row, which
     * destroys the subject every audit entry points at. jwt.strategy.ts has done
     * exactly this for portal users since it was written.
     */
    if (admin.status === 'suspended') {
      throw new UnauthorizedException({
        message: 'This administrator account has been suspended.',
        code: 'SESSION_REVOKED',
      });
    }

    /*
     * Has this LOGIN been ended? — the check the `fam` claim exists for.
     *
     * Without it, revocation reached the refresh family and stopped there: the
     * access token minted from a now-dead login went on authenticating every
     * request until it expired on its own. So "sign out that device" was a
     * promise kept fifteen minutes late, and refresh-token reuse detection —
     * which exists precisely to lock an attacker out NOW — left the attacker's
     * access token working for the rest of its life.
     *
     * The portal has done this since 6 Aug (`jwt.strategy.ts`). This surface can
     * approve payouts and did not.
     *
     * A token with no `fam` predates this change and cannot be checked, so it is
     * refused rather than trusted: failing open here would mean the control does
     * not exist for exactly the sessions issued before it shipped.
     */
    if (!familyId) {
      throw new UnauthorizedException({
        message: 'Session has been revoked. Please log in again.',
        code: 'SESSION_REVOKED',
      });
    }
    if (await this.refreshTokens.familyIsRevoked('admin', familyId)) {
      throw new UnauthorizedException({
        message: 'Session has been revoked. Please log in again.',
        code: 'SESSION_REVOKED',
      });
    }
    // Role-derived permissions resolve live: editing a role takes effect on the
    // next request from every admin holding it — no re-login, no stale grants.
    const permissions = await this.roles.resolvePermissions(admin.roleId, admin.permissions);

    /*
     * A master admin is unrestricted, and this branch is BEFORE the lookups
     * rather than after them.
     *
     * FR-RBAC-01 is "the full set of administrative permissions, with access to
     * every administration section and operation WITHOUT EXCEPTION". Reading a
     * scope or a mask for them and then ignoring it would leave a stored value
     * that looks meaningful, and the next person to add an enforcement point
     * would reasonably honour it. There is nothing to honour, so there is
     * nothing to read.
     */
    if (isMaster(admin, permissions)) {
      return { ...admin, permissions, clientScope: UNRESTRICTED, fieldMask: EMPTY_MASK };
    }

    // Both resolve live, for the same reason permissions do: revoking a
    // territory or hiding a field must take effect on the next request, not
    // whenever a 15-minute token happens to expire.
    const [clientScope, storedMask] = await Promise.all([
      this.scopes.scopeFor(admin.id),
      this.roles.resolveMaskedFields(admin.roleId, admin.maskedFields),
    ]);

    return {
      ...admin,
      permissions,
      clientScope,
      // Expanded here, once, so no enforcement point has to remember that
      // hiding `client.phone` must also hide `personalInfo.phone` on the KYC
      // screen — the bypass that would otherwise be one tab away.
      fieldMask: this.clientFields.expand(storedMask),
    };
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly authenticator: AdminAuthenticator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    req.admin = await this.authenticator.authenticate(req);
    return true;
  }
}

// Per ARCHITECTURE §8.8 a permission failure is a 403, never a 401 — a 401
// makes the admin client treat the session as dead and log the admin out.
@Injectable()
export class MasterAdminGuard implements CanActivate {
  constructor(private readonly authenticator: AdminAuthenticator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const admin = await this.authenticator.authenticate(req);

    /*
     * `isMaster`, NOT `role === 'master_admin'`.
     *
     * This guard read the enum column alone, while `isMaster()` above accepts
     * EITHER the enum or the `*` wildcard. That divergence was survivable only
     * while every unrestricted account carried both — and it stops being
     * survivable the moment full access is something a ROLE grants rather than
     * something the bootstrap column hardcodes.
     *
     * The failure it produces is silent and badly timed: an admin holding `*`
     * passes every `PermissionsGuard` route, so they look fully privileged,
     * then gets a bare 403 from the twelve routes behind THIS guard — the audit
     * log, reconciliation, SMTP, the security settings. Which is to say, the
     * ones you reach for when something has already gone wrong.
     *
     * `isMaster` documents why the permissive reading is the right one: the
     * alternative is an unrestricted account locked out of the controls it
     * exists to operate.
     */
    if (!isMaster(admin, admin.permissions)) {
      throw new ForbiddenException('Master admin access required.');
    }
    req.admin = admin;
    return true;
  }
}

export const PERMISSIONS_KEY = 'required_permissions';

/**
 * "Any authenticated admin may do this" — stated, not assumed.
 *
 * The reason is required so the next reader sees a decision rather than an
 * omission (PLATFORM-CONVENTIONS R-4.2).
 */
export const ANY_ADMIN_KEY = 'any_admin';
export const AnyAdmin = (reason: string) => SetMetadata(ANY_ADMIN_KEY, reason);

/** Route decorator: any ONE of the listed permissions grants access ('*' always does). */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

// One spelling, from one definition — see normalizePermissionKey. This file
// used to declare its own copy; common/security/actor.ts declared another that
// still rewrote `:` to `.`, so the two disagreed and a stored `kyc:review` was
// refused here and accepted at the service layer.

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly authenticator: AdminAuthenticator,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const admin = await this.authenticator.authenticate(req);
    req.admin = admin;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    /*
     * DENY BY DEFAULT — PLATFORM-CONVENTIONS R-4.2.
     *
     * This used to be `if (!required) return true`, which meant a controller
     * decorated with @UseGuards(PermissionsGuard) but no @RequirePermissions
     * admitted ANY authenticated admin. Coverage happened to be complete, but by
     * discipline: an endpoint that forgot the decorator was indistinguishable
     * from one that never needed it, and reviewing a diff cannot tell them
     * apart. That is how a money-moving route ends up open on a busy Friday.
     *
     * Now the absence of a declaration is a refusal. A route that genuinely
     * needs no more than "is an authenticated admin" says so with @AnyAdmin(),
     * which is a decision someone wrote down rather than one nobody made.
     */
    if (!required || required.length === 0) {
      if (
        this.reflector.getAllAndOverride<string>(ANY_ADMIN_KEY, [
          context.getHandler(),
          context.getClass(),
        ])
      ) {
        return true;
      }
      throw new ForbiddenException(
        'This action declares no required permission. Add @RequirePermissions(...) or, if any ' +
          'authenticated admin may perform it, @AnyAdmin() with a reason.',
      );
    }

    if (admin.permissions.includes('*')) return true;
    const held = new Set(admin.permissions.map(normalizePermissionKey));
    if (required.some((p) => held.has(normalizePermissionKey(p)))) return true;

    throw new ForbiddenException(
      `Missing permission: this action requires ${required.join(' or ')}.`,
    );
  }
}
