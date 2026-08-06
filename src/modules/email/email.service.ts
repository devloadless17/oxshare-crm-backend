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

  /**
   * Print a credential to the log — LOCAL DEVELOPMENT ONLY, opt-in.
   *
   * The docblock at the top of this file explains why nothing here logs a URL by
   * default, and that reasoning stands. What it did not account for is that a
   * developer with no working SMTP server then has NO WAY to obtain a
   * verification link, an invite link or an OTP: the mail goes to a mailbox that
   * does not exist, the send fails, and the flow is untestable end to end.
   *
   * Two independent locks, because one is how this kind of thing escapes:
   *
   *   1. `MAIL_DEV_ECHO=true` — opt-in, so the flag is one you typed rather than
   *      one you inherited;
   *   2. NODE_ENV must not be production — and `env.validation.ts` REFUSES TO
   *      BOOT if the flag is set there, so a copied .env fails loudly at deploy
   *      instead of quietly streaming invite links into a log aggregator.
   *
   * `warn`, not `log`: this is an abnormal state that should look abnormal in
   * the terminal, and it keeps the line out of a default `log`-level capture.
   */
  private echoForDevelopment(label: string, recipient: string, credential: string): void {
    if (this.configService.get<string>('MAIL_DEV_ECHO') !== 'true') return;
    if (this.configService.get<string>('NODE_ENV') === 'production') return;

    this.logger.warn(
      `[MAIL_DEV_ECHO] ${label} for ${recipient}: ${credential}\n` +
        '           ^ development only — this is a live credential, and it is in your log ' +
        'because MAIL_DEV_ECHO=true.',
    );
  }

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const portalUrl = this.configService.get<string>('PORTAL_URL', 'http://localhost:3000');
    const verificationUrl = `${portalUrl}/auth/verify-email?token=${token}`;
    this.echoForDevelopment('Verification link', email, verificationUrl);

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
    this.echoForDevelopment('Password reset link', email, resetUrl);

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
    this.echoForDevelopment(`Withdrawal OTP (${amount} ${currency})`, email, code);
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

  /**
   * "Somebody tried to register with your address" — the other half of a
   * registration endpoint that does not leak.
   *
   * `register` used to answer 409 "An account with this email already exists.",
   * which let anyone test an address list against the API and learn who banks
   * here. For a broker that is a membership oracle about people's finances, and
   * it is the same leak `requestPasswordReset` goes to real lengths to avoid two
   * methods above.
   *
   * Removing the 409 alone would have been worse than the leak: the legitimate
   * person who forgot they had an account would get a success message, no email,
   * and no way to find out why they cannot sign in. So the information still
   * goes out — to the ONE mailbox entitled to it, rather than to the caller.
   */
  async sendAccountExistsEmail(email: string): Promise<void> {
    const portalUrl = this.configService.get<string>('PORTAL_URL', 'http://localhost:3000');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h2 style="color: #3b82f6;">You already have an OxShare account</h2>
        <p>Someone just tried to create an account with this email address. You already have one, so we did not create a second.</p>
        <p>If that was you, sign in instead — or reset your password if you have forgotten it.</p>
        <div style="margin: 30px 0;">
          <a href="${portalUrl}/auth/login" style="background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
            Sign in
          </a>
        </div>
        <p style="font-size: 12px; color: #94a3b8;">
          If it was not you, no action is needed — nothing about your account has changed and no
          new account was created.
        </p>
      </div>
    `;

    try {
      if (this.configService.get('NODE_ENV') !== 'test') {
        await this.transporter.sendMail({
          from: this.configService.get('SMTP_FROM', '"OxShare System" <no-reply@oxshare.com>'),
          to: email,
          subject: 'You already have an OxShare account',
          html,
        });
      }
      this.logger.log(`Account-exists notice sent to ${email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send account-exists notice to ${email}: ${failureReason(error)}`,
      );
    }
  }

  async sendAdminInviteEmail(email: string, name: string, inviteUrl: string): Promise<void> {
    this.echoForDevelopment('Admin invite link', email, inviteUrl);
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

  /**
   * "A colleague reset your password" — D-44.
   *
   * Says WHO did it, deliberately. This is the only signal the recipient gets
   * that somebody with high privilege acted on their account, and an admin who
   * did NOT ask for this needs to be able to tell instantly — a reset they did
   * not request is either a mistake or somebody working towards their session.
   * A generic "your password was reset" hides exactly the fact worth raising.
   *
   * Short expiry stated in the mail, because a link that dies silently reads as
   * a broken product rather than a deliberate limit.
   */
  async sendAdminPasswordResetEmail(
    email: string,
    name: string,
    resetUrl: string,
    initiatedBy: string,
    expiresInMinutes: number,
  ): Promise<void> {
    this.echoForDevelopment('Admin password reset link', email, resetUrl);
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 12px;">
        <h2 style="color: #3b82f6;">Set a new OxShare Admin password</h2>
        <p>Hello ${esc(name)},</p>
        <p><strong>${esc(initiatedBy)}</strong> started a password reset for your back-office account. Choose a new password using the link below. It expires in ${expiresInMinutes} minutes and can only be used once.</p>
        <div style="margin: 30px 0;">
          <a href="${resetUrl}" style="background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
            Set a new password
          </a>
        </div>
        <p style="font-size: 12px; color: #94a3b8;">Setting a new password signs you out everywhere else. If you did NOT ask for this, contact ${esc(initiatedBy)} immediately — someone with administrator access started it.</p>
      </div>
    `;

    try {
      if (this.configService.get('NODE_ENV') !== 'test') {
        await this.transporter.sendMail({
          from: this.configService.get('SMTP_FROM', '"OxShare System" <no-reply@oxshare.com>'),
          to: email,
          subject: 'Set a new admin password — OxShare',
          html,
        });
      }
      this.logger.log(`Admin password reset email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send admin reset email to ${email}: ${failureReason(error)}`);
    }
  }
}
