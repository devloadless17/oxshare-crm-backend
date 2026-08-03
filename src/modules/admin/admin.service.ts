import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { AdminsStore, InvitesStore, Admin } from '../../store/admins.store';
import { KycConfigStore, KycStepConfig } from '../../store/kyc-config.store';
import { RolesStore } from '../../store/roles.store';
import { RejectionReasonsStore, RejectionContext } from '../../store/rejection-reasons.store';
import { UsersStore } from '../../store/users.store';
import { AuditLogStore } from '../../store/audit-log.store';
import { KycService } from '../compliance/kyc.service';
import { EmailService } from '../email/email.service';
import { TransactionsService } from '../payments/transactions.service';
import { WalletService } from '../wallet/wallet.service';
import { ProgramInput, ProgramsService } from '../partners/programs.service';
import { Request, Response } from 'express';

const ADMIN_COOKIE = 'admin_access_token';
const ADMIN_REFRESH_COOKIE = 'admin_refresh_token';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly kycService: KycService,
    private readonly email: EmailService,
    private readonly transactions: TransactionsService,
    private readonly wallets: WalletService,
    private readonly programs: ProgramsService,
    private readonly admins: AdminsStore,
    private readonly invites: InvitesStore,
    private readonly users: UsersStore,
    private readonly roles: RolesStore,
    private readonly kycConfig: KycConfigStore,
    private readonly auditLog: AuditLogStore,
    private readonly rejectionReasons: RejectionReasonsStore,
  ) {}

  // ─── Admin Login ───────────────────────────────────────────────────────────
  async login(email: string, password: string, res: Response) {
    const admin = await this.admins.findByEmail(email);
    if (!admin) throw new UnauthorizedException('Invalid credentials.');

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials.');

    const { accessToken, refreshToken } = this.generateAdminTokens(admin);
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    await this.admins.update(admin.id, { refreshToken: refreshHash });

    this.setAdminCookies(res, accessToken, refreshToken);
    return { admin: await this.sanitize(admin), accessToken, refreshToken };
  }

  // ─── Admin Logout ──────────────────────────────────────────────────────────
  async logout(adminId: string, res: Response) {
    await this.admins.update(adminId, { refreshToken: undefined });
    res.clearCookie(ADMIN_COOKIE);
    res.clearCookie(ADMIN_REFRESH_COOKIE);
    return { message: 'Logged out.' };
  }

  // ─── Admin Me ──────────────────────────────────────────────────────────────
  async me(admin: Admin) {
    return await this.sanitize(admin);
  }

  // ─── Create Invite ─────────────────────────────────────────────────────────
  async createInvite(
    email: string,
    name: string,
    actor: Admin,
    roleId?: string,
    permissions?: string[],
  ) {
    if (await this.admins.findByEmail(email)) {
      throw new ConflictException('An admin with this email already exists.');
    }

    // RBAC-07: the inviting admin chooses the role; RBAC-02: a sub-admin
    // holds only what is explicitly granted. Whatever the grant path — role,
    // explicit list, or the default — it must be grantable by the actor.
    let grantedPermissions = permissions;
    if (roleId) {
      const role = await this.roles.findById(roleId);
      if (!role) throw new NotFoundException('Role not found.');
      grantedPermissions = role.permissions;
    }
    await this.assertGrantable(actor, grantedPermissions ?? ['kyc.review', 'users.view']);
    const invitedBy = actor.id;

    const token = uuidv4();
    const invite = await this.invites.create({
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

    // The token is a bearer credential that creates an admin account. It goes
    // to the invitee's mailbox and nowhere else — not the response body, which
    // would land in proxy logs, SPA memory and error-reporting tools.
    // The link is echoed only outside production, to keep local dev workable.
    const isProduction = this.config.get('NODE_ENV') === 'production';
    return {
      message: `Invite sent to ${email}`,
      ...(isProduction ? {} : { inviteUrl }),
    };
  }

  // ─── Accept Invite ─────────────────────────────────────────────────────────
  async acceptInvite(token: string, password: string, res: Response) {
    const invite = await this.invites.findByToken(token);
    if (!invite) throw new NotFoundException('Invite not found or already used.');
    if (invite.accepted) throw new BadRequestException('This invite has already been used.');
    if (invite.expiresAt < new Date()) throw new BadRequestException('Invite has expired.');

    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await this.admins.create({
      email: invite.email,
      passwordHash,
      name: invite.name,
      role: 'sub_admin',
      roleId: invite.roleId,
      permissions: invite.permissions ?? ['kyc.review', 'users.view'],
    });

    await this.invites.markAccepted(token);

    const { accessToken, refreshToken } = this.generateAdminTokens(admin);
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    await this.admins.update(admin.id, { refreshToken: refreshHash });
    this.setAdminCookies(res, accessToken, refreshToken);

    return { message: 'Account created. Welcome aboard!', admin: await this.sanitize(admin) };
  }

  // ─── Validate invite token (for UI pre-fill) ───────────────────────────────
  async validateInviteToken(token: string) {
    const invite = await this.invites.findByToken(token);
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
  async approveKyc(userId: string, adminId: string) {
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
    // Fire-and-forget: an audit-write failure must never fail the admin action,
    // but it must be loud in the logs.
    void (async () => {
      const actor = await this.admins.findById(actorId);
      await this.auditLog.record({
        actorId,
        actorEmail: actor?.email ?? 'unknown',
        action,
        subjectType,
        subjectId,
        details,
      });
    })().catch((err: Error) =>
      this.logger.error(`Failed to record admin action ${action}: ${err.message}`),
    );
  }

  listAuditLog(query: { page?: string; limit?: string; action?: string; subjectType?: string }) {
    return this.auditLog.findAll({
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
      action: query.action,
      subjectType: query.subjectType,
    });
  }

  // ─── KYC: claim for review ────────────────────────────────────────────────
  async claimKyc(userId: string, adminId: string) {
    const result = this.kycService.claim(userId, adminId);
    this.audit(adminId, 'kyc.claim', 'kyc_submission', userId);
    return result;
  }

  // ─── KYC: reject ──────────────────────────────────────────────────────────
  async rejectKyc(
    userId: string,
    adminId: string,
    reason?: string,
    rejectedFields?: string[],
    reasonId?: string,
  ) {
    let effectiveReason = reason?.trim();
    if (reasonId) {
      const configured = await this.rejectionReasons.findById(reasonId);
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
    return JSON.parse(raw) as Record<
      string,
      { moduleName: string; description: string; permissions: { key: string; label: string }[] }
    >;
  }

  /** Every grantable key, from the catalog — the single vocabulary for roles. */
  private catalogKeys(): Set<string> {
    const keys = new Set<string>();
    for (const module of Object.values(this.getPermissionsCatalog())) {
      for (const p of module.permissions) keys.add(p.key);
    }
    return keys;
  }

  private static normalizeKey(key: string): string {
    return key.replace(/:/g, '.').toLowerCase();
  }

  /**
   * Anti-escalation invariant: nobody hands out access they don't hold.
   * - every key must exist in the catalog ('*' is reserved for the master),
   * - a non-master actor can only grant keys from their own permission set.
   * The actor's permissions arrive live-resolved from the guard.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- async by contract: every caller awaits it, and role lookups will become async here.
  private async assertGrantable(actor: Admin, permissions: string[]) {
    const catalog = this.catalogKeys();
    const unknown = permissions.filter(
      (p) => p !== '*' && !catalog.has(AdminService.normalizeKey(p)),
    );
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown permission key(s): ${unknown.join(', ')}.`);
    }

    const actorIsMaster = actor.permissions.includes('*');
    if (permissions.includes('*') && !actorIsMaster) {
      throw new ForbiddenException('Only the master admin can grant the * wildcard.');
    }
    if (actorIsMaster) return;

    const held = new Set(actor.permissions.map((p) => AdminService.normalizeKey(p)));
    const beyond = permissions.filter((p) => !held.has(AdminService.normalizeKey(p)));
    if (beyond.length > 0) {
      throw new ForbiddenException(
        `You cannot grant permissions you do not hold: ${beyond.join(', ')}.`,
      );
    }
  }

  // ─── RBAC: roles ──────────────────────────────────────────────────────────
  async listRoles() {
    return await this.roles.findAll();
  }

  async createRole(
    name: string,
    description: string | undefined,
    permissions: string[],
    actor: Admin,
  ) {
    if (await this.roles.findByName(name)) {
      throw new ConflictException('A role with this name already exists.');
    }
    await this.assertGrantable(actor, permissions);
    const role = await this.roles.create({ name, description, permissions });
    this.audit(actor.id, 'role.create', 'role', role.id, { name, permissions });
    return role;
  }

  async updateRole(
    id: string,
    patch: { name?: string; description?: string; permissions?: string[] },
    actor: Admin,
  ) {
    const role = await this.roles.findById(id);
    if (!role) throw new NotFoundException('Role not found.');
    if (role.isSystem) throw new BadRequestException('System roles cannot be modified.');
    if (patch.name && patch.name !== role.name && (await this.roles.findByName(patch.name))) {
      throw new ConflictException('A role with this name already exists.');
    }
    if (patch.permissions) await this.assertGrantable(actor, patch.permissions);
    const updated = await this.roles.update(id, patch);
    this.audit(actor.id, 'role.update', 'role', id, {
      before: role.permissions,
      after: updated?.permissions,
    });
    return updated;
  }

  async deleteRole(id: string, actorId?: string) {
    const role = await this.roles.findById(id);
    if (!role) throw new NotFoundException('Role not found.');
    if (role.isSystem) throw new BadRequestException('System roles cannot be deleted.');
    // A role in use cannot be deleted — silently orphaning its admins would
    // leave them running on the stale per-admin snapshot.
    const holders = await this.admins.findByRoleId(id);
    if (holders.length > 0) {
      throw new ConflictException(
        `Role is assigned to ${holders.length} admin(s). Reassign them first.`,
      );
    }
    const pending = await this.invites.findPendingByRoleId(id);
    if (pending.length > 0) {
      throw new ConflictException(
        `Role is referenced by ${pending.length} pending invite(s). Wait for expiry or invite again with another role.`,
      );
    }
    await this.roles.delete(id);
    if (actorId) this.audit(actorId, 'role.delete', 'role', id, { name: role.name });
    return { message: 'Role deleted.' };
  }

  // ─── RBAC: admin directory ────────────────────────────────────────────────
  async listAdmins() {
    const all = await this.admins.findAll();
    return Promise.all(all.map((a) => this.sanitize(a)));
  }

  async updateAdmin(
    id: string,
    patch: { name?: string; roleId?: string; permissions?: string[] },
    actor: Admin,
  ) {
    const admin = await this.admins.findById(id);
    if (!admin) throw new NotFoundException('Admin not found.');
    if (admin.role === 'master_admin' && (patch.roleId || patch.permissions)) {
      throw new BadRequestException('The master admin’s permissions cannot be changed.');
    }
    // Nobody rewrites their own access — not even a harmless-looking subset;
    // it keeps every permission change attributable to someone else's decision.
    if (actor.id === id && (patch.roleId || patch.permissions)) {
      throw new ForbiddenException('You cannot change your own role or permissions.');
    }

    let update: Partial<Admin> = { name: patch.name ?? admin.name };
    if (patch.roleId) {
      const role = await this.roles.findById(patch.roleId);
      if (!role) throw new NotFoundException('Role not found.');
      await this.assertGrantable(actor, role.permissions);
      update = { ...update, roleId: role.id, permissions: role.permissions };
    } else if (patch.permissions) {
      await this.assertGrantable(actor, patch.permissions);
      update = { ...update, roleId: undefined, permissions: patch.permissions };
    }

    const updated = (await this.admins.update(id, update))!;
    this.audit(actor.id, 'admin.update', 'admin', id, {
      before: { permissions: admin.permissions, roleId: admin.roleId },
      after: { permissions: updated.permissions, roleId: updated.roleId },
    });
    return await this.sanitize(updated);
  }

  // ─── Clients list (ADM-01 / ADM-14) ───────────────────────────────────────
  async listClients(query: {
    page?: string;
    limit?: string;
    q?: string;
    type?: string;
    status?: string;
    level?: string;
  }) {
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '25', 10) || 25));

    // An unparseable ?level= used to become NaN and silently return nothing.
    let level: number | undefined;
    if (query.level !== undefined && query.level !== '') {
      const parsed = Number(query.level);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1) {
        throw new BadRequestException('level must be 0 or 1.');
      }
      level = parsed;
    }

    const { items, total } = await this.users.findPage({
      page,
      limit,
      q: query.q?.trim() || undefined,
      type: query.type,
      status: query.status,
      level,
    });
    return { items, total, page, limit };
  }

  // ─── Client suspension (users.suspend) ────────────────────────────────────
  async setClientStatus(userId: string, status: 'active' | 'suspended', actor: Admin) {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('Client not found.');
    if (user.status === status) {
      throw new BadRequestException(`Client is already ${status}.`);
    }

    const updated = (await this.users.update(userId, { status }))!;
    // Suspension bites immediately: the JWT strategy re-checks status on every
    // request, and login/refresh refuse suspended accounts.
    this.audit(
      actor.id,
      status === 'suspended' ? 'client.suspend' : 'client.activate',
      'user',
      userId,
      {
        email: user.email,
        before: user.status,
        after: status,
      },
    );

    return {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      type: updated.type,
      status: updated.status,
      verificationLevel: updated.verificationLevel,
      country: updated.country,
      createdAt: updated.createdAt,
    };
  }

  // ─── Rejection reasons (FR-ADM-03 configurable list) ──────────────────────
  async listRejectionReasons(context?: RejectionContext) {
    return await this.rejectionReasons.findAll(context);
  }

  async createRejectionReason(context: RejectionContext, label: string) {
    return await this.rejectionReasons.create(context, label);
  }

  async updateRejectionReason(id: string, label: string) {
    const updated = await this.rejectionReasons.update(id, label);
    if (!updated) throw new NotFoundException('Rejection reason not found.');
    return updated;
  }

  async deleteRejectionReason(id: string) {
    if (!(await this.rejectionReasons.delete(id))) {
      throw new NotFoundException('Rejection reason not found.');
    }
    return { message: 'Rejection reason deleted.' };
  }

  // ─── Withdrawals (ADM-03 · §8.4) ──────────────────────────────────────────
  // Every transition here moves client money, so every one is audited.
  async listWithdrawals(query: { state?: string; page?: string; limit?: string }) {
    return this.transactions.listForAdmin({
      state: query.state,
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
    });
  }

  async approveWithdrawal(id: string, actor: Admin) {
    const row = await this.transactions.approve(id, actor.id);
    this.audit(actor.id, 'withdrawal.approve', 'transaction', id, {
      amount: row.amount,
      currency: row.currency,
    });
    return row;
  }

  async rejectWithdrawal(id: string, actor: Admin, reason?: string, reasonId?: string) {
    // FR-ADM-03: the reason comes from the configurable list; free text is an
    // optional note alongside it.
    let effectiveReason = reason?.trim();
    if (reasonId) {
      const configured = await this.rejectionReasons.findById(reasonId);
      if (!configured) throw new NotFoundException('Rejection reason not found.');
      effectiveReason = effectiveReason
        ? `${configured.label} — ${effectiveReason}`
        : configured.label;
    }
    if (!effectiveReason) {
      throw new BadRequestException('A rejection reason (reasonId or reason text) is required.');
    }

    const row = await this.transactions.reject(id, actor.id, effectiveReason);
    const user = await this.users.findById(row.userId);
    if (user) {
      void this.email.sendWithdrawalDecisionEmail(
        user.email,
        user.firstName,
        'rejected',
        row.amount,
        row.currency,
        effectiveReason,
      );
    }
    this.audit(actor.id, 'withdrawal.reject', 'transaction', id, {
      amount: row.amount,
      reason: effectiveReason,
    });
    return row;
  }

  async settleWithdrawal(id: string, actor: Admin, providerRef: string) {
    const row = await this.transactions.settle(id, actor.id, providerRef);
    const user = await this.users.findById(row.userId);
    if (user) {
      void this.email.sendWithdrawalDecisionEmail(
        user.email,
        user.firstName,
        'paid',
        row.amount,
        row.currency,
      );
    }
    this.audit(actor.id, 'withdrawal.settle', 'transaction', id, {
      amount: row.amount,
      currency: row.currency,
      providerRef,
    });
    return row;
  }

  // ─── Ledger view (ADM-13) ─────────────────────────────────────────────────
  async listLedger(query: {
    userId?: string;
    walletId?: string;
    entryType?: string;
    page?: string;
    limit?: string;
  }) {
    return this.wallets.listEntries({
      userId: query.userId,
      walletId: query.walletId,
      entryType: query.entryType as undefined,
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '50', 10) || 50,
    });
  }

  // ─── Commission plans (ADM-10 · IB-06) ────────────────────────────────────
  // These values drive the commission engine, so every change is audited with
  // before/after — "who changed the L1 share" must be answerable.
  async listPrograms() {
    return this.programs.findAll();
  }

  async createProgram(input: ProgramInput, actor: Admin) {
    const row = await this.programs.create(input);
    this.audit(actor.id, 'program.create', 'ib_program', row.id, {
      name: row.name,
      mode: row.mode,
      method: row.method,
      commissionValue: row.commissionValue,
      l1Share: row.l1Share,
      l2Share: row.l2Share,
      settlementWindowHours: row.settlementWindowHours,
      rebateOnClose: row.rebateOnClose,
    });
    return row;
  }

  async updateProgram(id: string, input: ProgramInput, actor: Admin) {
    const before = await this.programs.findById(id);
    const row = await this.programs.update(id, input);
    this.audit(actor.id, 'program.update', 'ib_program', id, {
      before: {
        commissionValue: before.commissionValue,
        rebateValue: before.rebateValue,
        l1Share: before.l1Share,
        l2Share: before.l2Share,
        settlementWindowHours: before.settlementWindowHours,
        rebateOnClose: before.rebateOnClose,
      },
      after: {
        commissionValue: row.commissionValue,
        rebateValue: row.rebateValue,
        l1Share: row.l1Share,
        l2Share: row.l2Share,
        settlementWindowHours: row.settlementWindowHours,
        rebateOnClose: row.rebateOnClose,
      },
    });
    return row;
  }

  async setProgramActive(id: string, active: boolean, actor: Admin) {
    const row = await this.programs.setActive(id, active);
    this.audit(actor.id, active ? 'program.activate' : 'program.deactivate', 'ib_program', id, {
      name: row.name,
    });
    return row;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  private generateAdminTokens(admin: Admin) {
    const secret = this.config.get('ADMIN_JWT_SECRET', 'oxshare-admin-secret-dev');
    const accessToken = this.jwt.sign(
      { sub: admin.id, email: admin.email, role: admin.role },
      { secret, expiresIn: '8h' },
    );
    const refreshToken = this.jwt.sign({ sub: admin.id }, { secret, expiresIn: '30d' });
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
    res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, {
      ...cookieOpts,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
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

    // An unknown subject is a failed authentication, never a reason to fall back
    // to another account. The previous fallback to the seeded master admin meant
    // any token with any `sub` became a master-admin session, and deleting a
    // compromised admin did not revoke them.
    const admin = await this.admins.findById(adminId);
    if (!admin) throw new UnauthorizedException('Admin account not found.');

    // Compare against the stored hash. Without this the hash written at login
    // was decorative: logout cleared it but never checked it, so a stolen
    // 30-day refresh token stayed valid through logout and suspension.
    if (!admin.refreshToken) {
      throw new UnauthorizedException('Session has been revoked. Please log in again.');
    }
    const tokenMatches = await bcrypt.compare(providedToken, admin.refreshToken);
    if (!tokenMatches) {
      throw new UnauthorizedException('Refresh token is no longer valid. Please log in again.');
    }

    const { accessToken, refreshToken } = this.generateAdminTokens(admin);
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    await this.admins.update(admin.id, { refreshToken: refreshHash });

    this.setAdminCookies(res, accessToken, refreshToken);

    return { admin: await this.sanitize(admin), accessToken, refreshToken };
  }

  // ─── KYC Configurator ───────────────────────────────────────────────────────
  getKycConfig() {
    return this.kycConfig.getSteps();
  }

  updateKycConfig(steps: KycStepConfig[]) {
    return this.kycConfig.setSteps(steps);
  }

  addKycStep(stepData: Omit<KycStepConfig, 'id' | 'stepNumber'>) {
    return this.kycConfig.addStep(stepData);
  }

  updateKycStep(id: string, patch: Partial<KycStepConfig>) {
    return this.kycConfig.updateStep(id, patch);
  }

  deleteKycStep(id: string) {
    return this.kycConfig.deleteStep(id);
  }

  resetKycConfig() {
    return this.kycConfig.resetDefaults();
  }

  private async sanitize(admin: Admin) {
    const { passwordHash, refreshToken, ...safe } = admin;
    // Surface the LIVE permission set (role-derived when roleId is set) so the
    // frontend's nav gating always matches what the guards will enforce.
    return {
      ...safe,
      permissions: await this.roles.resolvePermissions(admin.roleId, admin.permissions),
    };
  }
}
