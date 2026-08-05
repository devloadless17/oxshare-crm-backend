import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Why no URL appears in any log line in this file — PLATFORM-CONVENTIONS R-6.3.
 *
 * The verification link, the password-reset link and the admin-invite link are
 * each a BEARER CREDENTIAL in a query string. They used to be logged on every
 * send, in every environment, and again on every failure. The invite link is the
 * worst of the three: POST /admin/invite/accept turns it into a live admin
 * account with the inviter's granted permissions, so read access to a log store
 * — an aggregator, an error tracker, a support engineer's terminal — was enough
 * to mint an admin on a system that approves withdrawals.
 *
 * `auth.service.ts` already carried the comment "It is emailed and never written
 * to stdout"; that was true of the console.log removed there and false of the
 * logger.log left here, which is exactly how this survived a fix.
 *
 * A failure logs the RECIPIENT and the REASON. Those are what make it
 * diagnosable; the token never was.
 */
/**
 * Escape a value before it goes into an email template.
 *
 * `firstName` comes from registration and `reason` from an admin, and both were
 * interpolated raw into HTML. Mail clients block script, so this is not stored
 * XSS — but a crafted name can forge the visual content of a "your withdrawal
 * has been sent" message, which on a money system is the part that matters.
 */
function esc(value: string | undefined | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    } catch (error) {
      this.logger.error(`Failed to send verification email to ${email}: ${failureReason(error)}`);
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
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${email}: ${failureReason(error)}`);
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
        <p>Hello ${esc(firstName) || 'Valued Client'},</p>
        ${
          approved
            ? `<p>Your KYC application has been approved. Your account has been upgraded to verification level 1 and all gated features are now unlocked.</p>`
            : `<p>Your KYC application has been reviewed and requires corrections before it can be approved.</p>
             <p style="background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); border-radius: 8px; padding: 12px;"><strong>Reason:</strong> ${esc(reason)}</p>
             ${
               rejectedFields && rejectedFields.length > 0
                 ? `<p><strong>Fields to correct:</strong> ${rejectedFields.map(esc).join(', ')}</p>`
                 : ''
             }
             <p>Please log in, update the highlighted information, and resubmit.</p>`
        }
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
      this.logger.error(
        `Failed to send KYC ${decision} email to ${email}: ${failureReason(error)}`,
      );
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
        <p>Hello ${esc(firstName) || 'Valued Client'},</p>
        <p>Withdrawal of <strong>${esc(amount)} ${esc(currency)}</strong> ${paid ? 'has been processed and sent to your nominated destination.' : 'could not be processed.'}</p>
        ${!paid && reason ? `<p style="background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); border-radius: 8px; padding: 12px;"><strong>Reason:</strong> ${esc(reason)}</p><p>The reserved funds have been returned to your available balance and you may submit a new request.</p>` : ''}
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
    } catch (error) {
      this.logger.error(
        `Failed to send withdrawal ${decision} email to ${email}: ${failureReason(error)}`,
      );
    }
  }

  /**
   * The withdrawal confirmation code — FR-CORE-08 / FR-IND-05.
   *
   * The AMOUNT and CURRENCY are in the message on purpose, and they are the most
   * important words in it. A code that says only "here is your confirmation
   * code" trains people to relay six digits on request, which is precisely the
   * attack the OTP exists to stop: an attacker with a live session triggers a
   * send, the victim reads a plausible email, and the code buys a withdrawal the
   * victim never intended. Stating what is being authorised gives them the one
   * piece of information that makes the difference.
   *
   * The code is never logged (R-6.3) — the log line below records the recipient
   * only, and `redact.ts` would strip it anyway.
   */
  async sendWithdrawalOtpEmail(
    email: string,
    amount: string,
    currency: string,
    code: string,
  ): Promise<void> {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h2 style="color: #3b82f6;">Confirm your withdrawal</h2>
        <p>You asked to withdraw <strong style="color:#f8fafc;">${amount} ${currency}</strong>.</p>
        <p>Enter this code to confirm it:</p>
        <div style="margin: 24px 0; font-size: 32px; letter-spacing: 8px; font-weight: bold; color: #f8fafc;">
          ${code}
        </div>
        <p style="font-size: 12px; color: #94a3b8;">This code expires in 5 minutes and can be used once.</p>
        <p style="font-size: 12px; color: #fca5a5;">
          If you did not request this withdrawal, do not enter the code — change your password and
          contact support immediately.
        </p>
      </div>
    `;

    try {
      if (this.configService.get('NODE_ENV') !== 'test') {
        await this.transporter.sendMail({
          from: this.configService.get('SMTP_FROM', '"OxShare Payments" <no-reply@oxshare.com>'),
          to: email,
          subject: `Confirm your ${amount} ${currency} withdrawal — OxShare`,
          html,
        });
      }
      // Recipient only. Never the code.
      this.logger.log(`Withdrawal confirmation code sent to ${email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send withdrawal confirmation code to ${email}: ${failureReason(error)}`,
      );
    }
  }

  async sendAdminInviteEmail(email: string, name: string, inviteUrl: string): Promise<void> {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h2 style="color: #3b82f6;">You're invited to OxShare Admin</h2>
        <p>Hello ${esc(name)},</p>
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
    } catch (error) {
      this.logger.error(`Failed to send admin invite email to ${email}: ${failureReason(error)}`);
    }
  }
}
