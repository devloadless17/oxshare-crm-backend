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

const COOKIE_OPTS = {
  httpOnly: false, // Allow client JS access via js-cookie for Authorization header
  sameSite: 'lax' as const,
  secure: process.env['NODE_ENV'] === 'production',
  path: '/',
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly users: UsersStore,
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

    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
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

    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      user: this.sanitize(user),
    };
  }

  // ─── Logout ───────────────────────────────────────────────────────────────────
  async logout(userId: string, res: Response) {
    await this.users.update(userId, { refreshToken: undefined });
    res.clearCookie('access_token');
    res.clearCookie('refresh_token');
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

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie('access_token', accessToken, {
      ...COOKIE_OPTS,
      maxAge: 8 * 60 * 60 * 1000, // 8h
    });
    res.cookie('refresh_token', refreshToken, {
      ...COOKIE_OPTS,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30d
    });
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
