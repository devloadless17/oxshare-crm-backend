import {
  Controller,
  Post,
  Get,
  Body,
  Query,
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
import { AuthService } from './auth.service';
import {
  AuthTokensResponseDto,
  MessageResponseDto,
  RegistrationResponseDto,
  UserProfileDto,
} from './dto/auth-response.dto';
import {
  RegisterDto,
  LoginDto,
  ResendVerificationDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { User } from '../../store/users.store';
import { NoCsrf } from '../../common/security/csrf.guard';

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

  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email via token from email link' })
  @ApiOkResponse({ type: MessageResponseDto })
  verifyEmail(@Query('token') token: string) {
    return this.auth.verifyEmail(token);
  }

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
    'Establishing a session cannot be a forgery of one: there is nothing yet to ' +
      'protect. Requiring a token here also creates a lockout — an expired or ' +
      'absent token would make it impossible to log in and obtain a fresh one.',
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

  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login — also sets the JWT cookies (deliberately readable by JS, not httpOnly)',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto, res);
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
  @ApiOkResponse({ type: AuthTokensResponseDto })
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
    return this.auth.refreshFromToken(refreshToken ?? '', res);
  }

  @NoCsrf(
    'Ending a session is not an attack worth defending against, and blocking it ' +
      'when the token is missing would leave a user unable to log out — strictly ' +
      'worse for them than the nuisance it prevents.',
  )
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Logout — clears JWT cookies' })
  @ApiOkResponse({ type: MessageResponseDto })
  logout(@Req() req: Request & { user: User }, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req.user.id, res);
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
}
