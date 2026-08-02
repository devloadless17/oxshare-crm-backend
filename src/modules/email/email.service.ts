import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST', 'smtp.example.com');
    const port = this.configService.get<number>('SMTP_PORT', 587);
    const user = this.configService.get<string>('SMTP_USER', '');
    const pass = this.configService.get<string>('SMTP_PASS', '');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
    });
  }

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const portalUrl = this.configService.get<string>('PORTAL_URL', 'http://localhost:3000');
    const verificationUrl = `${portalUrl}/verify-email?token=${token}`;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h2 style="color: #3b82f6;">Welcome to OxShare Portal</h2>
        <p>Please verify your email address to complete your registration.</p>
        <div style="margin: 30px 0;">
          <a href="${verificationUrl}" style="background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
            Verify Email Address
          </a>
        </div>
        <p style="font-size: 12px; color: #94a3b8;">If you did not request this email, please ignore it.</p>
      </div>
    `;

    try {
      if (this.configService.get('NODE_ENV') !== 'test') {
        await this.transporter.sendMail({
          from: this.configService.get('SMTP_FROM', '"OxShare System" <no-reply@oxshare.com>'),
          to: email,
          subject: 'Verify Your Email — OxShare Portal',
          html,
        });
      }
      this.logger.log(`Verification email sent to ${email}`);
    } catch (error) {
      this.logger.warn(`Failed to send verification email (Logged verification URL: ${verificationUrl})`);
    }
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const portalUrl = this.configService.get<string>('PORTAL_URL', 'http://localhost:3000');
    const resetUrl = `${portalUrl}/reset-password?token=${token}`;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h2 style="color: #3b82f6;">Password Reset Request</h2>
        <p>You requested to reset your password. Click the link below to set a new password.</p>
        <div style="margin: 30px 0;">
          <a href="${resetUrl}" style="background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
            Reset Password
          </a>
        </div>
        <p style="font-size: 12px; color: #94a3b8;">This token will expire in 1 hour.</p>
      </div>
    `;

    try {
      if (this.configService.get('NODE_ENV') !== 'test') {
        await this.transporter.sendMail({
          from: this.configService.get('SMTP_FROM', '"OxShare Security" <no-reply@oxshare.com>'),
          to: email,
          subject: 'Reset Password Request — OxShare',
          html,
        });
      }
      this.logger.log(`Password reset email sent to ${email}`);
    } catch (error) {
      this.logger.warn(`Failed to send reset email (Logged reset URL: ${resetUrl})`);
    }
  }
}
