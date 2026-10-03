import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { SmtpConfigService, type EffectiveSmtpConfig } from './smtp-config.service';
import type { Locale } from '../../common/i18n/locale';
import { RejectionReasonsStore, type RejectionContext } from '../../store/rejection-reasons.store';
import {
  emailChangedNotice,
  adminInvite,
  adminPasswordReset,
  kycDecision,
  kycDetailsCorrected,
  kycReverification,
  partnerDecision,
  depositOutcome,
  walletCredit,
  tradingAccountOpened,
  tradingAccountPasswordReset,
  withdrawalDecision,
  passwordReset,
  setEmailLogoOrigin,
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
    /*
     * Optional so a spec that constructs this by hand keeps working; in the app
     * the global StoreModule always provides it. Without it a reason is simply
     * mailed as typed.
     */
    @Optional() private readonly rejectionReasons?: RejectionReasonsStore,
  ) {
    // Every mail's logo comes from THIS environment's portal — see `layout.ts`.
    setEmailLogoOrigin(this.portalUrl());
  }

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

  /**
   * An operator's REASON, in the language of the mail — the one place emails
   * translate operator text.
   *
   * A reason is free text, but usually it is a label picked from the
   * configurable catalogue (`rejection_reasons`), and since 0179 a label may
   * carry an Arabic twin. So: when the mail is Arabic and the reason IS a
   * catalogue label of the same context — exactly, or as the
   * "label — reviewer's note" a partner refusal composes — the label is
   * swapped for its Arabic and the note kept as typed. Anything else, and any
   * failure to look, is mailed exactly as the operator wrote it: a reason in
   * English beats no mail.
   *
   * The Arabic STORED with the decision comes first (3 Oct 2026): the
   * reviewer's own Arabic, or the catalogue's as it read when they decided —
   * what the portal shows the client, so the mail and the screen agree.
   */
  private async reasonIn(
    context: RejectionContext,
    reason: string | undefined,
    locale: Locale,
    storedArabic?: string | null,
  ): Promise<string | undefined> {
    if (locale !== 'ar' || !reason) return reason;
    if (typeof storedArabic === 'string' && storedArabic.trim() !== '') return storedArabic;
    if (!this.rejectionReasons) return reason;
    try {
      // The store's own resolver — the same lookup the client DTOs use: the
      // exact label, a "label — note" with the label translated, or a sentence
      // the system wrote.
      const arabicOf = await this.rejectionReasons.arabicFor([context]);
      const arabic = arabicOf(context, reason);
      if (arabic) return arabic;
      // "label — reviewer's note" against any resolver: the label in Arabic, the note as typed.
      const separator = ' — ';
      for (let at = reason.indexOf(separator); at > 0; at = reason.indexOf(separator, at + 1)) {
        const label = arabicOf(context, reason.slice(0, at));
        if (label) return `${label}${reason.slice(at)}`;
      }
    } catch (error) {
      this.logger.warn(`Could not look up an Arabic ${context} reason: ${failureReason(error)}`);
    }
    return reason;
  }

  /** Where the portal lives, for links that point back into it. */
  private portalUrl(): string {
    return this.configService.get<string>('PORTAL_URL', 'http://localhost:3000');
  }

  /**
   * Print an actionable link to the log — LOCAL TESTING ONLY.
   *
   * `send` above logs the recipient and never the URL (R-6.3), which is the
   * right default and stays the default: these links ARE credentials. But SMTP
   * is admin-configured, so a developer with no relay gets nothing at all, and
   * fixture addresses like `@oxtest.local` could not receive it if there were
   * one. The alternative people reach for is reading the token out of the
   * database, and that is a habit worth not forming.
   *
   * Gated on `LOG_EMAIL_LINKS`, which `env.validation.ts` REFUSES TO START with
   * in production. Called beside the real send rather than instead of it, so
   * enabling this changes what is logged and nothing about what is delivered.
   */
  private logLink(what: string, to: string, url: string): void {
    if (!this.configService.get<boolean>('LOG_EMAIL_LINKS')) return;
    this.logger.warn(`[LOG_EMAIL_LINKS] ${what} for ${to}: ${url}`);
  }

  /**
   * Print MT5 trading-account credentials to the log — LOCAL TESTING ONLY.
   *
   * Separate from `logLink` because the risk is worse, not merely equal. A reset
   * link expires and can be reissued; these passwords are delivered EXACTLY
   * ONCE. MT5 has already been told them by the time this runs, nothing on this
   * platform stores them, and the only remedy for a lost pair is a reset that
   * invalidates the working account. So on a mailbox that cannot receive — every
   * `@…local` fixture — the credentials are simply gone, and the account is
   * untestable.
   *
   * Same gate as the links, and the same production refusal at boot.
   */
  private logCredentials(what: string, to: string, detail: Record<string, string | number>): void {
    if (!this.configService.get<boolean>('LOG_EMAIL_LINKS')) return;
    const printed = Object.entries(detail)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('  ');
    this.logger.warn(`[LOG_EMAIL_LINKS] ${what} for ${to}: ${printed}`);
  }

  /**
   * The link, and — when a client is in front of the code screen — the 6-digit
   * code beside it. The CODE is never logged, not even under LOG_EMAIL_LINKS:
   * it signs its holder in, and `email-never-logs-credentials.spec.ts` holds
   * this file to that.
   */
  async sendVerificationEmail(
    email: string,
    token: string,
    code?: string,
    locale: Locale = 'en',
  ): Promise<void> {
    const url = `${this.portalUrl()}/auth/verify-email?token=${token}`;
    this.logLink('verification link', email, url);
    await this.send(email, 'verification email', verifyEmail(url, code, locale));
  }

  async sendPasswordResetEmail(email: string, token: string, locale: Locale = 'en'): Promise<void> {
    const url = `${this.portalUrl()}/auth/reset-password?token=${token}`;
    this.logLink('password reset link', email, url);
    await this.send(email, 'password reset email', passwordReset(url, locale));
  }

  // FR-ADM-03 / ARCH §8.5: approve and reject both notify the client inline.
  /**
   * Warn the PREVIOUS address that the sign-in email was changed.
   *
   * Sent to the old mailbox, deliberately, and after the change has already
   * taken effect — see the template. It is the only signal that reaches someone
   * who would care about an unauthorised change while they can still act on it;
   * the permission gate and the audit row both point inwards, at the broker.
   *
   * The SMTP `from` address doubles as the support contact rather than
   * introducing a second setting: it is the address a client already recognises
   * from every other mail this system sends, and one that is definitely
   * configured wherever mail works at all.
   */
  async sendEmailChangedNotice(
    previousEmail: string,
    newEmail: string,
    locale: Locale = 'en',
  ): Promise<void> {
    /*
     * The try/catch is around `resolve()` as well as the send, and that is the
     * whole point of it.
     *
     * `send()` swallows its own delivery failures, but this method needed the
     * configured `from` address BEFORE rendering — and `resolve()` throws when
     * no SMTP settings exist. Outside a catch, that turned "the broker has not
     * configured mail yet" into a 503 on the email change itself: the address
     * had already been updated and the sessions already revoked, so the
     * operation was done, and the caller was told it had failed.
     *
     * No caller of this service treats "the mail did not go" as a reason to
     * fail the operation that triggered it. That contract is what this
     * preserves.
     */
    try {
      const { from } = await this.smtpConfig.resolve();
      await this.send(
        previousEmail,
        'email-changed notice',
        emailChangedNotice(newEmail, from, locale),
      );
    } catch (error) {
      this.logger.error(
        `Failed to send email-changed notice to ${previousEmail}: ${failureReason(error)}`,
      );
    }
  }

  async sendKycDecisionEmail(
    email: string,
    firstName: string,
    decision: 'approved' | 'rejected',
    reason?: string,
    rejectedFields?: string[],
    locale: Locale = 'en',
    /** The reason's stored Arabic (0179), preferred in an Arabic mail. */
    reasonAr?: string | null,
  ): Promise<void> {
    const shown = await this.reasonIn('kyc', reason, locale, reasonAr);
    await this.send(
      email,
      `KYC ${decision} email`,
      kycDecision(firstName, decision, this.portalUrl(), shown, rejectedFields, locale),
    );
  }

  /**
   * A reviewer corrected an APPROVED client's verified details. Names which, not
   * their values. Fire-and-forget like every decision email: the correction has
   * already committed.
   */
  async sendKycDetailsCorrectedEmail(
    email: string,
    firstName: string,
    details: readonly string[],
    locale: Locale = 'en',
  ): Promise<void> {
    await this.send(
      email,
      'KYC details corrected email',
      kycDetailsCorrected(firstName, details, this.portalUrl(), locale),
    );
  }

  /** A reviewer returned an APPROVED verification for the client to update. */
  async sendKycReverificationEmail(
    email: string,
    firstName: string,
    reason: string,
    items: readonly string[],
    locale: Locale = 'en',
    /** The reason's stored Arabic (0179), preferred in an Arabic mail. */
    reasonAr?: string | null,
  ): Promise<void> {
    const shown = (await this.reasonIn('kyc', reason, locale, reasonAr)) ?? reason;
    await this.send(
      email,
      'KYC re-verification email',
      kycReverification(firstName, shown, items, this.portalUrl(), locale),
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
    options: { referralCode?: string; reason?: string; reasonAr?: string | null } = {},
    locale: Locale = 'en',
  ): Promise<void> {
    const reason = await this.reasonIn('partner', options.reason, locale, options.reasonAr);
    await this.send(
      email,
      `partner ${decision} email`,
      partnerDecision(
        firstName,
        decision,
        this.portalUrl(),
        { referralCode: options.referralCode, reason },
        locale,
      ),
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
    decision: 'approved' | 'paid' | 'rejected',
    amount: string,
    currency: string,
    reason?: string,
    locale: Locale = 'en',
    /** The reason's stored Arabic (0179), preferred in an Arabic mail. */
    reasonAr?: string | null,
  ): Promise<void> {
    const shown = await this.reasonIn('withdrawal', reason, locale, reasonAr);
    await this.send(
      email,
      `withdrawal ${decision} email`,
      withdrawalDecision(firstName, decision, amount, currency, this.portalUrl(), shown, locale),
    );
  }

  /**
   * The deposit verdict — FR-CORE-07's "client notified of the outcome".
   *
   * Fire-and-forget at the call site and AFTER the settlement transaction has
   * committed, like every decision mail here: the credit is already real, and
   * a mail outage must not roll it back or report it failed.
   */
  async sendDepositOutcomeEmail(
    email: string,
    firstName: string,
    outcome: 'succeeded' | 'failed' | 'rejected',
    amount: string,
    currency: string,
    /** The desk's reason, for `rejected` only. */
    reason?: string,
    locale: Locale = 'en',
    /** The reason's stored Arabic (0179), preferred in an Arabic mail. */
    reasonAr?: string | null,
  ): Promise<void> {
    const shown = await this.reasonIn('deposit', reason, locale, reasonAr);
    await this.send(
      email,
      `deposit ${outcome} email`,
      depositOutcome(firstName, outcome, amount, currency, this.portalUrl(), shown, locale),
    );
  }

  /**
   * Money an operator added to a wallet by hand.
   *
   * Fire-and-forget at the call site and AFTER the credit has posted, like the
   * decision mails above: the money has already landed, and a mail server being
   * briefly down must not roll back a balance the client can already spend.
   *
   * The REASON is passed straight through rather than defaulted — `creditWallet`
   * refuses an empty one, so there is no case where this mail has nothing to
   * explain.
   */
  async sendWalletCreditEmail(
    email: string,
    firstName: string,
    amount: string,
    currency: string,
    reason: string,
    locale: Locale = 'en',
    /** The operator's own Arabic for the reason (0179), used in an Arabic mail. */
    reasonAr?: string | null,
  ): Promise<void> {
    // No catalogue behind a credit reason: it is mailed as the operator typed it —
    // in Arabic when they wrote it in Arabic too and the mail is Arabic.
    const shown =
      locale === 'ar' && typeof reasonAr === 'string' && reasonAr.trim() !== '' ? reasonAr : reason;
    await this.send(
      email,
      'wallet credit email',
      walletCredit(firstName, amount, currency, shown, this.portalUrl(), locale),
    );
  }

  /**
   * The credentials for a newly opened trading account.
   *
   * ## AWAITED, unlike the decision mails above
   *
   * Those describe something that already happened and can be re-derived from
   * the CRM if the mail is lost. This one carries the ONLY copy of two
   * passwords that exist nowhere else — not in our database, not in the API
   * response, not in MT5 in a readable form. Firing it and forgetting would
   * mean the caller reports success while the client has an account they cannot
   * log into.
   *
   * `send()` still swallows and logs the failure rather than throwing, so the
   * account is not rolled back over an SMTP blip — but the caller has waited
   * for the attempt, and the log line names the login so an operator can reset
   * it deliberately.
   *
   * The passwords are never logged (R-6.3) — EXCEPT under `LOG_EMAIL_LINKS`,

   * a local-testing flag production refuses to boot with. See `logCredentials`.
   */
  async sendTradingAccountOpenedEmail(
    email: string,
    firstName: string,
    login: string,
    environment: 'live' | 'demo',
    currency: string,
    leverage: number,
    masterPassword: string,
    investorPassword: string,
    accountName?: string,
    balance?: string,
    locale: Locale = 'en',
  ): Promise<void> {
    this.logCredentials(`trading account ${login} credentials`, email, {
      login,
      environment,
      currency,
      leverage,
      masterPassword,
      investorPassword,
    });
    await this.send(
      email,
      `trading account ${login} credentials`,
      tradingAccountOpened(
        firstName,
        login,
        environment,
        currency,
        leverage,
        masterPassword,
        investorPassword,
        this.portalUrl(),
        accountName,
        balance,
        locale,
      ),
    );
  }

  /**
   * The NEW passwords after a client reset their trading account.
   *
   * Awaited by the caller for the same reason the creation mail is: this is the
   * ONLY delivery, and MT5 has already rotated the credentials by the time we
   * reach here. If the send fails, the client is locked out of an account that
   * worked a second ago, so the caller must know the attempt finished before it
   * reports success.
   *
   * `send()` still swallows and logs rather than throwing. There is no undo for
   * a password change, so failing the request would announce a rollback that did
   * not happen; the log line names the login instead, which is what an operator
   * needs in order to resend or reset again deliberately.
   *
   * The passwords are never logged (R-6.3).
   */
  async sendTradingAccountPasswordResetEmail(
    email: string,
    firstName: string,
    login: string,
    environment: 'live' | 'demo',
    masterPassword: string,
    investorPassword: string,
    locale: Locale = 'en',
  ): Promise<void> {
    this.logCredentials(`trading account ${login} new passwords`, email, {
      login,
      environment,
      masterPassword,
      investorPassword,
    });
    await this.send(
      email,
      `trading account ${login} password reset`,
      tradingAccountPasswordReset(
        firstName,
        login,
        environment,
        masterPassword,
        investorPassword,
        this.portalUrl(),
        undefined,
        locale,
      ),
    );
  }

  /*
   * `sendWithdrawalOtpEmail` and its `withdrawal-otp` template are GONE with
   * the withdrawal confirmation code — nothing issues a code, so nothing has
   * one to mail. The withdrawal DECISION emails below are unaffected: a client
   * is still told when a payout is approved or refused.
   */

  async sendAdminInviteEmail(email: string, name: string, inviteUrl: string): Promise<void> {
    this.logLink('admin invite link', email, inviteUrl);
    await this.send(email, 'admin invite email', adminInvite(name, inviteUrl));
  }

  async sendAdminPasswordResetEmail(
    email: string,
    name: string,
    resetUrl: string,
    initiatedBy: string,
    expiresInMinutes: number,
  ): Promise<void> {
    this.logLink('admin password reset link', email, resetUrl);
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
