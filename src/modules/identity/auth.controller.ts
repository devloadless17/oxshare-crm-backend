import {
  Controller,
  Post,
  Get,
  Delete,
  UploadedFile,
  UseInterceptors,
  Param,
  ParseUUIDPipe,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
  ApiOkResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { COOKIE_BASES, readSessionCookie } from '../../common/security/session-cookies';
import { deviceOf } from '../../common/security/device-fingerprint';
import { TOKEN_KIND } from '../../common/security/token-audience';
import { AuthService } from './auth.service';
import {
  AuthTokensResponseDto,
  RefreshResponseDto,
  MessageResponseDto,
  RegistrationResponseDto,
  SessionDto,
  VerifyEmailResponseDto,
  UserProfileDto,
} from './dto/auth-response.dto';
import {
  RegisterDto,
  LoginDto,
  ResendVerificationDto,
  VerifyEmailDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
} from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { User } from '../../store/users.store';
import { NoCsrf } from '../../common/security/csrf.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiConsumes } from '@nestjs/swagger';
import { ValidationError } from '../../common/errors/domain-errors';
import { AVATAR_BUCKET } from '../../common/uploads/stored-files.service';
import { AvatarResponseDto } from './dto/auth-response.dto';

@ApiTags('auth')
@Controller(['auth', 'identity'])
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @NoCsrf(
    'Establishing a session cannot be a forgery of one: there is nothing yet to ' +
      'protect. Requiring a token here also creates a lockout — an expired or ' +
      'absent token would make it impossible to log in and obtain a fresh one.',
  )
  @Post('register')
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @ApiOperation({ summary: 'Register a new portal user' })
  // Returns { message, userId }, not tokens: the account is unverified until the
  // emailed link is followed, so there is no session to hand back.
  @ApiCreatedResponse({ type: RegistrationResponseDto })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  /*
   * POST, not GET — R-3.9, "no state change behind GET".
   *
   * This marked the address verified, cleared the token and moved the
   * verification level, all from a GET. The threat is not a browser: it is
   * everything that follows a link WITHOUT a person deciding to. Corporate mail
   * gateways and link scanners fetch every URL in an inbound message to check
   * it, and a preview pane prefetches. Any of those verified the address
   * silently, which is the one thing the email is supposed to prove.
   *
   * The emailed link still points at the PORTAL page — email.service.ts sends
   * `${portalUrl}/auth/verify-email?token=…` — so nothing about the user's
   * journey changes. That page now POSTs the token instead of the API doing the
   * work on the GET, which keeps the click count at one while making the state
   * change something a person triggered.
   *
   * Throttled: the token is single-use and unguessable, but nothing else here
   * bounds how fast someone can try to guess one.
   */
  @NoCsrf(
    'The emailed token is the whole credential, not the session: a forger would ' +
      'need the token, and with it could call this directly with no cookies at all. ' +
      'Requiring the session-bound token instead refused a real client — one whose ' +
      'browser was still signed in to ANOTHER account, opening the link cold in ' +
      'production, where the token lives only in JS memory and nothing had put it ' +
      'there yet. Origin validation still runs, and this sets no cookies.',
  )
  @Post('verify-email')
  @Throttle({ default: { ttl: 900_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email with the token from the emailed link' })
  @ApiOkResponse({ type: VerifyEmailResponseDto })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.token);
  }

  @NoCsrf(
    'Public and throttled, and the address is supplied in the body, not taken ' +
      'from a session. Demanding the session-bound token refused a signed-in ' +
      'browser for no protection. Origin validation still runs.',
  )
  @Post('resend-verification')
  // §8.4's pattern: a mail-bomb vector without a per-user limit.
  @Throttle({ default: { ttl: 900_000, limit: 3 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend email verification link' })
  @ApiOkResponse({ type: MessageResponseDto })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.auth.resendVerification(dto.email);
  }

  @NoCsrf(
    'Asked by someone who cannot sign in, so there is no session this could be a ' +
      'forgery of. It answers identically whether or not the account exists, and ' +
      'is throttled. Origin validation still runs.',
  )
  /*
   * Password reset — FR-CORE-09 · R-3.5.
   *
   * Both routes are unauthenticated by necessity: the caller is someone who
   * cannot sign in. That makes the rate limits part of the design rather than
   * decoration.
   */
  @Post('forgot-password')
  // 3 per hour per IP (R-3.5). This sends mail to an address the caller names,
  // so without a limit it is both a user-enumeration probe and a mail bomb
  // aimed at somebody else's inbox.
  @Throttle({ default: { ttl: 3_600_000, limit: 3 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password reset link — always answers the same, existing account or not',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.requestPasswordReset(dto.email);
  }

  @NoCsrf(
    'The emailed reset token is the whole credential, exactly as on verify-email ' +
      'and the admin password-reset/complete route. A browser holding another ' +
      'account session was refused, on a link opened cold. Origin validation still runs.',
  )
  @Post('reset-password')
  // 5 per 15 minutes. The token is 122 bits of randomness so guessing it is not
  // the threat; what this bounds is an attacker grinding the unauthenticated
  // lookup, which touches the database on every attempt.
  @Throttle({ default: { ttl: 900_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password from a reset token — single use, and revokes every session',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.newPassword);
  }

  @NoCsrf(
    'Establishing a session cannot be a forgery of one. Admin login has always ' +
      'carried this exemption and the portal lost it: a client whose browser still ' +
      'held another account session was refused a 403 on sign-in, a lockout with no ' +
      'way out but clearing cookies. Origin validation still runs, which is what ' +
      'defends against login CSRF.',
  )
  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  // The summary said "deliberately readable by JS, not httpOnly" — the exact
  // opposite of what this does now, published straight into /api/docs-json,
  // which is what both frontends generate their types and their understanding
  // from (R-3.2).
  @ApiOperation({
    summary: 'Login — sets the session as httpOnly cookies. No tokens in the response body.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto, res, deviceOf(req));
  }

  @NoCsrf(
    'Rotating a session the caller already holds grants no new authority, and a ' +
      'refresh must keep working when the CSRF token has expired alongside the ' +
      'access token — otherwise a returning user is locked out rather than renewed.',
  )
  @Post('refresh')
  /*
   * Rate-limited despite @NoCsrf and despite needing a cookie — R-3.5.
   *
   * This is the most expensive unauthenticated-looking route in the API: it
   * hashes to find the token's family row on every call, and it is deliberately
   * exempt from the CSRF check, so nothing else stands in front of it. At the
   * global 120/min it was the cheapest way to make the process do real work.
   *
   * 20/min is far above what any real client reaches — the portal refreshes
   * proactively every ten minutes, and a handful of open tabs stays well inside
   * it — while putting a ceiling on both CPU burn and blind rotation attempts
   * against a stolen token.
   */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiOkResponse({ type: RefreshResponseDto })
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Cookie ONLY. The body and Authorization fallbacks are gone: two credential
    // channels for one session means two threat models (PLATFORM-CONVENTIONS
    // R-3.1). They also became unusable the moment the cookies turned httpOnly —
    // the portal cannot read the token to put it in a body, and does not need to,
    // because the browser attaches the cookie itself.
    const refreshToken = readSessionCookie(
      req.cookies as Record<string, string | undefined> | undefined,
      COOKIE_BASES.clientRefresh,
    );
    return this.auth.refreshFromToken(
      refreshToken ?? '',
      res,
      deviceOf(req),
      // Carried forward so the token the caller already holds stays valid - see
      // setAuthCookies. Rotating here raced the in-flight echoes and stranded
      // the client on a token its cookie no longer matched.
      readSessionCookie(
        req.cookies as Record<string, string | undefined> | undefined,
        COOKIE_BASES.portalCsrf,
      ),
    );
  }

  @NoCsrf(
    'Ending a session is not an attack worth defending against, and blocking it ' +
      'when the token is missing would leave a user unable to log out — strictly ' +
      'worse for them than the nuisance it prevents.',
  )
  @Post('logout')
  /*
   * NO JwtAuthGuard, deliberately — see `AuthService.logoutFromRequest`.
   *
   * Behind the guard, an expired access token meant 401 and no cookies cleared,
   * so a client returning to a backgrounded phone could not sign out at all.
   * Identity comes from the fully-verified refresh cookie instead, and the
   * cookies are cleared either way. Origin validation still applies.
   */
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Logout — clears JWT cookies' })
  @ApiOkResponse({ type: MessageResponseDto })
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.logoutFromRequest(req, res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current authenticated user' })
  // The portal's UserContext hand-wrote this shape because it had nothing to
  // alias, and its copy drifted: it declared `role` and `isEmailVerified`,
  // neither of which sanitize() returns.
  @ApiOkResponse({ type: UserProfileDto })
  me(@Req() req: Request & { user: User }) {
    return this.auth.me(req.user);
  }

  /**
   * Change a password from inside a live session - the other half of R-3.5.
   *
   * `POST /auth/reset-password` above is NOT this. It consumes an e-mailed
   * single-use token and exists for people who cannot sign in; using it for a
   * signed-in client means mailing them a link to prove an identity they have
   * already proved, and it ends every session including the one they are in.
   *
   * Throttled despite requiring a session, because the current password is
   * checked here: without a limit this is an oracle for guessing the password
   * of an account whose session has already been stolen, and every guess costs
   * the process one argon2 verification.
   */
  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 900_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Change your password - requires the current one, and ends every OTHER session',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  changePassword(
    @Req() req: Request & { user: User },
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // `res` because a successful change revokes EVERY session and issues the
    // caller a fresh one - the new cookies ride back on this response. Sparing
    // their old session instead would mean the access-token cutoff had an
    // exception, and an exception is a hole. See AuthService.changePassword.
    return this.auth.changePassword(
      req.user.id,
      dto.currentPassword,
      dto.newPassword,
      res,
      deviceOf(req),
    );
  }

  /**
   * The client's own live sessions - FR-CORE-09, the "where am I signed in" half.
   *
   * One entry per LOGIN rather than per token row: a month-old session is
   * thousands of rotations and one thing the client actually did.
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List your active sessions, most recently active first' })
  @ApiOkResponse({ type: SessionDto, isArray: true })
  async sessions(@Req() req: Request & { user: User }) {
    return this.auth.listSessions(req.user.id, await this.currentFamilyId(req));
  }

  /**
   * End one session by family id.
   *
   * `ParseUUIDPipe` rejects a malformed id with a 400 before it reaches a query.
   * Ownership is enforced inside the UPDATE, not by a preceding SELECT, so
   * there is no check-then-act window and a family belonging to somebody else
   * matches nothing at all.
   */
  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Sign out one of your other sessions' })
  @ApiOkResponse({ type: MessageResponseDto })
  async revokeSession(
    @Req() req: Request & { user: User },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.auth.revokeSession(req.user.id, id, await this.currentFamilyId(req));
  }

  /**
   * Upload the client's profile photo.
   *
   * `memoryStorage`, not `diskStorage`, and that is the difference from the KYC
   * path. Nothing untrusted reaches the filesystem until the bytes have been
   * validated, so a rejected upload leaves nothing behind to clean up — KYC
   * writes first and checks after, which needs a delete on every failure branch
   * and leaks a file the first time somebody forgets one.
   *
   * `limits.fileSize` is what actually stops the bytes; the service checks the
   * size again because a limit enforced in one place is a limit that moves when
   * the interceptor is reconfigured.
   *
   * The accepted TYPES are decided from the file's own magic bytes inside
   * `StoredFilesService`, never from the multipart `Content-Type` — that header
   * is a claim by the uploader, and an HTML document declared `image/png` is
   * how a stored file becomes stored XSS.
   */
  @Post('me/avatar')
  @UseGuards(JwtAuthGuard)
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
  @ApiOkResponse({ type: AvatarResponseDto })
  async uploadAvatar(
    @Req() req: Request & { user: User },
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new ValidationError('No file was uploaded.');
    return this.auth.setAvatar(req.user.id, file.buffer, file.mimetype);
  }

  /** Remove the photo. The portal falls back to initials, never a placeholder. */
  @Delete('me/avatar')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Remove your profile photo' })
  @ApiOkResponse({ type: AvatarResponseDto })
  async removeAvatar(@Req() req: Request & { user: User }) {
    return this.auth.removeAvatar(req.user.id);
  }

  /**
   * Which refresh-token family this request belongs to, or null.
   *
   * Read from the REFRESH cookie because the access token carries no family -
   * it is signed from the user, not from the login. The jti is taken by
   * DECODING rather than verifying, and that is safe here for a narrow reason:
   * the caller is already authenticated by `JwtAuthGuard` against the access
   * token, and this value only decides which row of a list already belonging to
   * them is labelled "this device", plus which session a password change
   * spares. A forged value mislabels a row and, at worst, spares a session the
   * caller could have ended anyway. It grants nothing.
   */
  private async currentFamilyId(req: Request): Promise<string | null> {
    const token = readSessionCookie(
      req.cookies as Record<string, string | undefined> | undefined,
      COOKIE_BASES.clientRefresh,
    );
    if (!token) return null;
    const jti = decodeJti(token);
    return jti ? this.auth.familyIdForJti(jti) : null;
  }
}

/**
 * The `jti` inside a JWT, WITHOUT verifying it.
 *
 * Hand-decoded rather than run through JwtService because verification needs
 * the refresh secret, and this value is not being trusted for anything - see
 * `currentFamilyId`. Any malformed input answers null.
 */
function decodeJti(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return null;
    const { jti, typ } = decoded as { jti?: unknown; typ?: unknown };
    // A refresh token is the only kind that belongs to a family. Anything else
    // presented here is not the cookie we asked for.
    if (typ !== TOKEN_KIND.refresh) return null;
    return typeof jti === 'string' ? jti : null;
  } catch {
    return null;
  }
}
