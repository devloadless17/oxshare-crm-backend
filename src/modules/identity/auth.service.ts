import { Logger, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { UsersStore, User } from '../../store/users.store';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { EmailService } from '../email/email.service';
import { Response } from 'express';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { createHash, randomUUID } from 'crypto';
import { CsrfService } from '../../common/security/csrf.service';
import { RefreshTokensService } from '../../common/security/refresh-tokens.service';
import { PasswordService } from '../../common/security/password.service';
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from '../../common/security/token-audience';
import {
  clearLegacySessionCookies,
  clearSessionCookie,
  csrfCookieOptions,
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
 * SHA-256 of a reset token, hex.
 *
 * A fast hash on purpose. The token is 122 bits of randomness from
 * `randomUUID`, so there is no guessable secret for a slow KDF to protect —
 * argon2 here would buy nothing and add latency to an unauthenticated lookup an
 * attacker can trigger at will. What this defends against is a database dump
 * being replayable as reset links, and a digest is sufficient for that.
 */
function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly users: UsersStore,
    private readonly csrf: CsrfService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly passwords: PasswordService,
  ) {}

  // ─── Register ────────────────────────────────────────────────────────────────
  async register(dto: RegisterDto) {
    if (await this.users.findByEmail(dto.email)) {
      throw new ConflictError('An account with this email already exists.');
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const verificationToken = uuidv4();
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const user = await this.users.create({
      email: dto.email.toLowerCase(),
      passwordHash,
      firstName: dto.firstName,
      lastName: dto.lastName,
      type: 'individual',
      status: 'active',
      verificationLevel: 0,
      emailVerified: false,
      emailVerificationToken: verificationToken,
      emailVerificationExpiry: verificationExpiry,
      country: dto.country,
      phone: dto.phone,
    });

    // The verification link is a bearer credential. It is emailed and never
    // written to stdout — it used to be console.logged in every environment.
    await this.email.sendVerificationEmail(user.email, verificationToken);
    this.logger.log(`Verification email dispatched to ${user.email}`);

    return {
      message: 'Registration successful. Please check your email to verify your account.',
      userId: user.id,
    };
  }

  // ─── Verify Email ─────────────────────────────────────────────────────────────
  async verifyEmail(token: string) {
    const user = await this.users.findByVerificationToken(token);
    if (!user) throw new ValidationError('Invalid or expired verification token.');
    if (user.emailVerificationExpiry && user.emailVerificationExpiry < new Date()) {
      throw new ValidationError('Verification token has expired. Please request a new one.');
    }

    await this.users.update(user.id, {
      emailVerified: true,
      verificationLevel: 0,
      emailVerificationToken: undefined,
      emailVerificationExpiry: undefined,
    });

    return { message: 'Email verified successfully. You can now log in.' };
  }

  // ─── Resend Verification ──────────────────────────────────────────────────────
  async resendVerification(email: string) {
    const user = await this.users.findByEmail(email);
    if (!user || user.emailVerified) {
      return { message: 'If that email exists and is unverified, a new link has been sent.' };
    }

    const token = uuidv4();
    await this.users.update(user.id, {
      emailVerificationToken: token,
      emailVerificationExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await this.email.sendVerificationEmail(user.email, token);
    this.logger.log(`Verification email re-sent to ${user.email}`);

    return { message: 'If that email exists and is unverified, a new link has been sent.' };
  }

  // ─── Password reset ─────────────────────────────────────────────────────────
  //
  // FR-CORE-09 · PLATFORM-CONVENTIONS R-3.5. The portal has had this UI live for
  // months with no endpoint behind it — both calls 404'd, so a client who forgot
  // their password had no recovery path and nothing explaining why.

  /**
   * Start a reset. ALWAYS answers the same, whether or not the account exists.
   *
   * An endpoint that says "no account with that email" is a membership oracle:
   * anyone can test an address list against it and learn who banks here. That
   * matters more for a broker than for most products, and it costs nothing to
   * avoid — the honest-looking error is the vulnerability.
   *
   * The token is random and high-entropy; only its SHA-256 goes to the database,
   * so a dump or a read-only injection cannot be turned into a working reset
   * link (see schema.ts).
   */
  async requestPasswordReset(email: string) {
    const generic = {
      message: 'If an account exists for that address, a reset link is on its way.',
    };

    const user = await this.users.findByEmail(email);
    if (!user) return generic;

    // A suspended account must not be recoverable by its holder — reinstating it
    // is an admin decision, and a working reset would route around that.
    if (user.status === 'suspended') return generic;

    const token = randomUUID();
    await this.users.update(user.id, {
      passwordResetTokenHash: hashResetToken(token),
      // 30 minutes (R-3.5). Long enough to find the email, short enough that a
      // link left in an inbox is not a standing key to the account.
      passwordResetExpiry: new Date(Date.now() + 30 * 60 * 1000),
    });

    await this.email.sendPasswordResetEmail(user.email, token);
    // The recipient, never the token — the link is a credential (R-6.3).
    this.logger.log(`Password reset requested for ${user.email}`);
    return generic;
  }

  /**
   * Complete a reset.
   *
   * Single-use and time-boxed, and — the part that is easy to leave out — it
   * REVOKES EVERY SESSION. Someone resetting a password is usually doing it
   * because they believe they are compromised; leaving the attacker's 30-day
   * refresh token alive would make the reset theatre.
   */
  async resetPassword(token: string, newPassword: string) {
    const user = await this.users.findByPasswordResetTokenHash(hashResetToken(token));

    // One message for "no such token" and "expired token". Distinguishing them
    // tells an attacker which of their guesses was once real.
    const invalid = new ValidationError(
      'This reset link is invalid or has expired. Please request a new one.',
    );
    if (!user) throw invalid;
    if (!user.passwordResetExpiry || user.passwordResetExpiry < new Date()) {
      // Clear the dead token rather than leaving it to linger and be retried.
      await this.users.update(user.id, {
        passwordResetTokenHash: undefined,
        passwordResetExpiry: undefined,
      });
      throw invalid;
    }

    await this.users.update(user.id, {
      passwordHash: await this.passwords.hash(newPassword),
      // Cleared in the same write as the new password: the token is spent the
      // moment it works, so a replay finds nothing.
      passwordResetTokenHash: undefined,
      passwordResetExpiry: undefined,
      refreshToken: undefined,
    });

    // Every refresh-token family for this user, not just the current one.
    await this.refreshTokens.revokeAllForSubject('portal', user.id);

    this.logger.log(`Password reset completed for ${user.email}; all sessions revoked`);
    return { message: 'Your password has been updated. Please sign in again.' };
  }

  // ─── Login ────────────────────────────────────────────────────────────────────
  async login(dto: LoginDto, res: Response) {
    const user = await this.users.findByEmail(dto.email);
    if (!user) throw new AuthenticationError('Invalid email or password.');

    /*
     * Dual-read: accepts a stored bcrypt hash, then quietly replaces it with
     * argon2id (R-3.4). Nobody is forced to reset a password they already have,
     * and the bcrypt population drains as people log in.
     */
    const { valid: passwordMatch, needsRehash } = await this.passwords.verify(
      dto.password,
      user.passwordHash,
    );
    if (passwordMatch && needsRehash) {
      const upgraded = await this.passwords.hash(dto.password);
      await this.users.update(user.id, { passwordHash: upgraded });
      this.logger.log(`Upgraded password hash to argon2id for user ${user.id}`);
    }
    if (!passwordMatch) throw new AuthenticationError('Invalid email or password.');

    // Checked only after the password matches, so a suspended-account message
    // never leaks whether credentials were valid.
    if (user.status === 'suspended') {
      throw new AuthorizationError('Your account has been suspended. Please contact support.');
    }

    const tokens = this.generateTokens(user);
    await this.refreshTokens.record({
      surface: 'portal',
      subjectId: user.id,
      jti: tokens.jti,
      token: tokens.refreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    });

    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken, user.id);

    /*
     * The tokens are NOT in the body, deliberately.
     *
     * They live in httpOnly cookies set on this response (R-3.2), and returning
     * them would hand JavaScript the very credential the cookie flag exists to
     * keep away from it — where it lands in browser memory, the network tab,
     * proxy logs and any error-reporting tool the page loads.
     *
     * It also had a concrete consequence: after the cookies became httpOnly, a
     * portal still running the old build kept reading these fields and writing
     * its own JS-readable `access_token` cookie from them. Clearing the browser
     * and logging in again reproduced it every time. Removing the fields makes
     * that impossible rather than merely discouraged.
     */
    return {
      user: this.sanitize(user),
      emailVerified: user.emailVerified,
    };
  }

  // ─── Refresh ──────────────────────────────────────────────────────────────────
  async refreshFromToken(providedRefreshToken: string, res: Response) {
    if (!providedRefreshToken) throw new AuthenticationError('No refresh token provided.');

    let userId: string;
    let jti: string | undefined;
    try {
      const decoded = this.jwt.verify<{ sub: string; jti?: string }>(providedRefreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET', 'oxshare-refresh-secret-dev'),
        audience: TOKEN_AUDIENCE.portal,
        issuer: TOKEN_ISSUER,
      });
      userId = decoded.sub;
      jti = decoded.jti;
    } catch {
      throw new AuthenticationError('Invalid or expired refresh token.');
    }

    // No fallback: an unknown subject is a failed authentication. The previous
    // fallback to the seeded demo client turned any signed token into that
    // account's session.
    const user = await this.users.findById(userId);
    if (!user) throw new AuthenticationError('User account not found.');

    // A token with no `jti` predates R-3.3 and has no row to judge. Refusing it
    // logs those sessions out once, which is the correct migration cost for a
    // credential that cannot be checked for replay.
    if (!jti) {
      throw new AuthenticationError('Session has been revoked. Please log in again.');
    }

    /*
     * The token's own row decides — R-3.3.
     *
     * This replaces comparing against a single stored hash, which could express
     * "matches" or "does not match" and nothing else. A replayed token simply
     * failed to match, so an attacker holding a stolen token used the newer one
     * they had also captured, and nothing recorded that anything had leaked.
     */
    const verdict = await this.refreshTokens.verify({
      surface: 'portal',
      jti,
      token: providedRefreshToken,
    });

    if (verdict.outcome === 'reused') {
      // verify() has already revoked the family. The legitimate user and the
      // attacker get the same message, because which one this is, is exactly
      // what we cannot tell.
      throw new AuthenticationError(
        'This session has been ended for security reasons. Please log in again.',
      );
    }
    if (verdict.outcome !== 'ok') {
      throw new AuthenticationError('Session has been revoked. Please log in again.');
    }

    if (user.status === 'suspended') {
      // Belt and braces: suspension also revokes every family, but a token
      // minted before that must not survive on this path either.
      await this.refreshTokens.revokeAllForSubject('portal', user.id);
      throw new AuthenticationError('Your account has been suspended.');
    }

    const tokens = this.generateTokens(user);
    const rotated = await this.refreshTokens.rotate({
      surface: 'portal',
      jti,
      familyId: verdict.familyId,
      subjectId: user.id,
      jtiNext: tokens.jti,
      nextToken: tokens.refreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    });
    // Lost a race with a concurrent refresh using the same token. Handing out a
    // second live session is exactly what the conditional update prevents.
    if (!rotated) {
      throw new AuthenticationError('Session has been revoked. Please log in again.');
    }

    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken, user.id);

    return {
      user: this.sanitize(user),
    };
  }

  // ─── Logout ───────────────────────────────────────────────────────────────────
  async logout(userId: string, res: Response) {
    // Revokes EVERY family for this user, not just the one presenting a token:
    // logging out on one device must not leave the others live (R-3.3).
    await this.refreshTokens.revokeAllForSubject('portal', userId);
    clearSessionCookie(res, sessionCookieNames.clientAccess());
    clearSessionCookie(res, sessionCookieNames.clientRefresh());
    clearSessionCookie(res, sessionCookieNames.portalCsrf());
    clearLegacySessionCookies(res);
    return { message: 'Logged out successfully.' };
  }

  // ─── Me ───────────────────────────────────────────────────────────────────────
  me(user: User) {
    return this.sanitize(user);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  private generateTokens(user: User) {
    const payload = {
      sub: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      type: user.type,
    };

    // aud/iss so a portal token cannot verify on the admin surface even if the
    // two ever end up sharing a secret (R-3.1).
    const claims = { audience: TOKEN_AUDIENCE.portal, issuer: TOKEN_ISSUER };
    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET', 'oxshare-access-secret-dev'),
      expiresIn: '15m',
      ...claims,
    });

    // The refresh token carries a `jti` naming its row in refresh_tokens, which
    // is how a presented token finds out whether it has already been rotated
    // (R-3.3).
    const jti = randomUUID();
    const refreshToken = this.jwt.sign(
      { sub: user.id, jti },
      {
        secret: this.config.get<string>('JWT_REFRESH_SECRET', 'oxshare-refresh-secret-dev'),
        expiresIn: '30d',
        ...claims,
      },
    );

    return { accessToken, refreshToken, jti };
  }

  /**
   * Sets the session pair plus the anti-forgery token.
   *
   * Names and attributes come from common/security/session-cookies.ts, which
   * explains why `__Host-` and app-unique names matter when many OxShare sites
   * share one registrable domain (PLATFORM-CONVENTIONS §3.0). These cookies were
   * previously httpOnly:false so the portal could read them for a Bearer header;
   * that header was never what authenticated the request, and it put a 30-day
   * refresh token within reach of any script on the origin.
   */
  private setAuthCookies(res: Response, accessToken: string, refreshToken: string, userId: string) {
    // Delete every superseded name first. Those cookies were httpOnly:false and
    // hold real JWTs, so a browser from the old build carries a JS-readable
    // session for up to 30 more days unless we actively remove it here.
    clearLegacySessionCookies(res);
    res.cookie(sessionCookieNames.clientAccess(), accessToken, sessionCookieOptions(ACCESS_TTL_MS));
    res.cookie(
      sessionCookieNames.clientRefresh(),
      refreshToken,
      sessionCookieOptions(REFRESH_TTL_MS),
    );
    res.cookie(
      sessionCookieNames.portalCsrf(),
      this.csrf.issue(userId),
      csrfCookieOptions(CsrfService.TTL_MS),
    );
  }

  private sanitize(user: User) {
    const { passwordHash, refreshToken, emailVerificationToken, emailVerificationExpiry, ...safe } =
      user;
    return safe;
  }

  async findUserById(id: string): Promise<User | undefined> {
    return await this.users.findById(id);
  }
}
