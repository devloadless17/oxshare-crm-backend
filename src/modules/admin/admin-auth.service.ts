import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';
import { Admin, AdminsStore, InvitesStore } from '../../store/admins.store';
import { RolesStore } from '../../store/roles.store';
import { EmailService } from '../email/email.service';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { AdminRbacService } from './admin-rbac.service';
import { CsrfService } from '../../common/security/csrf.service';
import {
  COOKIE_BASES,
  clearLegacySessionCookies,
  clearSessionCookie,
  csrfCookieOptions,
  readSessionCookie,
  sessionCookieNames,
  sessionCookieOptions,
} from '../../common/security/session-cookies';

const ACCESS_TTL_MS = 8 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Admin sessions and the invite lifecycle.
 *
 * Split out of a 726-line AdminService that owned fifteen unrelated concerns.
 * This is the one that matters most: it mints credentials, so it is the one
 * that most needs to be readable in a single screen and testable on its own.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly admins: AdminsStore,
    private readonly invites: InvitesStore,
    private readonly roles: RolesStore,
    private readonly audit: AdminAuditService,
    private readonly rbac: AdminRbacService,
    private readonly csrf: CsrfService,
  ) {}

  // ─── Admin Login ───────────────────────────────────────────────────────────
  async login(email: string, password: string, res: Response) {
    const admin = await this.admins.findByEmail(email);
    if (!admin) throw new AuthenticationError('Invalid credentials.');

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) throw new AuthenticationError('Invalid credentials.');

    const { accessToken, refreshToken } = this.generateAdminTokens(admin);
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    await this.admins.update(admin.id, { refreshToken: refreshHash });

    this.setAdminCookies(res, accessToken, refreshToken, admin.id);
    /*
     * The tokens are NOT in the body, deliberately.
     *
     * They live in httpOnly cookies set on this response (R-3.2), and returning
     * them here would hand JavaScript the very credential the cookie flag exists
     * to keep away from it — where it lands in browser memory, the network tab,
     * proxy logs and any error-reporting tool the page loads.
     *
     * It also had a concrete consequence: after the cookies became httpOnly, a
     * frontend still running the old build kept reading these fields and writing
     * its own JS-readable `admin_access_token` cookie from them. Cleaning the
     * browser and logging in again reproduced it every time. Removing the fields
     * makes that impossible rather than merely discouraged.
     */
    return { admin: await this.rbac.sanitize(admin) };
  }
  // ─── Admin Logout ──────────────────────────────────────────────────────────
  async logout(adminId: string, res: Response) {
    await this.admins.update(adminId, { refreshToken: undefined });
    clearSessionCookie(res, sessionCookieNames.adminAccess());
    clearSessionCookie(res, sessionCookieNames.adminRefresh());
    clearSessionCookie(res, sessionCookieNames.adminCsrf());
    clearLegacySessionCookies(res);
    return { message: 'Logged out.' };
  }
  // ─── Admin Me ──────────────────────────────────────────────────────────────
  async me(admin: Admin) {
    return await this.rbac.sanitize(admin);
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
      throw new ConflictError('An admin with this email already exists.');
    }

    // RBAC-07: the inviting admin chooses the role; RBAC-02: a sub-admin
    // holds only what is explicitly granted. Whatever the grant path — role,
    // explicit list, or the default — it must be grantable by the actor.
    let grantedPermissions = permissions;
    if (roleId) {
      const role = await this.roles.findById(roleId);
      if (!role) throw new NotFoundError('Role not found.');
      grantedPermissions = role.permissions;
    }
    await this.rbac.assertGrantable(actor, grantedPermissions ?? ['kyc.review', 'users.view']);
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
    this.audit.record(invitedBy, 'admin.invite', 'admin_invite', invite.id, {
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
    if (!invite) throw new NotFoundError('Invite not found or already used.');
    if (invite.accepted) throw new ValidationError('This invite has already been used.');
    if (invite.expiresAt < new Date()) throw new ValidationError('Invite has expired.');

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
    this.setAdminCookies(res, accessToken, refreshToken, admin.id);

    return { message: 'Account created. Welcome aboard!', admin: await this.rbac.sanitize(admin) };
  }
  // ─── Validate invite token (for UI pre-fill) ───────────────────────────────
  async validateInviteToken(token: string) {
    const invite = await this.invites.findByToken(token);
    if (!invite || invite.accepted || invite.expiresAt < new Date()) {
      throw new ValidationError('Invalid or expired invite token.');
    }
    return { email: invite.email, name: invite.name, role: invite.role };
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
  /**
   * Sets the session pair plus the anti-forgery token.
   *
   * Names and attributes come from common/security/session-cookies.ts — see the
   * §3.0 note there on why `__Host-` and app-unique names are load-bearing when
   * many OxShare sites share one registrable domain. Nothing here writes a
   * cookie name or a flag as a literal.
   *
   * The CSRF token is minted for THIS admin id and rotates on every login and
   * refresh, so it can never outlive the session it proves.
   */
  private setAdminCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
    adminId: string,
  ) {
    // Delete every superseded name first. Those cookies were httpOnly:false and
    // hold real JWTs, so a browser from the old build carries a JS-readable
    // session for up to 30 more days unless we actively remove it here.
    clearLegacySessionCookies(res);
    res.cookie(sessionCookieNames.adminAccess(), accessToken, sessionCookieOptions(ACCESS_TTL_MS));
    res.cookie(
      sessionCookieNames.adminRefresh(),
      refreshToken,
      sessionCookieOptions(REFRESH_TTL_MS),
    );
    res.cookie(
      sessionCookieNames.adminCsrf(),
      this.csrf.issue(adminId),
      csrfCookieOptions(CsrfService.TTL_MS),
    );
  }
  // ─── Admin Refresh ─────────────────────────────────────────────────────────
  async refresh(req: Request, res: Response) {
    const providedToken =
      // Cookie ONLY. The body and Authorization fallbacks are gone: two
      // credential channels for one session means two threat models, and the
      // root CLAUDE.md already described this path as cookie-only, which was
      // true of AdminGuard and false here (PLATFORM-CONVENTIONS R-3.1).
      readSessionCookie(
        req.cookies as Record<string, string | undefined> | undefined,
        COOKIE_BASES.adminRefresh,
      );

    if (!providedToken) throw new AuthenticationError('No refresh token provided.');

    let adminId: string;
    try {
      const secret = this.config.get('ADMIN_JWT_SECRET', 'oxshare-admin-secret-dev');
      const decoded = this.jwt.verify(providedToken, { secret });
      adminId = decoded.sub;
    } catch {
      throw new AuthenticationError('Invalid or expired admin refresh token.');
    }

    // An unknown subject is a failed authentication, never a reason to fall back
    // to another account. The previous fallback to the seeded master admin meant
    // any token with any `sub` became a master-admin session, and deleting a
    // compromised admin did not revoke them.
    const admin = await this.admins.findById(adminId);
    if (!admin) throw new AuthenticationError('Admin account not found.');

    // Compare against the stored hash. Without this the hash written at login
    // was decorative: logout cleared it but never checked it, so a stolen
    // 30-day refresh token stayed valid through logout and suspension.
    if (!admin.refreshToken) {
      throw new AuthenticationError('Session has been revoked. Please log in again.');
    }
    const tokenMatches = await bcrypt.compare(providedToken, admin.refreshToken);
    if (!tokenMatches) {
      throw new AuthenticationError('Refresh token is no longer valid. Please log in again.');
    }

    const { accessToken, refreshToken } = this.generateAdminTokens(admin);
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    await this.admins.update(admin.id, { refreshToken: refreshHash });

    this.setAdminCookies(res, accessToken, refreshToken, admin.id);

    /*
     * The tokens are NOT in the body, deliberately.
     *
     * They live in httpOnly cookies set on this response (R-3.2), and returning
     * them here would hand JavaScript the very credential the cookie flag exists
     * to keep away from it — where it lands in browser memory, the network tab,
     * proxy logs and any error-reporting tool the page loads.
     *
     * It also had a concrete consequence: after the cookies became httpOnly, a
     * frontend still running the old build kept reading these fields and writing
     * its own JS-readable `admin_access_token` cookie from them. Cleaning the
     * browser and logging in again reproduced it every time. Removing the fields
     * makes that impossible rather than merely discouraged.
     */
    return { admin: await this.rbac.sanitize(admin) };
  }
}
