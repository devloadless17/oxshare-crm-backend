import { Logger, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
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
import { CsrfService } from '../../common/security/csrf.service';
import {
  clearLegacySessionCookies,
  clearSessionCookie,
  csrfCookieOptions,
  sessionCookieNames,
  sessionCookieOptions,
} from '../../common/security/session-cookies';

const ACCESS_TTL_MS = 8 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly users: UsersStore,
    private readonly csrf: CsrfService,
  ) {}

  // ─── Register ────────────────────────────────────────────────────────────────
  async register(dto: RegisterDto) {
    if (await this.users.findByEmail(dto.email)) {
      throw new ConflictError('An account with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
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

  // ─── Login ────────────────────────────────────────────────────────────────────
  async login(dto: LoginDto, res: Response) {
    const user = await this.users.findByEmail(dto.email);
    if (!user) throw new AuthenticationError('Invalid email or password.');

    const passwordMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatch) throw new AuthenticationError('Invalid email or password.');

    // Checked only after the password matches, so a suspended-account message
    // never leaks whether credentials were valid.
    if (user.status === 'suspended') {
      throw new AuthorizationError('Your account has been suspended. Please contact support.');
    }

    const tokens = this.generateTokens(user);
    const refreshHash = await bcrypt.hash(tokens.refreshToken, 10);
    await this.users.update(user.id, { refreshToken: refreshHash });

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
    try {
      const decoded = this.jwt.verify(providedRefreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', 'oxshare-refresh-secret-dev'),
      });
      userId = decoded.sub;
    } catch {
      throw new AuthenticationError('Invalid or expired refresh token.');
    }

    // No fallback: an unknown subject is a failed authentication. The previous
    // fallback to the seeded demo client turned any signed token into that
    // account's session.
    const user = await this.users.findById(userId);
    if (!user) throw new AuthenticationError('User account not found.');

    // Same revocation check as the admin path — the stored hash was never
    // compared, so logout did not actually end the session.
    if (!user.refreshToken) {
      throw new AuthenticationError('Session has been revoked. Please log in again.');
    }
    const tokenMatches = await bcrypt.compare(providedRefreshToken, user.refreshToken);
    if (!tokenMatches) {
      throw new AuthenticationError('Refresh token is no longer valid. Please log in again.');
    }

    if (user.status === 'suspended') {
      throw new AuthenticationError('Your account has been suspended.');
    }

    const tokens = this.generateTokens(user);
    const refreshHash = await bcrypt.hash(tokens.refreshToken, 10);
    await this.users.update(user.id, { refreshToken: refreshHash });

    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken, user.id);

    return {
      user: this.sanitize(user),
    };
  }

  // ─── Logout ───────────────────────────────────────────────────────────────────
  async logout(userId: string, res: Response) {
    await this.users.update(userId, { refreshToken: undefined });
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

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET', 'oxshare-access-secret-dev'),
      expiresIn: '8h',
    });

    const refreshToken = this.jwt.sign(
      { sub: user.id },
      {
        secret: this.config.get('JWT_REFRESH_SECRET', 'oxshare-refresh-secret-dev'),
        expiresIn: '30d',
      },
    );

    return { accessToken, refreshToken };
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
