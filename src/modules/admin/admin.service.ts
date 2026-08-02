import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { AdminsStore, InvitesStore, Admin } from '../../store/admins.store';
import { KycService } from '../compliance/kyc.service';
import { Response } from 'express';

const ADMIN_COOKIE = 'admin_access_token';
const ADMIN_REFRESH_COOKIE = 'admin_refresh_token';

@Injectable()
export class AdminService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly kycService: KycService,
  ) {}

  // ─── Admin Login ───────────────────────────────────────────────────────────
  async login(email: string, password: string, res: Response) {
    const admin = AdminsStore.findByEmail(email);
    if (!admin) throw new UnauthorizedException('Invalid credentials.');

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials.');

    const { accessToken, refreshToken } = this.generateAdminTokens(admin);
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    AdminsStore.update(admin.id, { refreshToken: refreshHash });

    this.setAdminCookies(res, accessToken, refreshToken);
    return { admin: this.sanitize(admin), accessToken, refreshToken };
  }

  // ─── Admin Logout ──────────────────────────────────────────────────────────
  logout(adminId: string, res: Response) {
    AdminsStore.update(adminId, { refreshToken: undefined });
    res.clearCookie(ADMIN_COOKIE);
    res.clearCookie(ADMIN_REFRESH_COOKIE);
    return { message: 'Logged out.' };
  }

  // ─── Admin Me ──────────────────────────────────────────────────────────────
  me(admin: Admin) {
    return this.sanitize(admin);
  }

  // ─── Create Invite ─────────────────────────────────────────────────────────
  async createInvite(email: string, name: string, invitedBy: string) {
    if (AdminsStore.findByEmail(email)) {
      throw new ConflictException('An admin with this email already exists.');
    }

    const token = uuidv4();
    const invite = InvitesStore.create({
      email,
      name,
      token,
      role: 'sub_admin',
      invitedBy,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48h
    });

    const inviteUrl = `${this.config.get('ADMIN_URL', 'http://localhost:3002')}/invite/accept?token=${token}`;
    console.log('\n📧 ADMIN INVITE LINK (dev only):');
    console.log(`   ${inviteUrl}\n`);

    return {
      message: `Invite sent to ${email}`,
      token, // exposed in dev — remove in production
      inviteUrl,
    };
  }

  // ─── Accept Invite ─────────────────────────────────────────────────────────
  async acceptInvite(token: string, password: string, res: Response) {
    const invite = InvitesStore.findByToken(token);
    if (!invite) throw new NotFoundException('Invite not found or already used.');
    if (invite.accepted) throw new BadRequestException('This invite has already been used.');
    if (invite.expiresAt < new Date()) throw new BadRequestException('Invite has expired.');

    const passwordHash = await bcrypt.hash(password, 12);
    const admin = AdminsStore.create({
      email: invite.email,
      passwordHash,
      name: invite.name,
      role: 'sub_admin',
      permissions: ['kyc:review', 'clients:read'],
    });

    InvitesStore.markAccepted(token);

    const { accessToken, refreshToken } = this.generateAdminTokens(admin);
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    AdminsStore.update(admin.id, { refreshToken: refreshHash });
    this.setAdminCookies(res, accessToken, refreshToken);

    return { message: 'Account created. Welcome aboard!', admin: this.sanitize(admin) };
  }

  // ─── Validate invite token (for UI pre-fill) ───────────────────────────────
  validateInviteToken(token: string) {
    const invite = InvitesStore.findByToken(token);
    if (!invite || invite.accepted || invite.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired invite token.');
    }
    return { email: invite.email, name: invite.name, role: invite.role };
  }

  // ─── KYC: list all ────────────────────────────────────────────────────────
  listKyc(status?: string) {
    return this.kycService.listAll(status as Parameters<typeof this.kycService.listAll>[0]);
  }

  // ─── KYC: get one ─────────────────────────────────────────────────────────
  getKyc(userId: string) {
    return this.kycService.getByUserId(userId);
  }

  // ─── KYC: approve ─────────────────────────────────────────────────────────
  approveKyc(userId: string, adminId: string) {
    return this.kycService.approve(userId, adminId);
  }

  // ─── KYC: reject ──────────────────────────────────────────────────────────
  rejectKyc(userId: string, adminId: string, reason: string) {
    return this.kycService.reject(userId, adminId, reason);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  private generateAdminTokens(admin: Admin) {
    const secret = this.config.get('ADMIN_JWT_SECRET', 'oxshare-admin-secret-dev');
    const accessToken = this.jwt.sign(
      { sub: admin.id, email: admin.email, role: admin.role },
      { secret, expiresIn: '8h' },
    );
    const refreshToken = this.jwt.sign(
      { sub: admin.id },
      { secret, expiresIn: '7d' },
    );
    return { accessToken, refreshToken };
  }

  private setAdminCookies(res: Response, accessToken: string, refreshToken: string) {
    const cookieOpts = {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: process.env['NODE_ENV'] === 'production',
      path: '/',
    };
    res.cookie(ADMIN_COOKIE, accessToken, { ...cookieOpts, maxAge: 8 * 60 * 60 * 1000 });
    res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, { ...cookieOpts, maxAge: 7 * 24 * 60 * 60 * 1000 });
  }

  private sanitize(admin: Admin) {
    const { passwordHash, refreshToken, ...safe } = admin;
    return safe;
  }
}
