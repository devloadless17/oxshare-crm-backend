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
import * as fs from 'fs';
import * as path from 'path';
import { AdminsStore, InvitesStore, Admin } from '../../store/admins.store';
import { KycConfigStore, KycStepConfig } from '../../store/kyc-config.store';
import { RolesStore, resolvePermissions } from '../../store/roles.store';
import { RejectionReasonsStore, RejectionContext } from '../../store/rejection-reasons.store';
import { UsersStore } from '../../store/users.store';
import { AuditLogStore } from '../../store/audit-log.store';
import { KycService } from '../compliance/kyc.service';
import { EmailService } from '../email/email.service';
import { Request, Response } from 'express';

const ADMIN_COOKIE = 'admin_access_token';
const ADMIN_REFRESH_COOKIE = 'admin_refresh_token';

@Injectable()
export class AdminService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly kycService: KycService,
    private readonly email: EmailService,
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
  async createInvite(
    email: string,
    name: string,
    invitedBy: string,
    roleId?: string,
    permissions?: string[],
  ) {
    if (AdminsStore.findByEmail(email)) {
      throw new ConflictException('An admin with this email already exists.');
    }

    // RBAC-07: the inviting master admin chooses the role; RBAC-02: a sub-admin
    // holds only what is explicitly granted.
    let grantedPermissions = permissions;
    if (roleId) {
      const role = RolesStore.findById(roleId);
      if (!role) throw new NotFoundException('Role not found.');
      grantedPermissions = role.permissions;
    }

    const token = uuidv4();
    const invite = InvitesStore.create({
      email,
      name,
      token,
      role: 'sub_admin',
      roleId,
      permissions: grantedPermissions,
      invitedBy,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48h
    });

    const inviteUrl = `${this.config.get('ADMIN_URL', 'http://localhost:3002')}/invite/accept?token=${token}`;
    void this.email.sendAdminInviteEmail(email, name, inviteUrl);
    this.audit(invitedBy, 'admin.invite', 'admin_invite', invite.id, {
      email,
      roleId,
      permissions: grantedPermissions,
    });

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
      roleId: invite.roleId,
      permissions: invite.permissions ?? ['kyc.review', 'users.view'],
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
  listKyc(query: { status?: string; q?: string; page?: string; limit?: string }) {
    return this.kycService.listAll({
      status: query.status as import('../../store/kyc.store').KycStatus | undefined,
      q: query.q,
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
    });
  }

  // ─── KYC: get one ─────────────────────────────────────────────────────────
  getKyc(userId: string) {
    return this.kycService.getByUserId(userId);
  }

  // ─── KYC: approve ─────────────────────────────────────────────────────────
  approveKyc(userId: string, adminId: string) {
    const result = this.kycService.approve(userId, adminId);
    this.audit(adminId, 'kyc.approve', 'kyc_submission', userId, { verificationLevel: 1 });
    return result;
  }

  // ─── Audit log (D-21, append-only) ────────────────────────────────────────
  private audit(
    actorId: string,
    action: string,
    subjectType: string,
    subjectId: string,
    details?: Record<string, unknown>,
  ) {
    const actor = AdminsStore.findById(actorId);
    AuditLogStore.record({
      actorId,
      actorEmail: actor?.email ?? 'unknown',
      action,
      subjectType,
      subjectId,
      details,
    });
  }

  listAuditLog(query: { page?: string; limit?: string; action?: string; subjectType?: string }) {
    return AuditLogStore.findAll({
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
      action: query.action,
      subjectType: query.subjectType,
    });
  }

  // ─── KYC: claim for review ────────────────────────────────────────────────
  claimKyc(userId: string, adminId: string) {
    const result = this.kycService.claim(userId, adminId);
    this.audit(adminId, 'kyc.claim', 'kyc_submission', userId);
    return result;
  }

  // ─── KYC: reject ──────────────────────────────────────────────────────────
  rejectKyc(
    userId: string,
    adminId: string,
    reason?: string,
    rejectedFields?: string[],
    reasonId?: string,
  ) {
    let effectiveReason = reason?.trim();
    if (reasonId) {
      const configured = RejectionReasonsStore.findById(reasonId);
      if (!configured) throw new NotFoundException('Rejection reason not found.');
      effectiveReason = effectiveReason
        ? `${configured.label} — ${effectiveReason}`
        : configured.label;
    }
    if (!effectiveReason) {
      throw new BadRequestException('A rejection reason (reasonId or reason text) is required.');
    }
    const result = this.kycService.reject(userId, adminId, effectiveReason, rejectedFields);
    this.audit(adminId, 'kyc.reject', 'kyc_submission', userId, {
      reason: effectiveReason,
      rejectedFields,
    });
    return result;
  }

  // ─── RBAC: permission catalog ─────────────────────────────────────────────
  getPermissionsCatalog() {
    const file = path.join(__dirname, '../../config/permissions.json');
    const fallback = path.join(process.cwd(), 'src/config/permissions.json');
    const raw = fs.readFileSync(fs.existsSync(file) ? file : fallback, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  // ─── RBAC: roles ──────────────────────────────────────────────────────────
  listRoles() {
    return RolesStore.findAll();
  }

  createRole(name: string, description: string | undefined, permissions: string[], actorId?: string) {
    if (RolesStore.findByName(name)) {
      throw new ConflictException('A role with this name already exists.');
    }
    const role = RolesStore.create({ name, description, permissions });
    if (actorId) this.audit(actorId, 'role.create', 'role', role.id, { name, permissions });
    return role;
  }

  updateRole(id: string, patch: { name?: string; description?: string; permissions?: string[] }, actorId?: string) {
    const role = RolesStore.findById(id);
    if (!role) throw new NotFoundException('Role not found.');
    if (role.isSystem) throw new BadRequestException('System roles cannot be modified.');
    const updated = RolesStore.update(id, patch);
    if (actorId) this.audit(actorId, 'role.update', 'role', id, { before: role.permissions, after: updated?.permissions });
    return updated;
  }

  deleteRole(id: string, actorId?: string) {
    const role = RolesStore.findById(id);
    if (!role) throw new NotFoundException('Role not found.');
    if (role.isSystem) throw new BadRequestException('System roles cannot be deleted.');
    // A role in use cannot be deleted — silently orphaning its admins would
    // leave them running on the stale per-admin snapshot.
    const holders = AdminsStore.findByRoleId(id);
    if (holders.length > 0) {
      throw new ConflictException(
        `Role is assigned to ${holders.length} admin(s). Reassign them first.`,
      );
    }
    const pending = InvitesStore.findPendingByRoleId(id);
    if (pending.length > 0) {
      throw new ConflictException(
        `Role is referenced by ${pending.length} pending invite(s). Wait for expiry or invite again with another role.`,
      );
    }
    RolesStore.delete(id);
    if (actorId) this.audit(actorId, 'role.delete', 'role', id, { name: role.name });
    return { message: 'Role deleted.' };
  }

  // ─── RBAC: admin directory ────────────────────────────────────────────────
  listAdmins() {
    return AdminsStore.findAll().map((a) => this.sanitize(a));
  }

  updateAdmin(id: string, patch: { name?: string; roleId?: string; permissions?: string[] }, actorId?: string) {
    const admin = AdminsStore.findById(id);
    if (!admin) throw new NotFoundException('Admin not found.');
    if (admin.role === 'master_admin' && (patch.roleId || patch.permissions)) {
      throw new BadRequestException('The master admin’s permissions cannot be changed.');
    }

    let update: Partial<Admin> = { name: patch.name ?? admin.name };
    if (patch.roleId) {
      const role = RolesStore.findById(patch.roleId);
      if (!role) throw new NotFoundException('Role not found.');
      update = { ...update, roleId: role.id, permissions: role.permissions };
    } else if (patch.permissions) {
      update = { ...update, roleId: undefined, permissions: patch.permissions };
    }

    const updated = AdminsStore.update(id, update)!;
    if (actorId) {
      this.audit(actorId, 'admin.update', 'admin', id, {
        before: { permissions: admin.permissions, roleId: admin.roleId },
        after: { permissions: updated.permissions, roleId: updated.roleId },
      });
    }
    return this.sanitize(updated);
  }

  // ─── Clients list (ADM-01 / ADM-14) ───────────────────────────────────────
  listClients(query: {
    page?: string;
    limit?: string;
    q?: string;
    type?: string;
    status?: string;
    level?: string;
  }) {
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '25', 10) || 25));

    let clients = UsersStore.findAll();
    if (query.type) clients = clients.filter((u) => u.type === query.type);
    if (query.status) clients = clients.filter((u) => u.status === query.status);
    if (query.level !== undefined && query.level !== '') {
      const level = Number(query.level);
      clients = clients.filter((u) => u.verificationLevel === level);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      clients = clients.filter(
        (u) =>
          u.email.toLowerCase().includes(q) ||
          u.firstName.toLowerCase().includes(q) ||
          u.lastName.toLowerCase().includes(q),
      );
    }

    clients.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = clients.length;
    const items = clients.slice((page - 1) * limit, page * limit).map((u) => ({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      type: u.type,
      status: u.status,
      verificationLevel: u.verificationLevel,
      country: u.country,
      createdAt: u.createdAt,
    }));

    return { items, total, page, limit };
  }

  // ─── Rejection reasons (FR-ADM-03 configurable list) ──────────────────────
  listRejectionReasons(context?: RejectionContext) {
    return RejectionReasonsStore.findAll(context);
  }

  createRejectionReason(context: RejectionContext, label: string) {
    return RejectionReasonsStore.create(context, label);
  }

  updateRejectionReason(id: string, label: string) {
    const updated = RejectionReasonsStore.update(id, label);
    if (!updated) throw new NotFoundException('Rejection reason not found.');
    return updated;
  }

  deleteRejectionReason(id: string) {
    if (!RejectionReasonsStore.delete(id)) {
      throw new NotFoundException('Rejection reason not found.');
    }
    return { message: 'Rejection reason deleted.' };
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
      { secret, expiresIn: '30d' },
    );
    return { accessToken, refreshToken };
  }

  private setAdminCookies(res: Response, accessToken: string, refreshToken: string) {
    const cookieOpts = {
      httpOnly: false,
      sameSite: 'lax' as const,
      secure: process.env['NODE_ENV'] === 'production',
      path: '/',
    };
    res.cookie(ADMIN_COOKIE, accessToken, { ...cookieOpts, maxAge: 8 * 60 * 60 * 1000 });
    res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, { ...cookieOpts, maxAge: 30 * 24 * 60 * 60 * 1000 });
  }

  // ─── Admin Refresh ─────────────────────────────────────────────────────────
  async refresh(req: Request, res: Response) {
    const providedToken =
      (req.cookies as Record<string, string>)?.[ADMIN_REFRESH_COOKIE] ||
      (req.body as Record<string, string>)?.refreshToken ||
      (req.headers as Record<string, string>)?.authorization?.replace('Bearer ', '');

    if (!providedToken) throw new UnauthorizedException('No refresh token provided.');

    let adminId: string;
    try {
      const secret = this.config.get('ADMIN_JWT_SECRET', 'oxshare-admin-secret-dev');
      const decoded = this.jwt.verify(providedToken, { secret });
      adminId = decoded.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired admin refresh token.');
    }

    let admin = AdminsStore.findById(adminId);
    if (!admin) {
      admin = AdminsStore.findByEmail('admin@oxshare.com');
    }
    if (!admin) throw new UnauthorizedException('Admin account not found.');

    const { accessToken, refreshToken } = this.generateAdminTokens(admin);
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    AdminsStore.update(admin.id, { refreshToken: refreshHash });

    this.setAdminCookies(res, accessToken, refreshToken);

    return {
      admin: this.sanitize(admin),
      accessToken,
      refreshToken,
      admin_access_token: accessToken,
      admin_refresh_token: refreshToken,
    };
  }

  // ─── KYC Configurator ───────────────────────────────────────────────────────
  getKycConfig() {
    return KycConfigStore.getSteps();
  }

  updateKycConfig(steps: KycStepConfig[]) {
    return KycConfigStore.setSteps(steps);
  }

  addKycStep(stepData: Omit<KycStepConfig, 'id' | 'stepNumber'>) {
    return KycConfigStore.addStep(stepData);
  }

  updateKycStep(id: string, patch: Partial<KycStepConfig>) {
    return KycConfigStore.updateStep(id, patch);
  }

  deleteKycStep(id: string) {
    return KycConfigStore.deleteStep(id);
  }

  resetKycConfig() {
    return KycConfigStore.resetDefaults();
  }

  private sanitize(admin: Admin) {
    const { passwordHash, refreshToken, ...safe } = admin;
    // Surface the LIVE permission set (role-derived when roleId is set) so the
    // frontend's nav gating always matches what the guards will enforce.
    return { ...safe, permissions: resolvePermissions(admin.roleId, admin.permissions) };
  }
}
