import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { UsersStore, User } from '../../store/users.store';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { Response } from 'express';

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env['NODE_ENV'] === 'production',
  path: '/',
};

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // ─── Register ────────────────────────────────────────────────────────────────
  async register(dto: RegisterDto) {
    if (UsersStore.findByEmail(dto.email)) {
      throw new ConflictException('An account with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const verificationToken = uuidv4();
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const user = UsersStore.create({
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

    // In production: send via SMTP. For now: log to console.
    const verifyUrl = `${this.config.get('PORTAL_URL', 'http://localhost:3000')}/verify-email?token=${verificationToken}`;
    console.log('\n📧 EMAIL VERIFICATION LINK (dev only):');
    console.log(`   ${verifyUrl}\n`);

    return {
      message: 'Registration successful. Please check your email to verify your account.',
      userId: user.id,
    };
  }

  // ─── Verify Email ─────────────────────────────────────────────────────────────
  async verifyEmail(token: string) {
    const user = UsersStore.findByVerificationToken(token);
    if (!user) throw new BadRequestException('Invalid or expired verification token.');
    if (user.emailVerificationExpiry && user.emailVerificationExpiry < new Date()) {
      throw new BadRequestException('Verification token has expired. Please request a new one.');
    }

    UsersStore.update(user.id, {
      emailVerified: true,
      verificationLevel: 0,
      emailVerificationToken: undefined,
      emailVerificationExpiry: undefined,
    });

    return { message: 'Email verified successfully. You can now log in.' };
  }

  // ─── Resend Verification ──────────────────────────────────────────────────────
  async resendVerification(email: string) {
    const user = UsersStore.findByEmail(email);
    // Always return same message to avoid email enumeration
    if (!user || user.emailVerified) {
      return { message: 'If that email exists and is unverified, a new link has been sent.' };
    }

    const token = uuidv4();
    UsersStore.update(user.id, {
      emailVerificationToken: token,
      emailVerificationExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const verifyUrl = `${this.config.get('PORTAL_URL', 'http://localhost:3000')}/verify-email?token=${token}`;
    console.log('\n📧 RESEND VERIFICATION LINK (dev only):');
    console.log(`   ${verifyUrl}\n`);

    return { message: 'If that email exists and is unverified, a new link has been sent.' };
  }

  // ─── Login ────────────────────────────────────────────────────────────────────
  async login(dto: LoginDto, res: Response) {
    const user = UsersStore.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException('Invalid email or password.');

    const passwordMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatch) throw new UnauthorizedException('Invalid email or password.');

    const tokens = this.generateTokens(user);
    const refreshHash = await bcrypt.hash(tokens.refreshToken, 10);
    UsersStore.update(user.id, { refreshToken: refreshHash });

    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    return {
      user: this.sanitize(user),
      emailVerified: user.emailVerified,
    };
  }

  // ─── Refresh ──────────────────────────────────────────────────────────────────
  async refresh(userId: string, refreshToken: string, res: Response) {
    const user = UsersStore.findById(userId);
    if (!user?.refreshToken) throw new UnauthorizedException();

    const valid = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!valid) throw new UnauthorizedException();

    const tokens = this.generateTokens(user);
    const refreshHash = await bcrypt.hash(tokens.refreshToken, 10);
    UsersStore.update(user.id, { refreshToken: refreshHash });

    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    return { message: 'Tokens refreshed.' };
  }

  // ─── Logout ───────────────────────────────────────────────────────────────────
  logout(userId: string, res: Response) {
    UsersStore.update(userId, { refreshToken: undefined });
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
      expiresIn: '15m',
    });

    const refreshToken = this.jwt.sign(
      { sub: user.id },
      {
        secret: this.config.get('JWT_REFRESH_SECRET', 'oxshare-refresh-secret-dev'),
        expiresIn: '7d',
      },
    );

    return { accessToken, refreshToken };
  }

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie('access_token', accessToken, {
      ...COOKIE_OPTS,
      maxAge: 15 * 60 * 1000,
    });
    res.cookie('refresh_token', refreshToken, {
      ...COOKIE_OPTS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/auth/refresh',
    });
  }

  private sanitize(user: User) {
    const { passwordHash, refreshToken, emailVerificationToken, emailVerificationExpiry, ...safe } =
      user;
    return safe;
  }

  findUserById(id: string): User | undefined {
    return UsersStore.findById(id);
  }
}
