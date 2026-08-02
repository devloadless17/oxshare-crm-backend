import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminsStore } from '../../../store/admins.store';
import { Request } from 'express';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = req.cookies?.['admin_access_token'];
    if (!token) throw new UnauthorizedException('Admin authentication required.');

    try {
      const payload = this.jwt.verify<{ sub: string; role: string }>(token, {
        secret: this.config.get('ADMIN_JWT_SECRET', 'oxshare-admin-secret-dev'),
      });
      const admin = AdminsStore.findById(payload.sub);
      if (!admin) throw new UnauthorizedException('Admin not found.');
      (req as Request & { admin: typeof admin }).admin = admin;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired admin token.');
    }
  }
}

@Injectable()
export class MasterAdminGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { admin?: { role: string } }>();
    const token = req.cookies?.['admin_access_token'];
    if (!token) throw new UnauthorizedException('Admin authentication required.');

    try {
      const payload = this.jwt.verify<{ sub: string; role: string }>(token, {
        secret: this.config.get('ADMIN_JWT_SECRET', 'oxshare-admin-secret-dev'),
      });
      const admin = AdminsStore.findById(payload.sub);
      if (!admin || admin.role !== 'master_admin') {
        throw new UnauthorizedException('Master admin access required.');
      }
      (req as Request & { admin: typeof admin }).admin = admin;
      return true;
    } catch {
      throw new UnauthorizedException('Master admin access required.');
    }
  }
}
