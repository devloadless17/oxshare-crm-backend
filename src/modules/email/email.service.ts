import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { SmtpConfigService, type EffectiveSmtpConfig } from './smtp-config.service';
import {
  accountExists,
  adminInvite,
  adminPasswordReset,
  kycDecision,
  partnerDecision,
  withdrawalDecision,
  withdrawalOtp,
  passwordReset,
  smtpTest,
  verifyEmail,
  type RenderedEmail,
} from './templates';

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
function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  /**
   * The transporter, and the configuration it was built from.
   *
   * Built LAZILY and rebuilt when the configuration changes, where it used to be
   * built once in the constructor. That constructor read the environment at boot,
   * which is the whole reason SMTP could not be edited without a deploy — the
   * process would have gone on using the old relay until it restarted.
   *
   * The cache is keyed on `fingerprint` rather than on a timer, so a save in the
   * settings screen takes effect on the very next send instead of after a TTL.
   * `SmtpConfigService.resolve()` runs per send: it is one primary-key read
   * against a one-row table, next to an SMTP round trip.
   */
  private cached: { fingerprint: string; transporter: nodemailer.Transporter } | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly smtpConfig: SmtpConfigService,
  ) {}

  private transporterFor(config: EffectiveSmtpConfig): nodemailer.Transporter {
    if (this.cached?.fingerprint === config.fingerprint) return this.cached.transporter;

    // Release the sockets the old configuration is holding. Without this an
    // operator who edits SMTP a few times leaves a pool per edit alive until GC.
    this.cached?.transporter.close();

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.username ? { user: config.username, pass: config.password ?? '' } : undefined,
    });

    this.cached = { fingerprint: config.fingerprint, transporter };
    return transporter;
  }

  /**
   * Send one message through whatever SMTP configuration is currently in force.
   *
   * Every `send*` method below funnels through here. They each used to inline
   * the same four lines — the NODE_ENV guard, the transporter, the `from`
   * fallback and the try/catch — seven times, which is seven places for the
   * next change to miss one.
   *
   * ONE `from` for all of them now. Each call site previously passed its own
   * fallback display name ("OxShare Security", "OxShare Compliance", …), but
   * those only ever applied when `SMTP_FROM` was unset; with it set — as it is
   * required to be in production — every message already used the same sender.
   * The configured value is now the sender in all cases, which is also what the
   * settings screen shows.
   *
   * Failures are logged and swallowed, preserving the existing contract: no
   * caller of this service treats "the mail did not go" as a reason to fail the
   * operation that triggered it. `sendTestEmail` is the deliberate exception.
   */
  private async deliver(message: { to: string; subject: string; html: string }): Promise<void> {
    if (this.configService.get('NODE_ENV') === 'test') return;

    const config = await this.smtpConfig.resolve();
    await this.transporterFor(config).sendMail({ from: config.from, ...message });
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

  /**
   * Render, send, log, swallow — the shape every message below shares.
   *
   * Extracted because the eight methods that used to live here each repeated it
   * verbatim, and the repetition is where a missing try/catch hides: one method
   * that forgets it turns a mail outage into a failed registration.
   *
   * `what` names the message in the failure line. The RECIPIENT and the REASON
   * are logged and nothing else — never the URL, never the token (R-6.3).
   */
  private async send(to: string, what: string, message: RenderedEmail): Promise<void> {
    try {
      await this.deliver({ to, subject: message.subject, html: message.html });
      this.logger.log(`${what} sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send ${what} to ${to}: ${failureReason(error)}`);
    }
  }

  /** Where the portal lives, for links that point back into it. */
  private portalUrl(): string {
    return this.configService.get<string>('PORTAL_URL', 'http://localhost:3000');
  }

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const url = `${this.portalUrl()}/auth/verify-email?token=${token}`;
    this.echoForDevelopment('Verification link', email, url);
    await this.send(email, 'verification email', verifyEmail(url));
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const url = `${this.portalUrl()}/auth/reset-password?token=${token}`;
    this.echoForDevelopment('Password reset link', email, url);
    await this.send(email, 'password reset email', passwordReset(url));
  }

  async sendAccountExistsEmail(email: string): Promise<void> {
    await this.send(
      email,
      'account-exists notice',
      accountExists(`${this.portalUrl()}/auth/login`),
    );
  }

  // FR-ADM-03 / ARCH §8.5: approve and reject both notify the client inline.
  async sendKycDecisionEmail(
    email: string,
    firstName: string,
    decision: 'approved' | 'rejected',
    reason?: string,
    rejectedFields?: string[],
  ): Promise<void> {
    await this.send(
      email,
      `KYC ${decision} email`,
      kycDecision(firstName, decision, this.portalUrl(), reason, rejectedFields),
    );
  }

  /**
   * The partner-application verdict.
   *
   * Fire-and-forget at the call site, like the KYC decision and for the same
   * reason: the approval has already committed, and a mail server being briefly
   * down must not report a successful decision as failed.
   */
  async sendPartnerDecisionEmail(
    email: string,
    firstName: string,
    decision: 'approved' | 'rejected',
    options: { referralCode?: string; reason?: string } = {},
  ): Promise<void> {
    await this.send(
      email,
      `partner ${decision} email`,
      partnerDecision(firstName, decision, this.portalUrl(), options),
    );
  }

  /**
   * The withdrawal verdict — sent, or declined with the reason.
   *
   * Fire-and-forget at the call site and AFTER the transaction commits, like
   * every other decision mail here: the money has already moved, and a mail
   * server being briefly down must not roll back a settled payout.
   */
  async sendWithdrawalDecisionEmail(
    email: string,
    firstName: string,
    decision: 'paid' | 'rejected',
    amount: string,
    currency: string,
    reason?: string,
  ): Promise<void> {
    await this.send(
      email,
      `withdrawal ${decision} email`,
      withdrawalDecision(firstName, decision, amount, currency, this.portalUrl(), reason),
    );
  }

  /**
   * The six digits that confirm one specific withdrawal.
   *
   * AWAITED by its caller, unlike the decision mails above — the client is
   * sitting in front of a form waiting for a code, so "sent" has to mean sent.
   * Failure is still swallowed and logged by `send()`; the controller answers
   * with `required: true` regardless, and the client can request another.
   *
   * `echoForDevelopment` prints the code when MAIL_DEV_ECHO is on, and its own
   * warning says it is a live credential in a log. Never logged otherwise
   * (R-6.3).
   */
  async sendWithdrawalOtpEmail(
    email: string,
    amount: string,
    currency: string,
    code: string,
  ): Promise<void> {
    this.echoForDevelopment(`Withdrawal OTP (${amount} ${currency})`, email, code);
    await this.send(email, 'withdrawal confirmation code', withdrawalOtp(amount, currency, code));
  }

  async sendAdminInviteEmail(email: string, name: string, inviteUrl: string): Promise<void> {
    this.echoForDevelopment('Admin invite link', email, inviteUrl);
    await this.send(email, 'admin invite email', adminInvite(name, inviteUrl));
  }

  async sendAdminPasswordResetEmail(
    email: string,
    name: string,
    resetUrl: string,
    initiatedBy: string,
    expiresInMinutes: number,
  ): Promise<void> {
    this.echoForDevelopment('Admin password reset link', email, resetUrl);
    await this.send(
      email,
      'admin password reset email',
      adminPasswordReset(name, resetUrl, initiatedBy, expiresInMinutes),
    );
  }

  /**
   * Prove the current SMTP configuration actually delivers — the one send in
   * this class that is allowed to THROW.
   *
   * Every other method swallows its failure, which is right for them: a KYC
   * approval must not roll back because a mail server was briefly down. It is
   * exactly wrong here. The entire purpose of this send is to answer "does this
   * configuration work", and a version that logs the failure and returns
   * successfully answers "yes" every time.
   *
   * The caller passes no recipient — see the controller for why the acting
   * admin's own address is the only one accepted.
   *
   * Returns the resolved source so the screen can say whether it just tested the
   * saved row or the environment fallback, which is the difference between "my
   * settings work" and "my settings were never saved".
   *
   * Its body stays inline rather than moving to `templates/`: it reports the
   * host and the config source, so it is diagnostics rather than product copy,
   * and it is the one message a brand change should NOT touch.
   */
  async sendTestEmail(to: string): Promise<{ source: EffectiveSmtpConfig['source'] }> {
    const config = await this.smtpConfig.resolve();
    const message = smtpTest(config.host, config.port, config.source);

    /*
     * NOT routed through `deliver()`, which returns early under NODE_ENV=test.
     * That guard exists so the suite never opens a socket, and honouring it here
     * would make the test-send silently succeed without sending — the precise
     * failure this endpoint exists to detect. The controller is covered by an
     * HTTP spec with a mocked EmailService instead.
     */
    await this.transporterFor(config).sendMail({
      from: config.from,
      to,
      subject: message.subject,
      html: message.html,
    });

    this.logger.log(`SMTP test email sent to ${to} via ${config.source} configuration`);
    return { source: config.source };
  }
}
