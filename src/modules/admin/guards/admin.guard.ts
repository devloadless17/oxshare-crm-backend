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
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from '../../../common/security/token-audience';

type AdminRequest = Request & { admin?: Admin };

/**
 * Cookie → admin, with permissions resolved live.
 *
 * Shared by all three guards below; a service so the stores arrive by
 * injection rather than being reached for from a module-level singleton.
 */
@Injectable()
export class AdminAuthenticator {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly admins: AdminsStore,
    private readonly roles: RolesStore,
  ) {}

  async authenticate(req: AdminRequest): Promise<Admin> {
    const token = readSessionCookie(
      req.cookies as Record<string, string | undefined> | undefined,
      COOKIE_BASES.adminAccess,
    );
    if (!token) throw new UnauthorizedException('Admin authentication required.');

    let adminId: string;
    try {
      const payload = this.jwt.verify<{ sub: string; role: string }>(token, {
        secret: this.config.getOrThrow<string>('ADMIN_JWT_SECRET'),
        // R-3.1: a portal token must be worthless here, and vice versa. The
        // distinct secrets already ensure that; this survives them being mixed up.
        audience: TOKEN_AUDIENCE.admin,
        issuer: TOKEN_ISSUER,
      });
      adminId = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired admin token.');
    }

    const admin = await this.admins.findById(adminId);
    if (!admin) throw new UnauthorizedException('Admin not found.');
    // Role-derived permissions resolve live: editing a role takes effect on the
    // next request from every admin holding it — no re-login, no stale grants.
    return {
      ...admin,
      permissions: await this.roles.resolvePermissions(admin.roleId, admin.permissions),
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
    if (admin.role !== 'master_admin') {
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

// One spelling: lower-case, dot-separated, exactly as config/permissions.json
// declares it. The `:` → `.` rewrite this used to do was removed with migration
// 0009, which converted the stored keys — a shim that accepts both spellings is
// a standing invitation to a third.
const normalize = (key: string) => key.toLowerCase();

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
    const held = new Set(admin.permissions.map(normalize));
    if (required.some((p) => held.has(normalize(p)))) return true;

    throw new ForbiddenException(
      `Missing permission: this action requires ${required.join(' or ')}.`,
    );
  }
}
