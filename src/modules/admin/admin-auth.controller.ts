// Part of the `admin` controller surface, split by concern.
//
// admin.controller.ts had grown to 717 lines fronting six already well-separated
// services. Nest allows several controllers to share one @Controller prefix, so
// this split changes no route path — test/openapi-routes.spec.ts asserts the full
// 69-route inventory is byte-identical, which is what made the split safe to do.
//
// All guards here are per-route; there is no class-level @UseGuards to preserve.
// @ApiTags('admin') is repeated on each class so Swagger still groups them as one
// tag and the generated types.gen.ts is unchanged.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiConsumes, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { clientIp } from '../../common/security/client-ip';
import { Request, Response } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { deviceOf } from '../../common/security/device-fingerprint';
import { AdminProfileService } from './admin-profile.service';
import { Admin } from '../../store/admins.store';
import { AVATAR_BUCKET } from '../../common/uploads/stored-files.service';
import { ValidationError } from '../../common/errors/domain-errors';
import {
  AdminChangePasswordDto,
  AdminUpdateProfileDto,
  CompleteAdminResetDto,
  AcceptInviteDto,
  AdminLoginDto,
  AdminTotpChallengeDto,
  AdminTotpVerifyDto,
  InviteDto,
  ValidateInviteQueryDto,
} from './dto/requests/auth.dto';
import {
  AdminAvatarResponseDto,
  AdminLoginResponseDto,
  AdminSignInChallengeDto,
  AdminTotpSetupDto,
  AcceptInviteResponseDto,
  AdminProfileDto,
  AdminProfileNameDto,
  AdminSessionDto,
  InviteResponseDto,
  InviteValidationDto,
  MessageResponseDto,
  PendingInviteDto,
} from './dto/responses.dto';
import {
  AnyAdmin,
  AdminGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { NoCsrf } from '../../common/security/csrf.guard';
import { UuidParam } from '../../common/query-params';
import { NotClientScoped } from './guards/client-scope.decorator';
import { Audited, NotAudited } from './guards/audited.decorator';

/** Admin sign-in, session refresh and the invitation flow. */
@ApiTags('admin')
@Controller('admin')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly profile: AdminProfileService,
  ) {}

  // ── Auth ──────────────────────────────────────────────────────────────────
  @NoCsrf(
    'Establishing a session cannot be a forgery of one: there is nothing yet to ' +
      'protect. Requiring a token here also creates a lockout — an expired or ' +
      'absent token would make it impossible to log in and obtain a fresh one.',
  )
  @Post('auth/login')
  // Master-admin credentials: 5 attempts per minute per IP. Unprotected before.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin login, step one: the password (then the authenticator code)',
    description:
      'A right password sets NO session. It answers with a short-lived challenge: ' +
      '`step: "totp"` → send the 6-digit code to `auth/totp/verify`; `step: "totp_setup"` → ' +
      'no authenticator yet, call `auth/totp/setup` for the QR code first.',
  })
  @ApiOkResponse({ type: AdminSignInChallengeDto })
  @NotClientScoped('Public credential exchange. No client rows are read.')
  @NotAudited(
    'Success and failure both land in `login_attempts`, which is the table built for credential events and carries the lockout counter. Duplicating them here would flood the action log with the one event that already has a home.',
  )
  login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    // The caller's address — RBAC-08 decides which door answers (0192).
    return this.auth.login(dto.email, dto.password, clientIp(req));
  }

  @NoCsrf(
    'Half-way through signing in there is no session yet, so there is no anti-forgery ' +
      'token to send. The challenge token in the body is what proves the password step.',
  )
  @Post('auth/totp/setup')
  // Each call mints a new secret; ten a minute is far above a person reloading.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin login, enrolment: a new authenticator secret as a QR code',
    description:
      'Only while the account has no authenticator. Each call replaces the previous ' +
      'secret, so only the newest QR code can finish enrolment.',
  })
  @ApiOkResponse({ type: AdminTotpSetupDto })
  @NotClientScoped(
    'Writes the calling administrator their own pending secret; reads no client rows.',
  )
  @NotAudited(
    'Shows a secret that does nothing until a code from it is confirmed; the confirmation is the event, recorded as `admin.totp_enroll` by `auth/totp/verify`.',
  )
  beginTotpSetup(@Body() dto: AdminTotpChallengeDto, @Req() req: Request) {
    return this.auth.beginTotpSetup(dto.challengeToken, clientIp(req));
  }

  @NoCsrf(
    'Establishing a session cannot be a forgery of one: there is nothing yet to ' +
      'protect. The challenge token in the body is what proves the password step.',
  )
  @Post('auth/totp/verify')
  // A credential guess, exactly like the password: 5 a minute per IP, and the
  // per-account lockout behind it.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin login, step two: the 6-digit authenticator code — starts the session',
  })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  @NotClientScoped('Public credential exchange. No client rows are read.')
  @NotAudited(
    'A sign-in: success and failure land in `login_attempts`, like the password. The one lasting change — an authenticator confirmed for the first time — the service records as `admin.totp_enroll`.',
  )
  verifyTotp(
    @Body() dto: AdminTotpVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.verifyTotp(dto.challengeToken, dto.code, res, deviceOf(req), clientIp(req));
  }

  @NoCsrf(
    'Rotating a session the caller already holds grants no new authority, and a ' +
      'refresh must keep working when the CSRF token has expired alongside the ' +
      'access token — otherwise a returning user is locked out rather than renewed.',
  )
  @Post('auth/refresh')
  // Same reasoning as the portal's refresh route (R-3.5): CSRF-exempt by
  // design, hashes on every call, and was left at the global 120/min. 20/min is
  // far above any real admin session and puts a ceiling on the cost.
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin refresh token' })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  @NotClientScoped('Token rotation only; reads no client rows.')
  @NotAudited(
    'Token rotation, every fifteen minutes per signed-in admin. Recording it would bury every real action under machine noise, and reuse detection already alarms on the case that matters.',
  )
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req, res);
  }

  @NoCsrf(
    'Ending a session is not an attack worth defending against, and blocking it ' +
      'when the token is missing would leave a user unable to log out — strictly ' +
      'worse for them than the nuisance it prevents.',
  )
  @AnyAdmin(
    'Ending your own session requires no privilege beyond having one, and gating it behind a ' +
      'permission would leave an admin unable to log out of a panel they can already see.',
  )
  @Post('auth/logout')
  /*
   * NO AdminGuard, deliberately — see `AdminAuthService.logout`.
   *
   * Behind the guard, an expired access token meant 401 and no cookies cleared,
   * so an admin returning to a slept laptop could not sign out at all. Identity
   * is taken from the fully-verified refresh cookie instead, and the cookies are
   * cleared either way. Origin validation still applies: `@NoCsrf` waives the
   * anti-forgery token, not the origin check.
   */
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Admin logout' })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped("Revokes the caller's own session; reads no client rows.")
  @NotAudited(
    "Ends the calling administrator's own session and changes nothing another administrator could later need explained.",
  )
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req, res);
  }

  @AnyAdmin(
    'Returns the caller their OWN profile and resolved permissions. Every admin needs it on ' +
      'every page load — it is what the nav gates on — and it exposes nothing they do not already hold.',
  )
  @Get('auth/me')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current admin' })
  @ApiOkResponse({ type: AdminProfileDto })
  @NotClientScoped(
    "Returns the CALLING ADMIN's own profile, which is an admins row, not a client one.",
  )
  me(@Req() req: Request & { admin: Admin }) {
    return this.auth.me(req.admin);
  }

  // ── Invite ────────────────────────────────────────────────────────────────
  @Post('invite')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('admins.create')
  /*
   * Throttled like the other route on this controller that emails a credential.
   *
   * It sends outbound mail to a caller-named address and mints a 48-hour bearer
   * token that CREATES AN ADMINISTRATOR ACCOUNT — and carried no limit but the
   * global 120/min, while `users/:id/password-reset` directly below, the same
   * "send an admin an email with a link in it" shape, has been capped at 5/min
   * throughout.
   *
   * `admins.create` bounds WHO, not HOW OFTEN, and the two are different
   * questions: the duplicate-suppression in `createInvite` bounds repeats to one
   * live invite per ADDRESS, which does nothing about a thousand distinct ones.
   * The cost of that is a mail reputation burned by a compromised session and a
   * thousand live admin-creating tokens.
   */
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Invite a new sub-admin with a role or explicit permissions (requires admins.create)',
  })
  @ApiOkResponse({ type: InviteResponseDto })
  @NotClientScoped('Creates an admin_invites row. Administrators are not clients.')
  @Audited('admin.invite')
  invite(@Body() dto: InviteDto, @Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.auth.createInvite(
      dto.email,
      dto.name,
      req.admin,
      dto.roleId,
      dto.permissions,
      dto.maskedFields,
      dto.scopedTagIds,
      dto.seesUntriaged,
      dto.seesAllClients,
    );
  }

  /*
   * Listed under users.VIEW, not admins.create.
   *
   * Reading who is outstanding is the same class of act as reading the admin
   * directory — it is the other half of "who can operate this system". Gating it
   * on admins.create would mean an operator who can see every administrator
   * cannot see that three more are one click from existing.
   */
  @Get('invites')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('admins.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List outstanding invites (requires admins.view)' })
  @ApiOkResponse({ type: [PendingInviteDto] })
  @NotClientScoped('Lists admin_invites. Administrators are not clients.')
  listInvites() {
    return this.auth.listPendingInvites();
  }

  @Delete('invites/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('admins.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Revoke an outstanding invite (requires admins.create)',
    description:
      'Kills the accept link immediately. Whoever may create an invite may cancel one — ' +
      'the undo for a mistyped address, on a 48-hour credential that creates an admin account.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped('Deletes an admin_invites row. Administrators are not clients.')
  @Audited('admin.invite_revoke')
  revokeInvite(@Param('id', UuidParam) id: string, @Req() req: Request & { admin: Admin }) {
    return this.auth.revokeInvite(id, req.admin);
  }

  @Get('invite/validate')
  // Unauthenticated and returns invitee PII for a valid token — a guessing
  // oracle without a throttle.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Validate invite token — returns email and name for pre-fill',
  })
  @ApiOkResponse({ type: InviteValidationDto })
  @NotClientScoped('Public invite-token check; reads admin_invites only.')
  validateInvite(@Query() query: ValidateInviteQueryDto) {
    return this.auth.validateInviteToken(query.token);
  }

  @NoCsrf(
    'Establishing a session cannot be a forgery of one: there is nothing yet to ' +
      'protect. Requiring a token here also creates a lockout — an expired or ' +
      'absent token would make it impossible to log in and obtain a fresh one.',
  )
  @Post('invite/accept')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept invite and set password — then set up the authenticator to sign in',
    description:
      'Creates the account and answers with the same challenge a correct password buys at ' +
      'login (`step: "totp_setup"`). No session until the authenticator code checks.',
  })
  @ApiOkResponse({ type: AcceptInviteResponseDto })
  @NotClientScoped('Creates an administrator from an invite; reads no client rows.')
  @Audited('admin.invite_accept')
  acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    return this.auth.acceptInvite(dto.token, dto.password, req);
  }

  /**
   * Start a password reset for another administrator — D-44.
   *
   * `admins.reset` — its own key, and deliberately not `admins.create`.
   *
   * ⚠️ This paragraph named `admins.create` and explained why that was the right
   * grant, directly above a decorator requiring `admins.reset`. Arming a reset
   * link for another administrator is a different act from inviting one, and the
   * catalogue has separated them; the comment was describing the arrangement
   * before it did.
   *
   * The permission is only half the control either way: `refuseReset` inside the
   * service refuses anyone reaching a privilege level above their own, which is
   * what stops a sub-admin holding this grant from resetting a master admin and
   * taking the console.
   */
  @Post('users/:id/password-reset')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('admins.reset')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Email another administrator a single-use password reset link' })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped('Acts on an administrator account; reads no client rows.')
  @Audited('admin.password_reset_initiate')
  initiatePasswordReset(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.auth.initiatePasswordReset(req.admin.id, id);
  }

  /**
   * Forget another administrator's authenticator app — a lost or replaced
   * phone. Same grant and the same escalation guard as a password reset
   * (`refuseReset`): it removes half of how somebody proves who they are.
   */
  @Post('users/:id/totp/reset')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('admins.reset')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Reset another administrator's authenticator app (admins.reset)",
    description: 'Their next sign-in shows a new QR code to scan. Their password is unchanged.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped('Acts on an administrator account; reads no client rows.')
  @Audited('admin.totp_reset')
  resetTotp(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request & { admin: Admin }) {
    return this.auth.resetTotpFor(req.admin.id, id);
  }

  @NoCsrf(
    'The caller has no session by definition — that is why they are here. A CSRF ' +
      'token is bound to a session, so requiring one would make the recovery path ' +
      'reachable only by people who do not need it.',
  )
  @Post('password-reset/complete')
  /*
   * Tighter than the invite cap. An invite token is handed to one person who is
   * expecting it; a reset token is the thing somebody grinding for an admin
   * account would attack, and the legitimate user needs exactly one attempt.
   */
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Spend a reset link and set a new password' })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped('Sets an administrator password from a token; reads no client rows.')
  @Audited('admin.password_reset_complete')
  completePasswordReset(@Body() dto: CompleteAdminResetDto, @Req() req: Request) {
    // The caller's address: from outside the listed networks only an exempt
    // administrator's link may be spent (RBAC-08, 0192).
    return this.auth.completePasswordReset(dto.token, dto.password, clientIp(req));
  }

  /*
   * -- Self-service ----------------------------------------------------------
   *
   * Everything below acts on the CALLER's own account, so every one is
   * `@AnyAdmin`. Gating them on a permission would be a category error: an
   * administrator whose role is one screen wide still has a password to rotate,
   * sessions to end and a face to put on them. The routes above act on somebody
   * ELSE, which is what a permission is for.
   */

  /**
   * Change your own display name.
   *
   * The NAME only — see the service for why the address and the role are not
   * self-service and must not become so.
   */
  @AnyAdmin(
    "Edits the CALLER's own display name. Needing another administrator to fix your own " +
      'spelling is the kind of friction that ends with people sharing accounts.',
  )
  @Patch('auth/me')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Change your own display name' })
  @ApiOkResponse({ type: AdminProfileNameDto })
  @NotClientScoped("Edits the calling administrator's own row; reads no client rows.")
  @Audited('admin.profile_update')
  updateProfile(@Req() req: Request & { admin: Admin }, @Body() dto: AdminUpdateProfileDto) {
    return this.profile.updateProfile(req.admin.id, dto.name);
  }

  /**
   * Change your own password, ending every other session.
   *
   * `POST /admin/password-reset/complete` above is NOT this. That one spends an
   * e-mailed token and exists for somebody who cannot sign in; using it for a
   * signed-in administrator means mailing them a link to prove an identity they
   * have already proved.
   *
   * Throttled despite requiring a session, because the CURRENT password is
   * checked here: unthrottled, this is an oracle for guessing the password of
   * an account whose session has already been stolen, and every guess costs the
   * process one argon2 verification.
   */
  @AnyAdmin(
    "Rotates the CALLER's own credential. A permission here would leave an administrator " +
      'unable to change a password they may have just had reason to distrust.',
  )
  @Post('auth/change-password')
  @UseGuards(AdminGuard)
  @Throttle({ default: { ttl: 900_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Change your own password - ends every OTHER session' })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped("Rewrites the calling administrator's own credential; reads no client rows.")
  @Audited('admin.password_change')
  changePassword(
    @Req() req: Request & { admin: Admin },
    @Body() dto: AdminChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    /*
     * `res` because a successful change revokes EVERY session and issues the
     * caller a fresh one - the new cookies ride back on this response. Sparing
     * their old session instead would mean the access-token cutoff had an
     * exception, and an exception is a hole. See AdminProfileService.
     */
    return this.profile.changePassword(req.admin.id, dto.currentPassword, dto.newPassword, (id) =>
      this.auth.reissueSession(id, res, deviceOf(req)),
    );
  }

  /**
   * Your own live sessions - one entry per LOGIN, not per token row.
   *
   * The current one is identified from the `fam` claim the guard has already
   * verified, so nothing here decodes a token a second time.
   */
  @AnyAdmin(
    "Lists the caller's OWN sessions. Seeing where you are signed in is how you notice you " +
      'are signed in somewhere you are not.',
  )
  @Get('auth/sessions')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List your active sessions, most recently active first' })
  @ApiOkResponse({ type: AdminSessionDto, isArray: true })
  @NotClientScoped("Reads the calling administrator's own sessions.")
  sessions(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.profile.listSessions(req.admin.id, req.admin.sessionFamilyId ?? null);
  }

  /**
   * End one of your other sessions.
   *
   * `ParseUUIDPipe` rejects a malformed id with a 400 before it reaches a
   * query. Ownership is enforced inside the UPDATE rather than by a preceding
   * SELECT, so there is no check-then-act window and a family belonging to
   * another administrator matches nothing at all.
   */
  @AnyAdmin(
    "Ends one of the caller's OWN sessions. Somebody who suspects a stolen laptop must not " +
      'have to find an administrator with a permission before they can act.',
  )
  @Delete('auth/sessions/:id')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Sign out one of your other sessions' })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped("Revokes one of the calling administrator's own sessions.")
  @Audited('admin.session_revoke')
  revokeSession(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.profile.revokeSession(req.admin.id, id, req.admin.sessionFamilyId ?? null);
  }

  /**
   * Upload or replace your profile photo.
   *
   * `memoryStorage`, not `diskStorage`, and that is the difference from the KYC
   * path: nothing untrusted reaches the filesystem until the bytes have been
   * validated, so a rejected upload leaves nothing behind to clean up.
   *
   * `limits.fileSize` is what actually stops the bytes; `StoredFilesService`
   * checks the size again, because a limit enforced in one place is a limit
   * that moves when the interceptor is reconfigured. The accepted TYPES come
   * from the file's own magic bytes, never the multipart Content-Type - that
   * header is a claim by the uploader, and an HTML document declared image/png
   * is how a stored file becomes stored XSS on the console that approves
   * withdrawals.
   */
  @AnyAdmin("Sets the photo on the CALLER's own account.")
  @Post('auth/me/avatar')
  @UseGuards(AdminGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: AVATAR_BUCKET.maxBytes, files: 1 },
    }),
  )
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload or replace your profile photo (JPEG, PNG or WebP, max 2MB)' })
  @ApiOkResponse({ type: AdminAvatarResponseDto })
  @NotClientScoped("Writes the calling administrator's own photo; reads no client rows.")
  @Audited('admin.avatar_change')
  uploadAvatar(
    @Req() req: Request & { admin: Admin },
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new ValidationError('No file was uploaded.');
    return this.profile.setAvatar(req.admin.id, file.buffer, file.mimetype);
  }

  /** Remove the photo. The console falls back to initials, never a placeholder. */
  @AnyAdmin("Removes the photo from the CALLER's own account.")
  @Delete('auth/me/avatar')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Remove your profile photo' })
  @ApiOkResponse({ type: AdminAvatarResponseDto })
  @NotClientScoped("Clears the calling administrator's own photo; reads no client rows.")
  @Audited('admin.avatar_change')
  removeAvatar(@Req() req: Request & { admin: Admin }) {
    return this.profile.removeAvatar(req.admin.id);
  }
}
