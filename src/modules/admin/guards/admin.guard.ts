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
import { ApiKeysStore } from '../../../store/api-keys.store';
import { API_KEY_TOKEN_PREFIX, hashApiKey } from '../../../common/security/api-key';
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

/*
 * `isMaster()` is gone. Nothing is exempt from scoping and masking by identity
 * any more — an administrator with no scope rows resolves to UNRESTRICTED on the
 * ordinary path, which is the same answer the exemption gave.
 *
 * `admins.role` still exists as a column and still carries `master_admin` on
 * bootstrap accounts, because Postgres cannot drop an enum value without
 * rewriting the type under a live table. Nothing READS it after migration 0044:
 * no guard, no service and no screen branches on it. Treat it as a dead column.
 */

/**
 * The API key on this request, from `X-API-Key` or a Bearer header.
 *
 * Both accepted because integrations arrive with both habits, and refusing one
 * buys nothing. `Authorization: Bearer` is only read when the value carries the
 * key prefix — otherwise a portal JWT sent in that header would be mistaken for
 * a key, and the caller would get "invalid API key" for what is really a
 * wrong-surface token.
 */
function readApiKeyHeader(req: AdminRequest): string | null {
  /*
   * `headers` is defaulted rather than assumed.
   *
   * Express always populates it, so this looks redundant — and it is not: this
   * function now runs FIRST on every admin request, ahead of the cookie path,
   * so anything that reaches the authenticator with a partial request object
   * crashes here with a TypeError instead of being refused with a 401. That is
   * a worse failure than the one it replaces, and it is exactly what the
   * hand-built request objects in the unit specs surfaced.
   */
  const headers = req.headers ?? {};

  const header = headers['x-api-key'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader) return fromHeader.trim();

  const auth = headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const value = auth.slice('Bearer '.length).trim();
    if (value.startsWith(API_KEY_TOKEN_PREFIX)) return value;
  }
  return null;
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
  /**
   * Which LOGIN this request is on — the `fam` claim, already verified above.
   *
   * `undefined` for an API key, which has no session: the profile screen's
   * session list then marks nothing as "this device", which is the truth.
   *
   * Carried here rather than re-decoded at the one call site that wants it. The
   * portal has to read its refresh cookie and decode an unverified jti for the
   * same answer, because its access token carries no family; this surface signs
   * the family into the access token, so the value is already verified by the
   * time it lands here.
   */
  sessionFamilyId?: string;
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
    private readonly apiKeys: ApiKeysStore,
  ) {}

  async authenticate(req: AdminRequest): Promise<AuthenticatedAdmin> {
    /*
     * An API key authenticates BEFORE the cookie path, and returns the same
     * `AuthenticatedAdmin` shape.
     *
     * That shape is the entire integration. Every downstream guard, every
     * `@RequirePermissions`, every client-scope filter and every field mask
     * reads this object and nothing else — so a key that produces it correctly
     * needs no changes anywhere else, and a key CANNOT accidentally skip a
     * check that a session is subject to. The alternative, a parallel guard
     * chain for keys, is how the two drift until one of them is missing an
     * enforcement point.
     *
     * Checked first because the two credentials are mutually exclusive in
     * practice: a machine sends a header, a browser sends a cookie. A request
     * carrying both is a browser calling an integration endpoint, and honouring
     * the explicit header is the less surprising reading.
     */
    const presentedKey = readApiKeyHeader(req);
    if (presentedKey) return this.authenticateApiKey(presentedKey);

    const token = readSessionCookie(
      req.cookies as Record<string, string | undefined> | undefined,
      COOKIE_BASES.adminAccess,
    );
    if (!token) throw new UnauthorizedException('Admin authentication required.');

    let adminId: string;
    let familyId: string | undefined;
    /** Token issue time in SECONDS, compared against the password cutoff below. */
    let issuedAt: number | undefined;
    try {
      const payload = this.jwt.verify<{
        sub: string;
        role: string;
        typ?: string;
        fam?: string;
        /** Issued-at, in SECONDS. Compared against `admins.passwordChangedAt`. */
        iat?: number;
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
      issuedAt = payload.iat;
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
     * Was this token issued BEFORE the password changed? — the cutoff.
     *
     * Revoking refresh families on a password change stops those sessions
     * RENEWING and does nothing to an access token already in a browser, which
     * keeps working for up to fifteen more minutes. On the console that
     * approves withdrawals, that is precisely the window somebody changing
     * their password under duress is trying to close.
     *
     * The comparison is `(iat + 1) * 1000 <= cutoff` rather than a plain `<`,
     * and the arithmetic matters: `iat` is in SECONDS, so a token minted in the
     * same second as the change has an `iat` that rounds DOWN below a
     * millisecond-precision cutoff and would be rejected. That token is the
     * caller's own new one. Asking whether the token's whole second ended
     * before the change spares it and rejects everything genuinely older.
     *
     * It fails CLOSED at the boundary — a token issued in the final
     * milliseconds before the cutoff is rejected, and the only one that can be
     * is the caller's pre-change token, which is being replaced on that very
     * response.
     *
     * A missing `passwordChangedAt` means NO cutoff. Every administrator
     * predating migration 0048 has one, and adding the column must not sign the
     * back office out. Mirrors `jwt.strategy.ts` on the portal.
     */
    if (
      admin.passwordChangedAt &&
      issuedAt &&
      (issuedAt + 1) * 1000 <= admin.passwordChangedAt.getTime()
    ) {
      throw new UnauthorizedException({
        message: 'Your password was changed. Please sign in again.',
        code: 'SESSION_REVOKED',
      });
    }
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
     * There is no master bypass here any more.
     *
     * This used to short-circuit before the two lookups below: a master admin
     * was UNRESTRICTED and EMPTY_MASK by definition, so reading a scope or a
     * mask for them would have left a stored value that looks meaningful and
     * is ignored.
     *
     * Removing it changes nothing for those accounts, and that is worth stating
     * because it looks like it should. An administrator with no rows in
     * `admin_client_tag_scopes` resolves to UNRESTRICTED anyway — an empty scope
     * means every client, by RBAC-08 and D-10 — and a role with no masked fields
     * resolves to an empty mask. The bypass was an optimisation over a lookup
     * that already returned the same answer, not a separate privilege.
     */

    // Both resolve live, for the same reason permissions do: revoking a
    // territory or hiding a field must take effect on the next request, not
    // whenever a 15-minute token happens to expire.
    const [clientScope, storedMask] = await Promise.all([
      // D-60: the intake grant rides the admin row; the territory rides its
      // own table. `scopeOf` combines them under one unrestricted rule.
      this.scopes.scopeFor(admin.id, admin.seesUntriaged),
      this.roles.resolveMaskedFields(admin.roleId, admin.maskedFields),
    ]);

    return {
      ...admin,
      permissions,
      clientScope,
      sessionFamilyId: familyId,
      // Expanded here, once, so no enforcement point has to remember that
      // hiding `client.phone` must also hide `personalInfo.phone` on the KYC
      // screen — the bypass that would otherwise be one tab away.
      fieldMask: this.clientFields.expand(storedMask),
    };
  }

  /**
   * A machine credential, resolved into the same `AuthenticatedAdmin` every
   * downstream check already understands.
   *
   * ── The synthesized identity is not a real admin, and says so ─────────────
   *
   * `id` is the KEY's id, not its creator's. That is what makes the audit trail
   * honest: "this was done by the nightly-report key", not "by the person who
   * created it eighteen months ago". `email` carries the key name in a
   * reserved, unroutable form so an auditor reading a row knows what acted
   * without joining another table — `AdminAuditService` falls back to
   * 'unknown' for an actorId absent from `admins`, and every key action would
   * otherwise be untraceable.
   *
   * `passwordHash` is empty because a key has none. Nothing downstream reads
   * it — checked — and it exists here only to satisfy the `Admin` shape.
   *
   * ── A key is NEVER unrestricted ───────────────────────────────────────────
   *
   * `role` is always 'sub_admin' and the client scope is whatever the key's
   * permissions justify — never the master-admin bypass, even when the key
   * holds `*`. `isMaster()` keys on the role column OR the wildcard, so a key
   * granted `*` by a master admin does get the unrestricted scope; what it
   * cannot do is acquire that by claiming a role it was never given.
   */
  private async authenticateApiKey(presented: string): Promise<AuthenticatedAdmin> {
    const row = await this.apiKeys.findActiveByHash(hashApiKey(presented));

    /*
     * One message for "no such key" and "revoked key".
     *
     * Distinguishing them tells an attacker holding a rotated key that it was
     * once real — the same reasoning `resetPassword` applies to its token, and
     * the same reason login does not say which half was wrong.
     */
    if (!row) {
      throw new UnauthorizedException({
        message: 'Invalid or revoked API key.',
        code: 'INVALID_API_KEY',
      });
    }

    /*
     * EXPIRY is answered distinctly, and that is deliberate where revocation is
     * not. An expired key is one the caller legitimately held: telling them to
     * issue a new one is actionable and reveals nothing they did not already
     * know. Revocation is a decision made ABOUT them, and saying so would
     * confirm the key was genuine.
     */
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException({
        message: 'This API key has expired. Issue a new one in the admin console.',
        code: 'API_KEY_EXPIRED',
      });
    }

    // Fire-and-forget, and throttled to once an hour inside the store: a failed
    // or slow timestamp must never fail or delay the request it describes.
    void this.apiKeys.touchLastUsed(row.id).catch(() => undefined);

    const permissions = row.permissions;
    const identity: Admin = {
      id: row.id,
      email: `${row.name} (api key ${row.prefix}…)`,
      passwordHash: '',
      name: row.name,
      role: 'sub_admin',
      permissions,
      status: 'active',
      createdAt: row.createdAt,
    };

    /*
     * A key is UNRESTRICTED IN TERRITORY but fully permission-checked, and that
     * combination is a deliberate limit worth stating.
     *
     * Client scoping is a property of an admin_client_tag_scopes row keyed by
     * admin id; a key has no such row and inventing one would be inventing a
     * territory nobody chose. So a key sees every client its permissions allow
     * it to read. That is correct for the integrations this feature exists for
     * — a reporting job over the whole book — and it is why issuing a key is
     * master-admin-only and why `assertGrantable` bounds what one may hold.
     *
     * If per-key territory is ever wanted, it belongs as a scope column on this
     * table feeding `clientScope` here, NOT as a join to the creator's scope:
     * the key would then silently change territory when its creator did.
     */
    return {
      ...identity,
      permissions,
      clientScope: UNRESTRICTED,
      fieldMask: EMPTY_MASK,
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

/*
 * `MasterAdminGuard` IS GONE, and with it the idea of a role above other roles.
 *
 * It guarded twelve routes — the audit log, reconciliation, SMTP, the security
 * settings and API keys — by checking WHO the caller was rather than what they
 * held. No permission key could open them, so they could not be delegated at
 * all: the only way in was to sign in as the bootstrap account. That is why
 * `apikeys.*`, `audit.view`, `reconciliation.view` and `settings.smtp.*` did not
 * exist as keys, and it is the same failure as the eleven keys that were
 * enforced but absent from the catalog — a screen nobody could be given.
 *
 * Every one of those routes now carries a real `@RequirePermissions`, so access
 * to them is granted the way access to everything else is: through a role
 * somebody created.
 *
 * The invariant that replaces it does not live in a guard, because it is not
 * about who is asking. `assertNotLastManager` in admin-rbac.service.ts refuses
 * the single write that would leave NOBODY able to manage roles or
 * administrators — see the note there for why that is a refusal rather than a
 * privileged account.
 */

export const PERMISSIONS_KEY = 'required_permissions';

/**
 * "Any authenticated admin may do this" — stated, not assumed.
 *
 * The reason is required so the next reader sees a decision rather than an
 * omission (PLATFORM-CONVENTIONS R-4.2).
 */
export const ANY_ADMIN_KEY = 'any_admin';
export const AnyAdmin = (reason: string) => SetMetadata(ANY_ADMIN_KEY, reason);

/**
 * Route decorator: any ONE of the listed permissions grants access.
 *
 * There is no longer a wildcard that always does. `*` used to mean "every
 * permission", including every permission added after the grant was made — so a
 * key introduced next year was retroactively held by whoever carried it.
 * Migration 0044 expanded every stored `*` into the catalog as it stood that
 * day, and nothing writes one again.
 */
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

    // No wildcard branch. Full access is a real list of real keys now — see
    // RequirePermissions above and migration 0044.
    const held = new Set(admin.permissions.map(normalizePermissionKey));
    if (required.some((p) => held.has(normalizePermissionKey(p)))) return true;

    throw new ForbiddenException(
      `Missing permission: this action requires ${required.join(' or ')}.`,
    );
  }
}
