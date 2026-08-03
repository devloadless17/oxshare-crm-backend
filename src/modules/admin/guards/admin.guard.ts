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
import { resolvePermissions } from '../../../store/roles.store';
import { Request } from 'express';

type AdminRequest = Request & { admin?: Admin };

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    req.admin = await authenticateAdmin(req, this.jwt, this.config);
    return true;
  }
}

// Per ARCHITECTURE §8.8 a permission failure is a 403, never a 401 — a 401
// makes the admin client treat the session as dead and log the admin out.
@Injectable()
export class MasterAdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const admin = await authenticateAdmin(req, this.jwt, this.config);
    if (admin.role !== 'master_admin') {
      throw new ForbiddenException('Master admin access required.');
    }
    req.admin = admin;
    return true;
  }
}

export const PERMISSIONS_KEY = 'required_permissions';

/** Route decorator: any ONE of the listed permissions grants access ('*' always does). */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

// Historical inconsistency: issued tokens carry colon keys ('kyc:review') while
// config/permissions.json uses dot keys ('kyc.review'). Normalize both sides so
// either spelling works until the catalog is unified.
const normalize = (key: string) => key.replace(/:/g, '.').toLowerCase();

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const admin = await authenticateAdmin(req, this.jwt, this.config);
    req.admin = admin;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    if (admin.permissions.includes('*')) return true;
    const held = new Set(admin.permissions.map(normalize));
    if (required.some((p) => held.has(normalize(p)))) return true;

    throw new ForbiddenException(
      `Missing permission: this action requires ${required.join(' or ')}.`,
    );
  }
}

async function authenticateAdmin(req: AdminRequest, jwt: JwtService, config: ConfigService): Promise<Admin> {
  const token = req.cookies?.['admin_access_token'];
  if (!token) throw new UnauthorizedException('Admin authentication required.');

  let adminId: string;
  try {
    const payload = jwt.verify<{ sub: string; role: string }>(token, {
      secret: config.get('ADMIN_JWT_SECRET', 'oxshare-admin-secret-dev'),
    });
    adminId = payload.sub;
  } catch {
    throw new UnauthorizedException('Invalid or expired admin token.');
  }

  const admin = await AdminsStore.findById(adminId);
  if (!admin) throw new UnauthorizedException('Admin not found.');
  // Role-derived permissions resolve live: editing a role takes effect on the
  // next request from every admin holding it — no re-login, no stale grants.
  return { ...admin, permissions: await resolvePermissions(admin.roleId, admin.permissions) };
}
