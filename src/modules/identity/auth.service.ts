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
  httpOnly: false, // Allow client JS access via js-cookie for Authorization header
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
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      user: this.sanitize(user),
      emailVerified: user.emailVerified,
    };
  }

  // ─── Refresh ──────────────────────────────────────────────────────────────────
  async refreshFromToken(providedRefreshToken: string, res: Response) {
    if (!providedRefreshToken) throw new UnauthorizedException('No refresh token provided.');

    let userId: string;
    try {
      const decoded = this.jwt.verify(providedRefreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', 'oxshare-refresh-secret-dev'),
      });
      userId = decoded.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    let user = UsersStore.findById(userId);
    if (!user) {
      // Fallback search by default demo email if in-memory user was re-seeded
      user = UsersStore.findByEmail('client@oxshare.com');
    }
    if (!user) throw new UnauthorizedException('User account not found.');

    const tokens = this.generateTokens(user);
    const refreshHash = await bcrypt.hash(tokens.refreshToken, 10);
    UsersStore.update(user.id, { refreshToken: refreshHash });

    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      user: this.sanitize(user),
    };
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

  findUserById(id: string): User | undefined {
    return UsersStore.findById(id);
  }
}
