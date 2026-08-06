import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';
import { Admin, AdminsStore, InvitesStore } from '../../store/admins.store';
import { RolesStore } from '../../store/roles.store';
import { EmailService } from '../email/email.service';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  SessionReplayedError,
  SessionRevokedError,
  SessionSupersededError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { AdminRbacService } from './admin-rbac.service';
import { randomUUID } from 'crypto';
import { CsrfService } from '../../common/security/csrf.service';
import { RefreshTokensService } from '../../common/security/refresh-tokens.service';
import { PasswordService } from '../../common/security/password.service';
import { LoginAttemptsService } from '../../common/security/login-attempts.service';
import {
  isTokenKind,
  TOKEN_ALGORITHM,
  TOKEN_ALGORITHMS,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_KIND,
} from '../../common/security/token-audience';
import {
  COOKIE_BASES,
  clearLegacySessionCookies,
  clearSessionCookie,
  csrfCookieOptions,
  readSessionCookie,
  sessionCookieNames,
  sessionCookieOptions,
} from '../../common/security/session-cookies';

/*
 * 15 minutes, not 8 hours — PLATFORM-CONVENTIONS R-3.3.
 *
 * An access token is checked by SIGNATURE on every request and against the
 * database only on REFRESH, so its lifetime is exactly how long a revoked
 * session keeps working: suspend an admin, and an 8-hour token kept them signed
 * in for the rest of the working day.
 *
 * 15 minutes is affordable because the refresh path is already built — both
 * frontends refresh proactively every 10 minutes and again on any 401, and
 * rotation now detects replay (R-3.3). The cost is one extra round trip per 15
 * minutes; the benefit is that revocation means something.
 */
const ACCESS_TTL_MS = 15 * 60 * 1000;
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
  private readonly logger = new Logger(AdminAuthService.name);

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
    private readonly refreshTokens: RefreshTokensService,
    private readonly passwords: PasswordService,
    private readonly loginAttempts: LoginAttemptsService,
  ) {}

  // ─── Admin Login ───────────────────────────────────────────────────────────
  async login(email: string, password: string, res: Response) {
    /*
     * Per-ACCOUNT lockout, checked before anything else — R-3.5.
     *
     * The @Throttle on this route is keyed on the IP, which bounds one attacker
     * on one address and does nothing about a distributed run against a single
     * admin account. This is the half that does. It is checked before the
     * password work so a locked account costs an attacker a round trip rather
     * than an argon2 hash.
     */
    const lockedFor = await this.loginAttempts.lockedFor('admin', email);
    if (lockedFor !== null) {
      throw new AuthenticationError(
        `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60_000)} minute(s).`,
      );
    }

    const admin = await this.admins.findByEmail(email);

    /*
     * Dual-read: accepts a stored bcrypt hash, then quietly replaces it with
     * argon2id (R-3.4). Nobody is forced to reset a password they already have,
     * and the bcrypt population drains as people log in.
     *
     * No early return for a missing admin: `undefined` makes PasswordService
     * spend the same argon2 work and answer false, so an unknown address is not
     * distinguishable from a wrong password by TIMING. That matters more here
     * than on the portal — enumerating admin addresses is the first step of a
     * credential-stuffing run against accounts that can approve payouts.
     */
    const { valid, needsRehash } = await this.passwords.verify(password, admin?.passwordHash);
    if (!admin || !valid) {
      // Recorded for identifiers that do not exist too — counting only real
      // accounts would make a lockout answer "does this admin exist?".
      await this.loginAttempts.recordFailure('admin', email);
      throw new AuthenticationError('Invalid credentials.');
    }

    /*
     * A suspended admin cannot sign in — the account-status half of R-3.3.
     *
     * Checked only AFTER the password matched, so this message never doubles as
     * confirmation that a credential was valid. Same ordering, and the same
     * reason, as the portal's suspension check in identity/auth.service.ts.
     */
    if (admin.status === 'suspended') {
      throw new AuthorizationError('This administrator account has been suspended.');
    }

    await this.loginAttempts.recordSuccess('admin', email);
    if (needsRehash) {
      const upgraded = await this.passwords.hash(password);
      await this.admins.update(admin.id, { passwordHash: upgraded });
      this.logger.log(`Upgraded password hash to argon2id for admin ${admin.id}`);
    }

    /*
     * The family id is minted HERE, before anything is signed, because the
     * access token has to carry it as `fam` — see `generateAdminTokens`.
     */
    const familyId = randomUUID();
    const { accessToken, refreshToken, jti } = this.generateAdminTokens(admin, familyId);
    await this.refreshTokens.record({
      surface: 'admin',
      subjectId: admin.id,
      jti,
      token: refreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      familyId,
    });

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
  /**
   * Ends the session, and WORKS WHEN THE ACCESS TOKEN HAS ALREADY EXPIRED.
   *
   * It did not. This route sat behind `AdminGuard`, so a fifteen-minute-old
   * access token meant 401 and **no cookies cleared** — the admin was left
   * holding a live thirty-day refresh cookie with no server-side way to drop it.
   *
   * The path a person actually hits: a laptop sleeps past fifteen minutes, so
   * the proactive timer never ran; the first thing they do on waking is click
   * Log out; it 401s twice and the console says "could not sign out" — on the
   * machine they are about to walk away from.
   *
   * Two decisions make this safe without the guard:
   *
   *  - **Identity comes from the REFRESH cookie**, which lives thirty days and
   *    is therefore present in exactly the case the guard failed. It is fully
   *    verified — signature, audience, issuer, algorithm and kind — so this
   *    cannot be used to revoke somebody else's sessions.
   *  - **Cookies are cleared unconditionally**, even when nothing verifies.
   *    Clearing a cookie is not a privileged act, and refusing to do it for
   *    someone whose credential is already worthless only leaves rubbish in
   *    their browser.
   *
   * Origin validation still runs on this route — `@NoCsrf` waives the token, not
   * the origin check (`csrf.guard.ts`) — so a cross-site page cannot use it to
   * sign somebody out.
   */
  async logout(req: Request, res: Response) {
    const adminId = this.subjectFromRefreshCookie(req);
    if (adminId) {
      // Revokes EVERY family for this admin, not just the one presenting a
      // token: logging out on one device must not leave the others live (R-3.3).
      await this.refreshTokens.revokeAllForSubject('admin', adminId);
    }
    clearSessionCookie(res, sessionCookieNames.adminAccess());
    clearSessionCookie(res, sessionCookieNames.adminRefresh());
    clearSessionCookie(res, sessionCookieNames.adminCsrf());
    clearLegacySessionCookies(res);
    return { message: 'Logged out.' };
  }

  /**
   * The admin a refresh cookie belongs to, or null if it proves nothing.
   *
   * Verified in full rather than decoded: an unverified `sub` would let anyone
   * end anyone's sessions by writing their own cookie.
   */
  private subjectFromRefreshCookie(req: Request): string | null {
    const token = readSessionCookie(
      req.cookies as Record<string, string | undefined> | undefined,
      COOKIE_BASES.adminRefresh,
    );
    if (!token) return null;
    try {
      const decoded = this.jwt.verify<{ sub: string; typ?: string }>(token, {
        secret: this.config.getOrThrow<string>('ADMIN_JWT_REFRESH_SECRET'),
        audience: TOKEN_AUDIENCE.admin,
        issuer: TOKEN_ISSUER,
        algorithms: TOKEN_ALGORITHMS,
      });
      return isTokenKind(decoded, TOKEN_KIND.refresh) ? decoded.sub : null;
    } catch {
      // Expired or forged. The cookies still get cleared by the caller — there
      // is simply no session left to revoke server-side.
      return null;
    }
  }
  // ─── Admin Me ──────────────────────────────────────────────────────────────
  async me(admin: Admin) {
    return await this.rbac.sanitize(admin);
  }
  // ─── Create Invite ─────────────────────────────────────────────────────────
  async createInvite(
    rawEmail: string,
    name: string,
    actor: Admin,
    roleId?: string,
    permissions?: string[],
  ) {
    /*
     * One canonical spelling from here down.
     *
     * The duplicate checks below, the stored invite row, the address the link is
     * emailed to and the account eventually created must all agree on the same
     * string, or each guard protects a different key. AdminsStore normalises on
     * write too — this normalises early so `findPendingByEmail` is not the one
     * comparison left doing an exact match on whatever was typed.
     */
    const email = rawEmail.toLowerCase();

    if (await this.admins.findByEmail(email)) {
      throw new ConflictError('An admin with this email already exists.');
    }
    /*
     * One live invite per address.
     *
     * `admin_invites.email` is not unique, so this used to be allowed. Both
     * tokens validated, the first accept created the account, and the second —
     * a real person following a real link they were sent — hit the unique
     * constraint on `admins.email` and got a 500 at the final step.
     *
     * Refusing here rather than de-duplicating on accept keeps the failure with
     * the administrator who can fix it, at the moment they can fix it. Revoke the
     * outstanding invite to re-send.
     */
    const pending = await this.invites.findPendingByEmail(email);
    if (pending) {
      throw new ConflictError(
        'An invite for this email is already outstanding. Revoke it before sending another.',
      );
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
    /*
     * Belt and braces against the unique constraint on `admins.email`.
     *
     * createInvite now refuses a second outstanding invite, so the ordinary
     * route to this state is closed. It is still reachable — an invite sent,
     * then the same person added by another path before they clicked — and the
     * difference between a clean message and a 500 is what the invitee sees at
     * the end of onboarding. A DB constraint is the right guard; it is not the
     * right error message.
     */
    if (await this.admins.findByEmail(invite.email)) {
      throw new ConflictError('An admin with this email already exists.');
    }

    const passwordHash = await this.passwords.hash(password);
    const admin = await this.admins.create({
      email: invite.email,
      passwordHash,
      name: invite.name,
      role: 'sub_admin',
      roleId: invite.roleId,
      permissions: invite.permissions ?? ['kyc.review', 'users.view'],
      status: 'active',
    });

    await this.invites.markAccepted(token);

    /*
     * The moment an ADMINISTRATOR ACCOUNT COMES INTO EXISTENCE, and it was the
     * one privileged event with no audit row at all.
     *
     * `admin.invite` recorded that somebody was asked; nothing recorded that
     * they arrived. So "when did this administrator get access, and with what"
     * was answerable only from `admins.created_at`, which says nothing about
     * the permissions they were granted or who invited them.
     *
     * The actor is the NEW ADMIN — they performed this action, from their own
     * address — and `invitedBy` names who authorised it. Recording the inviter
     * as the actor would put somebody else's name and IP on an action they were
     * not present for.
     */
    this.audit.record(admin.id, 'admin.invite_accept', 'admin', admin.id, {
      email: admin.email,
      invitedBy: invite.invitedBy,
      roleId: invite.roleId,
      permissions: admin.permissions,
    });

    // Minted before signing, so the access token can carry it as `fam` — the
    // same reason as `login`.
    const familyId = randomUUID();
    const { accessToken, refreshToken, jti } = this.generateAdminTokens(admin, familyId);
    await this.refreshTokens.record({
      surface: 'admin',
      subjectId: admin.id,
      jti,
      token: refreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      familyId,
    });
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

  // ─── Outstanding invites ──────────────────────────────────────────────────
  /**
   * Who has been asked and has not yet arrived.
   *
   * Without this an invite vanished the moment it was sent: the directory lists
   * accepted administrators only, so there was no way to tell whether someone
   * had been invited, whether they had accepted, or when the link died. The
   * honest answer to "did you invite Sam?" was to search your sent mail.
   *
   * Never returns the token or its hash — this is a list for deciding, not a
   * second delivery channel for a credential that belongs in one mailbox.
   */
  async listPendingInvites() {
    const invites = await this.invites.findAllPending();
    return invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      name: invite.name,
      roleId: invite.roleId,
      invitedBy: invite.invitedBy,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    }));
  }

  /**
   * Revoke an outstanding invite — the undo for a wrong address or a changed mind.
   *
   * An invite is a 48-hour bearer credential that CREATES AN ADMIN ACCOUNT on a
   * system that approves payouts. Sending one to a mistyped address and having
   * no way to cancel it is the gap this closes; the alternative was waiting out
   * the expiry and hoping.
   */
  async revokeInvite(id: string, actor: Admin) {
    const invite = await this.invites.findById(id);
    if (!invite) throw new NotFoundError('Invite not found.');
    if (invite.accepted) {
      // The account exists; revoking the invite would change nothing and imply
      // it had. Suspend the administrator instead.
      throw new ValidationError(
        'This invite has already been accepted. Suspend the administrator instead.',
      );
    }

    await this.invites.deleteById(id);
    this.audit.record(actor.id, 'admin.invite_revoke', 'admin_invite', id, {
      email: invite.email,
      roleId: invite.roleId,
    });
    return { message: `Invite for ${invite.email} revoked.` };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  private generateAdminTokens(admin: Admin, familyId: string) {
    // Two keys, matching the portal. Signing both kinds with one key meant a
    // refresh token verified anywhere an access token did — see
    // common/security/token-audience.ts. `typ` below closes that on its own;
    // separate keys mean neither mechanism is load-bearing alone.
    const accessSecret = this.config.getOrThrow<string>('ADMIN_JWT_SECRET');
    const refreshSecret = this.config.getOrThrow<string>('ADMIN_JWT_REFRESH_SECRET');
    // aud/iss so a token minted for the admin surface cannot verify on the
    // portal even if the two ever end up sharing a secret (R-3.1).
    // The algorithm is named on the way out as well as the way in, so signing
    // and verification cannot drift apart.
    const claims = {
      audience: TOKEN_AUDIENCE.admin,
      issuer: TOKEN_ISSUER,
      algorithm: TOKEN_ALGORITHM,
    };
    // `typ` so the two KINDS cannot be confused either. Both are signed with
    // ADMIN_JWT_SECRET, so without this the 30-day refresh token below verifies
    // anywhere the 15-minute access token does — see token-audience.ts.
    //
    // `fam` names the login. Without it, revoking a session reached the refresh
    // family only, so "sign out that device" and reuse detection both left the
    // other browser working for up to fifteen minutes — on the console that
    // approves payouts. The portal has carried this since 6 Aug; this surface
    // did not. Tokens minted before this change carry no `fam` and are refused,
    // so every live admin session ends once, at deploy.
    const accessPayload = {
      sub: admin.id,
      email: admin.email,
      role: admin.role,
      typ: TOKEN_KIND.access,
      fam: familyId,
    };
    const accessToken = this.jwt.sign(accessPayload, {
      secret: accessSecret,
      expiresIn: '15m',
      ...claims,
    });
    // The refresh token carries a `jti` naming its row in refresh_tokens, which
    // is how a presented token finds out whether it has already been rotated
    // (R-3.3). Minted here so signing stays in one place; the row is written by
    // the caller, which knows whether this starts a family or continues one.
    const jti = randomUUID();
    const refreshToken = this.jwt.sign(
      { sub: admin.id, jti, typ: TOKEN_KIND.refresh },
      { secret: refreshSecret, expiresIn: '30d', ...claims },
    );
    return { accessToken, refreshToken, jti };
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

    /*
     * Every failure below is `SESSION_REVOKED`, and they are deliberately NOT
     * told apart: no cookie, a bad signature and a thirty-day expiry all mean
     * the same thing to a client — this cannot be renewed, sign in again — and
     * saying WHICH to an unauthenticated caller is a tutorial on the rest.
     */
    if (!providedToken) throw new SessionRevokedError('No refresh token provided.');

    let adminId: string;
    let jti: string | undefined;
    try {
      const decoded = this.jwt.verify<{ sub: string; jti?: string; typ?: string }>(providedToken, {
        secret: this.config.getOrThrow<string>('ADMIN_JWT_REFRESH_SECRET'),
        audience: TOKEN_AUDIENCE.admin,
        issuer: TOKEN_ISSUER,
        // Stated, never inherited from the key type — see token-audience.ts.
        algorithms: TOKEN_ALGORITHMS,
      });
      // An ACCESS token must not buy a new session pair here either — the
      // confusion has to be refused in both directions to be worth anything.
      if (!isTokenKind(decoded, TOKEN_KIND.refresh)) {
        throw new SessionRevokedError('Invalid or expired admin refresh token.');
      }
      adminId = decoded.sub;
      jti = decoded.jti;
    } catch {
      throw new SessionRevokedError('Invalid or expired admin refresh token.');
    }

    // An unknown subject is a failed authentication, never a reason to fall back
    // to another account. The previous fallback to the seeded master admin meant
    // any token with any `sub` became a master-admin session, and deleting a
    // compromised admin did not revoke them.
    const admin = await this.admins.findById(adminId);
    if (!admin) throw new SessionRevokedError('Admin account not found.');

    /*
     * The token's own row decides — R-3.3.
     *
     * This replaces comparing against a single stored hash, which could express
     * "matches" or "does not match" and nothing else. A replayed token simply
     * failed to match, so an attacker holding a stolen token just used the newer
     * one they had also captured, and nothing recorded that anything had leaked.
     */
    // A token with no `jti` predates R-3.3 and has no row to judge. Refusing it
    // logs those sessions out once, which is the correct migration cost for
    // credentials that cannot be checked for replay.
    if (!jti) {
      throw new SessionRevokedError('Session has been revoked. Please log in again.');
    }

    const verdict = await this.refreshTokens.verify({
      surface: 'admin',
      jti,
      token: providedToken,
    });

    if (verdict.outcome === 'reused') {
      // The family is already revoked by verify(). Say the same thing to the
      // legitimate user and to the attacker: which one this is, is exactly what
      // we cannot tell.
      throw new SessionReplayedError(
        'This session has been ended for security reasons. Please log in again.',
      );
    }
    if (verdict.outcome !== 'ok' && verdict.outcome !== 'retried') {
      throw new SessionRevokedError('Session has been revoked. Please log in again.');
    }

    /*
     * A suspended admin does not get a new session pair.
     *
     * The portal has checked this on refresh since it was written; this surface
     * did not, so suspending an administrator stopped them at the guard on the
     * next request and then handed them a fresh fifteen-minute token every time
     * they refreshed — for thirty days. The account that can approve payouts was
     * the one where revocation leaked.
     *
     * Belt and braces, exactly as the portal does it: revoke every family too,
     * so a token minted before the suspension cannot survive on this path
     * either.
     */
    if (admin.status === 'suspended') {
      await this.refreshTokens.revokeAllForSubject('admin', admin.id);
      throw new SessionRevokedError('This administrator account has been suspended.');
    }

    /*
     * Which row this rotation consumes — see the portal's twin of this comment.
     * On a `retried` verdict the presented token was consumed by a rotation the
     * client never received, so we consume its successor instead.
     */
    const jtiToRotate = verdict.outcome === 'retried' ? verdict.successorJti : jti;

    // The SAME family: rotation continues one login. The new access token has to
    // carry the id the old one did, or revoking that session would stop reaching
    // it after the next refresh.
    const {
      accessToken,
      refreshToken,
      jti: nextJti,
    } = this.generateAdminTokens(admin, verdict.familyId);
    const rotated = await this.refreshTokens.rotate({
      surface: 'admin',
      jti: jtiToRotate,
      familyId: verdict.familyId,
      subjectId: admin.id,
      jtiNext: nextJti,
      nextToken: refreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    });
    /*
     * Lost a race with a concurrent refresh using the same token. Handing out a
     * second live session here is exactly what the conditional update prevents.
     *
     * The session is ALIVE — the winner rotated it and its cookies are already
     * in this browser's jar, because tabs share one. `SESSION_SUPERSEDED` tells
     * the client to retry; answering "revoked" is how two tabs waking together
     * ejected one of them from a valid thirty-day session.
     */
    if (!rotated) {
      throw new SessionSupersededError(
        'This session was renewed by another request. Please retry.',
      );
    }

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
