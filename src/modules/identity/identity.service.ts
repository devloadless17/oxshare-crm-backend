import {
  Injectable,
  Inject,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DRIZZLE_DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../database/schema';
import { eq, and, gt } from 'drizzle-orm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { EmailService } from '../email/email.service';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase<typeof schema>,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
  ) {}

  async register(dto: { email: string; password: string; firstName?: string; lastName?: string }) {
    const existing = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email.toLowerCase()),
    });

    if (existing) {
      throw new BadRequestException('User with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const [newUser] = await this.db
      .insert(schema.users)
      .values({
        email: dto.email.toLowerCase(),
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: 'CLIENT',
        status: 'PENDING_VERIFICATION',
        isEmailVerified: false,
      })
      .returning();

    // Create verification token (24h)
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await this.db.insert(schema.verificationTokens).values({
      userId: newUser.id,
      token,
      type: 'EMAIL_VERIFY',
      expiresAt,
    });

    await this.emailService.sendVerificationEmail(newUser.email, token);

    return {
      message: 'Registration successful. Please check your email to verify your account.',
      userId: newUser.id,
    };
  }

  async verifyEmail(token: string) {
    const record = await this.db.query.verificationTokens.findFirst({
      where: and(
        eq(schema.verificationTokens.token, token),
        eq(schema.verificationTokens.type, 'EMAIL_VERIFY'),
        gt(schema.verificationTokens.expiresAt, new Date()),
      ),
    });

    if (!record) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    await this.db
      .update(schema.users)
      .set({ isEmailVerified: true, status: 'ACTIVE' })
      .where(eq(schema.users.id, record.userId));

    await this.db
      .delete(schema.verificationTokens)
      .where(eq(schema.verificationTokens.id, record.id));

    return { message: 'Email successfully verified. You may now log in.' };
  }

  async login(dto: { email: string; password: string; role?: 'CLIENT' | 'ADMIN' }) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email.toLowerCase()),
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (dto.role && user.role !== dto.role && user.role !== 'SUPER_ADMIN') {
      throw new UnauthorizedException('Access denied for this portal');
    }

    // Generate 15-minute Access Token and 30-day Refresh Token
    const payload = { sub: user.id, email: user.email, role: user.role };
    
    const accessToken = this.jwtService.sign(payload, { expiresIn: '15m' });
    const refreshToken = this.jwtService.sign({ sub: user.id, tokenType: 'refresh' }, { expiresIn: '30d' });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 900, // 15 minutes in seconds
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
      },
    };
  }

  async refreshToken(refreshToken: string) {
    try {
      const decoded = this.jwtService.verify(refreshToken);
      if (decoded.tokenType !== 'refresh') {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const user = await this.db.query.users.findFirst({
        where: eq(schema.users.id, decoded.sub),
      });

      if (!user || user.status === 'SUSPENDED') {
        throw new UnauthorizedException('User account inactive or not found');
      }

      const payload = { sub: user.id, email: user.email, role: user.role };
      const newAccessToken = this.jwtService.sign(payload, { expiresIn: '15m' });

      return {
        access_token: newAccessToken,
        expires_in: 900,
      };
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  async forgotPassword(email: string) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, email.toLowerCase()),
    });

    if (!user) {
      return { message: 'If the email exists, a password reset link has been sent.' };
    }

    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.db.insert(schema.verificationTokens).values({
      userId: user.id,
      token,
      type: 'PASSWORD_RESET',
      expiresAt,
    });

    await this.emailService.sendPasswordResetEmail(user.email, token);

    return { message: 'If the email exists, a password reset link has been sent.' };
  }

  async resetPassword(dto: { token: string; newPassword: string }) {
    const record = await this.db.query.verificationTokens.findFirst({
      where: and(
        eq(schema.verificationTokens.token, dto.token),
        eq(schema.verificationTokens.type, 'PASSWORD_RESET'),
        gt(schema.verificationTokens.expiresAt, new Date()),
      ),
    });

    if (!record) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);

    await this.db
      .update(schema.users)
      .set({ passwordHash })
      .where(eq(schema.users.id, record.userId));

    await this.db
      .delete(schema.verificationTokens)
      .where(eq(schema.verificationTokens.id, record.id));

    return { message: 'Password successfully reset. You may now log in.' };
  }
}
