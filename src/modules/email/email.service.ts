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
    const verificationUrl = `${portalUrl}/auth/verify-email?token=${token}`;

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
      this.logger.log(`🔗 VERIFICATION LINK: ${verificationUrl}`);
    } catch (error) {
      this.logger.warn(`Failed to send verification email (Logged verification URL: ${verificationUrl})`);
    }
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const portalUrl = this.configService.get<string>('PORTAL_URL', 'http://localhost:3000');
    const resetUrl = `${portalUrl}/auth/reset-password?token=${token}`;

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
      this.logger.log(`🔗 PASSWORD RESET LINK: ${resetUrl}`);
    } catch (error) {
      this.logger.warn(`Failed to send reset email (Logged reset URL: ${resetUrl})`);
    }
  }

  // FR-ADM-03 / ARCH §8.5: approve and reject both notify the client inline.
  async sendKycDecisionEmail(
    email: string,
    firstName: string,
    decision: 'approved' | 'rejected',
    reason?: string,
    rejectedFields?: string[],
  ): Promise<void> {
    const portalUrl = this.configService.get<string>('PORTAL_URL', 'http://localhost:3000');
    const approved = decision === 'approved';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h2 style="color: ${approved ? '#22c55e' : '#f87171'};">
          ${approved ? 'Your identity is verified' : 'Your KYC application needs correction'}
        </h2>
        <p>Hello ${firstName || 'Valued Client'},</p>
        ${approved
          ? `<p>Your KYC application has been approved. Your account has been upgraded to verification level 1 and all gated features are now unlocked.</p>`
          : `<p>Your KYC application has been reviewed and requires corrections before it can be approved.</p>
             <p style="background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); border-radius: 8px; padding: 12px;"><strong>Reason:</strong> ${reason ?? ''}</p>
             ${rejectedFields && rejectedFields.length > 0
               ? `<p><strong>Fields to correct:</strong> ${rejectedFields.join(', ')}</p>`
               : ''}
             <p>Please log in, update the highlighted information, and resubmit.</p>`}
        <div style="margin: 30px 0;">
          <a href="${portalUrl}" style="background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
            Go to Portal
          </a>
        </div>
      </div>
    `;

    try {
      if (this.configService.get('NODE_ENV') !== 'test') {
        await this.transporter.sendMail({
          from: this.configService.get('SMTP_FROM', '"OxShare Compliance" <no-reply@oxshare.com>'),
          to: email,
          subject: approved
            ? 'Identity Verified — OxShare'
            : 'Action Required: Your KYC Application Needs Correction — OxShare',
          html,
        });
      }
      this.logger.log(`KYC ${decision} email sent to ${email}`);
    } catch (error) {
      this.logger.warn(`Failed to send KYC ${decision} email to ${email}`);
    }
  }

  // FR-ADM-03: withdrawal decisions are emailed to the client, rejections
  // carrying the reason so they can correct and retry.
  async sendWithdrawalDecisionEmail(
    email: string,
    firstName: string,
    decision: 'rejected' | 'paid',
    amount: string,
    currency: string,
    reason?: string,
  ): Promise<void> {
    const portalUrl = this.configService.get<string>('PORTAL_URL', 'http://localhost:3000');
    const paid = decision === 'paid';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h2 style="color: ${paid ? '#22c55e' : '#f87171'};">
          ${paid ? 'Your withdrawal has been sent' : 'Your withdrawal was declined'}
        </h2>
        <p>Hello ${firstName || 'Valued Client'},</p>
        <p>Withdrawal of <strong>${amount} ${currency}</strong> ${paid ? 'has been processed and sent to your nominated destination.' : 'could not be processed.'}</p>
        ${!paid && reason ? `<p style="background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); border-radius: 8px; padding: 12px;"><strong>Reason:</strong> ${reason}</p><p>The reserved funds have been returned to your available balance and you may submit a new request.</p>` : ''}
        <div style="margin: 30px 0;">
          <a href="${portalUrl}" style="background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">Go to Portal</a>
        </div>
      </div>
    `;
    try {
      if (this.configService.get('NODE_ENV') !== 'test') {
        await this.transporter.sendMail({
          from: this.configService.get('SMTP_FROM', '"OxShare Payments" <no-reply@oxshare.com>'),
          to: email,
          subject: paid ? 'Withdrawal Sent — OxShare' : 'Withdrawal Declined — OxShare',
          html,
        });
      }
      this.logger.log(`Withdrawal ${decision} email sent to ${email}`);
    } catch {
      this.logger.warn(`Failed to send withdrawal ${decision} email to ${email}`);
    }
  }

  async sendAdminInviteEmail(email: string, name: string, inviteUrl: string): Promise<void> {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h2 style="color: #3b82f6;">You're invited to OxShare Admin</h2>
        <p>Hello ${name},</p>
        <p>You've been invited to join the OxShare back-office. Set your password to activate your account. The link expires in 48 hours.</p>
        <div style="margin: 30px 0;">
          <a href="${inviteUrl}" style="background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
            Activate Account
          </a>
        </div>
        <p style="font-size: 12px; color: #94a3b8;">If you weren't expecting this invitation, please ignore this email.</p>
      </div>
    `;

    try {
      if (this.configService.get('NODE_ENV') !== 'test') {
        await this.transporter.sendMail({
          from: this.configService.get('SMTP_FROM', '"OxShare System" <no-reply@oxshare.com>'),
          to: email,
          subject: 'Admin Invitation — OxShare',
          html,
        });
      }
      this.logger.log(`Admin invite email sent to ${email}`);
      this.logger.log(`🔗 INVITE LINK: ${inviteUrl}`);
    } catch (error) {
      this.logger.warn(`Failed to send invite email (Logged invite URL: ${inviteUrl})`);
    }
  }
}
