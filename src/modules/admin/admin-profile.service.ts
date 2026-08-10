import { Injectable, Logger } from '@nestjs/common';
import { AdminsStore } from '../../store/admins.store';
import { PasswordService } from '../../common/security/password.service';
import { RefreshTokensService } from '../../common/security/refresh-tokens.service';
import {
  StoredFilesService,
  AVATAR_BUCKET,
  adminAvatarUrl,
} from '../../common/uploads/stored-files.service';
import { AdminAuditService } from './admin-audit.service';
import {
  AuthenticationError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';

/**
 * What an administrator may do to their OWN account.
 *
 * ── Why this is a separate service from AdminRbacService ───────────────────
 *
 * Everything in that one is an administrator acting on SOMEBODY ELSE, and every
 * method there begins by refusing self-service — you cannot rewrite your own
 * permissions, suspend yourself, or reset your own password, because each of
 * those would turn a stolen session into a permanent one.
 *
 * This is the mirror image: the caller is always the subject, and the questions
 * are different ones. Mixing them would mean each method starting with "is the
 * actor the target, and is that good or bad here", which is exactly the sort of
 * conditional that eventually gets the sign wrong.
 *
 * ── It mirrors the portal, deliberately ────────────────────────────────────
 *
 * `identity/auth.service.ts` has had all four of these for clients. The
 * semantics are copied rather than reinvented — same cutoff arithmetic, same
 * refusal to end your current session through the session list, same
 * magic-byte validation on the avatar. Where the two differ it is because the
 * admin surface is more privileged, never less.
 */
@Injectable()
export class AdminProfileService {
  private readonly logger = new Logger(AdminProfileService.name);

  constructor(
    private readonly admins: AdminsStore,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly files: StoredFilesService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Change your own password, ending every other session immediately.
   *
   * @param reissue Called with the admin once the change lands, so the caller
   * can be handed a fresh session on the same response. See below for why they
   * are re-issued rather than spared.
   */
  async changePassword(
    adminId: string,
    currentPassword: string,
    newPassword: string,
    reissue: (adminId: string) => Promise<void>,
  ): Promise<{ message: string }> {
    const admin = await this.admins.findById(adminId);
    // The guard already resolved this admin, so absence means the row went away
    // between the guard and here. An auth failure, not a 404.
    if (!admin) {
      throw new AuthenticationError('Your session is no longer valid. Please sign in.');
    }

    const { valid } = await this.passwords.verify(currentPassword, admin.passwordHash);
    if (!valid) {
      this.logger.warn(
        `Password change refused for ${admin.email}: current password did not match`,
      );
      throw new ValidationError('Your current password is not correct.');
    }

    /*
     * Refused rather than silently accepted.
     *
     * A "change" that changes nothing leaves somebody believing they have
     * rotated a credential they may have just read aloud, and it signs out
     * their other sessions for no gain. Compared against the stored HASH rather
     * than the submitted string, so it also catches both fields being filled
     * from a password manager.
     */
    const { valid: unchanged } = await this.passwords.verify(newPassword, admin.passwordHash);
    if (unchanged) {
      throw new ValidationError('Your new password must be different from your current one.');
    }

    await this.admins.update(admin.id, {
      passwordHash: await this.passwords.hash(newPassword),
      /*
       * The cutoff that makes "every other session is signed out" true NOW.
       *
       * Revoking the refresh families below only stops those sessions RENEWING;
       * each keeps working on its already-issued access token for up to fifteen
       * more minutes. On the console that approves withdrawals, those fifteen
       * minutes are exactly what somebody changing their password under duress
       * is trying to prevent. `AdminAuthenticator` enforces it per request.
       */
      passwordChangedAt: new Date(),
    });

    /*
     * A pending reset link is a live second key to this account. Somebody
     * changing their password because they fear compromise must not leave one
     * sitting in an inbox the attacker may also hold.
     */
    await this.admins.clearResetToken(admin.id);

    /*
     * EVERY family, including the caller's own — then a brand new session.
     *
     * Sparing the caller's family looks kinder and does not work: the cutoff
     * above does not know whose token it is looking at, so it would sign them
     * out of the very device they just proved their old password on. Exempting
     * them from the cutoff instead would mean the cutoff has an exception, and
     * an exception is a hole — any token waved through is one an attacker might
     * be holding.
     *
     * So the cutoff stays absolute and the caller is re-issued. They keep
     * working because they are given something NEW, not because something old
     * was spared.
     */
    const revoked = await this.refreshTokens.revokeAllForSubject('admin', admin.id);
    await reissue(admin.id);

    this.audit.record(admin.id, 'admin.password_change', 'admin', admin.id, {
      sessionsEnded: revoked,
    });
    this.logger.log(`${admin.email} changed their password; ${revoked} session(s) ended`);

    return { message: 'Your password has been changed and your other sessions signed out.' };
  }

  /** Your own live sessions, most recently active first. */
  async listSessions(adminId: string, currentFamilyId: string | null) {
    const sessions = await this.refreshTokens.listSessions('admin', adminId);
    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      userAgent: session.userAgent,
      ip: session.ip,
      /** The one this request is on — the console labels it and hides its button. */
      current: session.id === currentFamilyId,
    }));
  }

  /** End one of your other sessions. */
  async revokeSession(adminId: string, familyId: string, currentFamilyId: string | null) {
    /*
     * Ending your CURRENT session here is refused and pointed at sign-out.
     *
     * It would otherwise half-work: the family dies, the httpOnly cookies stay
     * in the browser, and the console sits rendered until the next request
     * 401s. Sign-out is the operation that both revokes and clears the cookies,
     * and it is in the same menu.
     */
    if (currentFamilyId && familyId === currentFamilyId) {
      throw new ValidationError('That is the session you are using now. Use Sign out to end it.');
    }

    /*
     * Ownership is enforced INSIDE the update, not by a preceding select, so
     * there is no check-then-act window and a family belonging to another
     * administrator matches nothing at all.
     */
    const revoked = await this.refreshTokens.revokeFamilyForSubject('admin', adminId, familyId);
    if (revoked === 0) throw new NotFoundError('That session no longer exists.');

    this.audit.record(adminId, 'admin.session_revoke', 'admin', adminId, { familyId });
    this.logger.log(`Admin session ${familyId} revoked by its owner (${revoked} token(s))`);

    return { message: 'That session has been signed out.' };
  }

  /**
   * Set or replace the profile photo.
   *
   * The accepted TYPES are decided from the file's own magic bytes inside
   * `StoredFilesService`, never from the multipart Content-Type — that header
   * is a claim by whoever is uploading, and an HTML document declared
   * `image/png` is how a stored file becomes stored XSS on the console that
   * approves withdrawals.
   */
  async setAvatar(adminId: string, bytes: Buffer, declaredMimeType: string) {
    const admin = await this.admins.findById(adminId);
    if (!admin) throw new AuthenticationError('Your session is no longer valid. Please sign in.');

    const stored = await this.files.write(AVATAR_BUCKET, bytes, declaredMimeType);

    // The OLD file is removed only after the new one is safely written and the
    // row points at it: a failure in between must not leave the administrator
    // with no photo and no way back to the one they had.
    const previous = admin.avatarFilename;
    await this.admins.update(adminId, { avatarFilename: stored.filename });
    await this.files.remove(AVATAR_BUCKET, previous);

    this.audit.record(adminId, 'admin.avatar_change', 'admin', adminId, {
      mimeType: stored.mimeType,
      size: stored.size,
    });
    this.logger.log(`Avatar updated for ${admin.email} (${stored.mimeType}, ${stored.size} bytes)`);
    return { avatarUrl: adminAvatarUrl(stored.filename) };
  }

  /** Remove the photo. The console falls back to initials, never a placeholder. */
  async removeAvatar(adminId: string) {
    const admin = await this.admins.findById(adminId);
    if (!admin) throw new AuthenticationError('Your session is no longer valid. Please sign in.');

    if (admin.avatarFilename) {
      await this.admins.update(adminId, { avatarFilename: undefined });
      await this.files.remove(AVATAR_BUCKET, admin.avatarFilename);
      this.audit.record(adminId, 'admin.avatar_change', 'admin', adminId, { removed: true });
    }

    return { avatarUrl: null };
  }

  /*
   * There is no `profile()` here, deliberately.
   *
   * The first cut had one, returning the caller's name, role name, status,
   * avatar and password age — every field of which `GET /admin/auth/me` already
   * returned or trivially could. Two endpoints answering "who am I" is two
   * places to keep in step, and the console would have called both on the same
   * screen. `AdminRbacService.sanitize` gained `avatarUrl` and
   * `passwordChangedAt` instead, so the avatar is on every page load with no
   * second round trip — which is what the sidebar needs anyway.
   */
}
