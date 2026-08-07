import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { UsersStore, User } from '../../store/users.store';
import { IbStore } from '../../store/ib.store';
import {
  WALLET_PROVISIONING,
  type WalletProvisioningPort,
} from '../../common/provisioning/wallet-provisioning.port';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import { EmailService } from '../email/email.service';
import { Request, Response } from 'express';
import {
  AuthenticationError,
  AuthorizationError,
  EmailNotVerifiedError,
  NotFoundError,
  SessionReplayedError,
  SessionRevokedError,
  SessionSupersededError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { createHash, randomUUID } from 'crypto';
import { CsrfService } from '../../common/security/csrf.service';
import {
  RefreshTokensService,
  type DeviceFingerprint,
} from '../../common/security/refresh-tokens.service';
import { PasswordService } from '../../common/security/password.service';
import { AVATAR_BUCKET, StoredFilesService } from '../../common/uploads/stored-files.service';
import { LoginAttemptsService } from '../../common/security/login-attempts.service';
import {
  isTokenKind,
  TOKEN_ALGORITHM,
  TOKEN_ALGORITHMS,
  TOKEN_CLOCK_TOLERANCE_SECONDS,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_KIND,
} from '../../common/security/token-audience';
import {
  COOKIE_BASES,
  clearLegacySessionCookies,
  clearSessionCookie,
  csrfCookieOptions,
  readSessionCookie,
  sessionCookieNames,
  sessionCookieOptions,
} from '../../common/security/session-cookies';

/*
 * 15 minutes, not 8 hours — PLATFORM-CONVENTIONS R-3.3.
 *
 * An access token is checked by SIGNATURE on every request and against the
 * database only on REFRESH, so its lifetime is exactly how long a revoked
 * session keeps working: suspend an admin, and an 8-hour token kept them signed
 * in for the rest of the working day.
 *
 * 15 minutes is affordable because the refresh path is already built — both
 * frontends refresh proactively every 10 minutes and again on any 401, and
 * rotation now detects replay (R-3.3). The cost is one extra round trip per 15
 * minutes; the benefit is that revocation means something.
 */
const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * SHA-256 of a reset token, hex.
 *
 * A fast hash on purpose. The token is 122 bits of randomness from
 * `randomUUID`, so there is no guessable secret for a slow KDF to protect —
 * argon2 here would buy nothing and add latency to an unauthenticated lookup an
 * attacker can trigger at will. What this defends against is a database dump
 * being replayable as reset links, and a digest is sufficient for that.
 */
function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly users: UsersStore,
    private readonly csrf: CsrfService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly passwords: PasswordService,
    private readonly loginAttempts: LoginAttemptsService,
    // Appended rather than slotted in beside `passwords`: these parameters are
    // positional at every `new AuthService(...)` in the test suite, so inserting
    // in the middle silently shifts two arguments into the wrong slots.
    private readonly files: StoredFilesService,
    /*
     * Resolves a referral code to the partner who owns it.
     *
     * The STORE rather than `IbApplicationsService`, and that is not laziness:
     * `IbModule` imports `IdentityModule` for its guards, so depending on the
     * service here would close a module cycle. `IbStore` lives in the @Global
     * `StoreModule`, which nothing imports and everything can reach.
     *
     * OPTIONAL for the reason above: every hand-constructed
     * `new AuthService(...)` in the suite passes its arguments positionally, so
     * a required parameter would mean editing each of them to test something
     * unrelated to referrals. `resolveReferral` returns undefined without it.
     *
     */
    private readonly ib?: IbStore,
    /*
     * Opens the client's wallets on registration — one per ENABLED currency.
     *
     * A PORT, not `WalletProvisioningService` itself: importing `WalletModule`
     * here would recreate the identity ↔ wallet cycle this module's header
     * calls "cheap to add and expensive to notice", and reaching the service
     * through the @Global `StoreModule` inverts the layering the lint rule
     * protects. The declaration lives in `common/`; `WalletModule` binds it.
     *
     * Optional, following the convention above. It never throws — see the
     * port's contract: a registration that fails after the user row is
     * committed leaves an account nobody can sign into and nobody can
     * re-create, because the address is taken.
     */
    @Optional()
    @Inject(WALLET_PROVISIONING)
    private readonly walletProvisioning?: WalletProvisioningPort,
  ) {}

  // ─── Register ────────────────────────────────────────────────────────────────
  /**
   * Create an account. ALWAYS answers the same, whether or not one exists.
   *
   * This used to throw `409 An account with this email already exists.`, which
   * made registration a membership oracle: anyone could test an address list
   * against it and learn who banks here. `requestPasswordReset` below goes to
   * real lengths to avoid exactly that ("the honest-looking error is the
   * vulnerability"), and registration quietly gave it back — throttled at 10 per
   * hour per IP, which bounds the rate and not the leak.
   *
   * WHAT MAKES THIS SAFE TO CHANGE. Simply removing the 409 would be worse than
   * the leak: the person who forgot they already had an account would get a
   * cheerful success message, no email, and no way to discover why they cannot
   * sign in. So the information still goes out — to the ONE mailbox entitled to
   * it. The existing account holder is told somebody tried, and pointed at sign
   * in and password reset; the caller is told nothing they did not already know.
   *
   * The cost is real and worth stating: a legitimate user who mistypes an
   * address they already own no longer gets an immediate "you already have an
   * account" on screen. They get it by email, one round trip later.
   */
  async register(dto: RegisterDto) {
    const generic = {
      message: 'Registration successful. Please check your email to verify your account.',
    };

    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      // Awaited, not fire-and-forget: this is the ONLY signal the legitimate
      // owner gets, and losing it silently would turn a privacy improvement into
      // a support ticket nobody can diagnose.
      await this.email.sendAccountExistsEmail(existing.email);
      this.logger.log(`Registration attempted for an existing address: ${existing.email}`);
      /*
       * No `userId`, because there is no new account and returning the existing
       * one's id would hand back the very fact this is hiding. The portal reads
       * `.message` only — see RegistrationResponseDto.
       */
      return generic;
    }

    const passwordHash = await this.passwords.hash(dto.password);
    const verificationToken = uuidv4();
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const referredByIbUserId = await this.resolveReferral(dto.referralCode);

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
      referredByIbUserId,
    });

    /*
     * A wallet in every enabled currency, before the email goes out.
     *
     * Awaited rather than fire-and-forget so the client's first sign-in finds
     * their balances already there — but it cannot fail the registration, and
     * the service swallows its own errors for that reason. `?.` because the
     * parameter is optional; see the constructor.
     */
    await this.walletProvisioning?.openAllEnabledWallets(user.id);

    // The verification link is a bearer credential. It is emailed and never
    // written to stdout — it used to be console.logged in every environment.
    await this.email.sendVerificationEmail(user.email, verificationToken);
    this.logger.log(`Verification email dispatched to ${user.email}`);

    return { ...generic, userId: user.id };
  }

  /**
   * A referral code to the partner who owns it, or undefined.
   *
   * ## An unusable code NEVER refuses the registration
   *
   * It logs and returns undefined, so the client signs up unattributed. A
   * referral link is marketing collateral: it gets shortened, truncated by chat
   * apps, retyped from a screenshot and shared long after a partner is
   * suspended. Refusing a signup over any of that trades a real client for a
   * bookkeeping detail, and the client is the thing we cannot get back.
   *
   * ## A SUSPENDED partner still attributes
   *
   * Suspension stops them earning; it does not unmake the introduction, and
   * they keep their code and their tree precisely so the clients beneath them
   * stay put. A reactivated partner should not find the clients they introduced
   * while suspended have been silently reassigned to nobody.
   *
   * Codes are compared upper-cased and trimmed. They are issued from an
   * unambiguous upper-case alphabet, and a client typing one off a screenshot
   * should not be defeated by their keyboard.
   */
  private async resolveReferral(code: string | undefined): Promise<string | undefined> {
    const trimmed = code?.trim().toUpperCase();
    if (!trimmed) return undefined;

    // Absent only in hand-constructed test instances — see the constructor.
    if (!this.ib) return undefined;

    const account = await this.ib.findAccountByReferralCode(trimmed);
    if (!account) {
      // Logged, not thrown. An operator seeing a stream of these has a real
      // signal that a published link is wrong.
      this.logger.warn(`Registration used an unknown referral code: ${trimmed}`);
      return undefined;
    }
    return account.userId;
  }

  // ─── Verify Email ─────────────────────────────────────────────────────────────
  async verifyEmail(token: string) {
    const user = await this.users.findByVerificationToken(token);
    if (!user) throw new ValidationError('Invalid or expired verification token.');
    if (user.emailVerificationExpiry && user.emailVerificationExpiry < new Date()) {
      /*
       * Clear the dead token before refusing, exactly as `resetPassword` does.
       *
       * It used to be left in place, so an expired token sat in the row
       * indefinitely — the only one-time credential here that outlived its own
       * expiry, and the only one stored in plaintext. Removing it on the way out
       * means the row stops carrying a credential that can never be useful.
       */
      await this.users.update(user.id, {
        emailVerificationToken: undefined,
        emailVerificationExpiry: undefined,
      });
      throw new ValidationError('Verification token has expired. Please request a new one.');
    }

    /*
     * `verificationLevel: 0` used to be written here as well, and it is gone.
     *
     * Email verification has no business writing the KYC level. It only ever
     * wrote 0, so it never did harm — but it made this a second writer of the
     * column that gates withdrawals (FR-CORE-15), alongside registration and the
     * two KYC decisions. A field whose value must be explainable in an audit is
     * easier to reason about with three writers than four, and this was the one
     * that had no reason to be there.
     *
     * Registration already sets it to 0, and nothing between registration and
     * email verification can raise it — approval requires a submitted KYC, which
     * requires a verified email.
     */
    await this.users.update(user.id, {
      emailVerified: true,
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

  // ─── Password reset ─────────────────────────────────────────────────────────
  //
  // FR-CORE-09 · PLATFORM-CONVENTIONS R-3.5. The portal has had this UI live for
  // months with no endpoint behind it — both calls 404'd, so a client who forgot
  // their password had no recovery path and nothing explaining why.

  /**
   * Start a reset. ALWAYS answers the same, whether or not the account exists.
   *
   * An endpoint that says "no account with that email" is a membership oracle:
   * anyone can test an address list against it and learn who banks here. That
   * matters more for a broker than for most products, and it costs nothing to
   * avoid — the honest-looking error is the vulnerability.
   *
   * The token is random and high-entropy; only its SHA-256 goes to the database,
   * so a dump or a read-only injection cannot be turned into a working reset
   * link (see schema.ts).
   */
  async requestPasswordReset(email: string) {
    const generic = {
      message: 'If an account exists for that address, a reset link is on its way.',
    };

    const user = await this.users.findByEmail(email);
    if (!user) return generic;

    // A suspended account must not be recoverable by its holder — reinstating it
    // is an admin decision, and a working reset would route around that.
    if (user.status === 'suspended') return generic;

    const token = randomUUID();
    await this.users.update(user.id, {
      passwordResetTokenHash: hashResetToken(token),
      // 30 minutes (R-3.5). Long enough to find the email, short enough that a
      // link left in an inbox is not a standing key to the account.
      passwordResetExpiry: new Date(Date.now() + 30 * 60 * 1000),
    });

    await this.email.sendPasswordResetEmail(user.email, token);
    // The recipient, never the token — the link is a credential (R-6.3).
    this.logger.log(`Password reset requested for ${user.email}`);
    return generic;
  }

  /**
   * Complete a reset.
   *
   * Single-use and time-boxed, and — the part that is easy to leave out — it
   * REVOKES EVERY SESSION. Someone resetting a password is usually doing it
   * because they believe they are compromised; leaving the attacker's 30-day
   * refresh token alive would make the reset theatre.
   */
  async resetPassword(token: string, newPassword: string) {
    const user = await this.users.findByPasswordResetTokenHash(hashResetToken(token));

    // One message for "no such token" and "expired token". Distinguishing them
    // tells an attacker which of their guesses was once real.
    const invalid = new ValidationError(
      'This reset link is invalid or has expired. Please request a new one.',
    );
    if (!user) throw invalid;
    if (!user.passwordResetExpiry || user.passwordResetExpiry < new Date()) {
      // Clear the dead token rather than leaving it to linger and be retried.
      await this.users.update(user.id, {
        passwordResetTokenHash: undefined,
        passwordResetExpiry: undefined,
      });
      throw invalid;
    }

    await this.users.update(user.id, {
      passwordHash: await this.passwords.hash(newPassword),
      // Kills every access token issued before this instant - see the column's
      // comment in schema.ts. Revoking the refresh families below ends the
      // ability to RENEW; this ends the tokens already out there.
      passwordChangedAt: new Date(),
      /*
       * A COMPLETED RESET VERIFIES THE ADDRESS.
       *
       * The reset link went to this mailbox and came back, which is the same
       * proof the verification link exists to obtain — a stronger one, since it
       * also changed the credential. Leaving `emailVerified` false here would
       * strand a user who registered, never opened the verification mail, and
       * then used "forgot password": they would hold a working password and be
       * refused at login by the check above, with the resend button their only
       * way out and no reason on screen why the reset they just completed did
       * not count.
       *
       * The stale verification token goes with it. It is a live credential for
       * a fact now established by other means, and the row should not keep one
       * that can only ever be redundant — the same reasoning `verifyEmail`
       * applies when it clears an expired token.
       */
      emailVerified: true,
      emailVerificationToken: undefined,
      emailVerificationExpiry: undefined,
      // Cleared in the same write as the new password: the token is spent the
      // moment it works, so a replay finds nothing.
      passwordResetTokenHash: undefined,
      passwordResetExpiry: undefined,
      // The dead `refresh_token` column is gone; revoking the FAMILIES below is
      // what actually ends every session, and always was.
    });

    // Every refresh-token family for this user, not just the current one.
    await this.refreshTokens.revokeAllForSubject('portal', user.id);

    this.logger.log(`Password reset completed for ${user.email}; all sessions revoked`);
    return { message: 'Your password has been updated. Please sign in again.' };
  }

  // ─── Login ────────────────────────────────────────────────────────────────────
  async login(dto: LoginDto, res: Response, device?: DeviceFingerprint) {
    // Per-ACCOUNT lockout — R-3.5. The @Throttle on this route is keyed on the
    // IP, which does nothing about a distributed run against one account.
    // Checked first, so a locked account costs an attacker a round trip rather
    // than an argon2 hash.
    const lockedFor = await this.loginAttempts.lockedFor('portal', dto.email);
    if (lockedFor !== null) {
      throw new AuthenticationError(
        `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60_000)} minute(s).`,
      );
    }

    const user = await this.users.findByEmail(dto.email);

    /*
     * Dual-read: accepts a stored bcrypt hash, then quietly replaces it with
     * argon2id (R-3.4). Nobody is forced to reset a password they already have,
     * and the bcrypt population drains as people log in.
     *
     * Note there is no early return for a missing account. Passing `undefined`
     * makes PasswordService spend the same argon2 work and answer false, so a
     * login for an unknown address is not distinguishable from a wrong password
     * by TIMING — see password.service.ts. The identical message below was only
     * ever half of that guarantee.
     */
    const { valid: passwordMatch, needsRehash } = await this.passwords.verify(
      dto.password,
      user?.passwordHash,
    );
    if (user && passwordMatch && needsRehash) {
      const upgraded = await this.passwords.hash(dto.password);
      await this.users.update(user.id, { passwordHash: upgraded });
      this.logger.log(`Upgraded password hash to argon2id for user ${user.id}`);
    }
    if (!user || !passwordMatch) {
      // Recorded for addresses that do not exist too — counting only real
      // accounts would make a lockout answer "is this a customer here?".
      await this.loginAttempts.recordFailure('portal', dto.email);
      throw new AuthenticationError('Invalid email or password.');
    }
    await this.loginAttempts.recordSuccess('portal', dto.email);

    // Checked only after the password matches, so a suspended-account message
    // never leaks whether credentials were valid.
    if (user.status === 'suspended') {
      throw new AuthorizationError('Your account has been suspended. Please contact support.');
    }

    /*
     * An UNVERIFIED address cannot hold a session.
     *
     * This check was missing outright: `register` sets `emailVerified: false`
     * and mails a link, `verifyEmail` is the only writer that sets it true, and
     * login never read the column — so the link was decorative. Anyone could
     * register an address they do not control, skip the email, and sign in.
     *
     * On THIS system that account then submits KYC documents and opens wallets,
     * while every later "we emailed the account holder" — a password reset, a
     * withdrawal OTP — goes to a mailbox nobody proved they own. The address is
     * the recovery channel for the whole account, so verifying it is what makes
     * every other email-based control mean anything.
     *
     * Placed AFTER the password check, like the suspension check above, for the
     * same reason: answering before it would tell an unauthenticated caller
     * which addresses are registered here.
     *
     * A distinct error type, not a generic 401, because the portal has to tell
     * these apart — "wrong password" and "check your inbox" are different
     * screens, and only the second one gets a resend button. `EmailNotVerified-
     * Error` already exists and already maps to 403 EMAIL_NOT_VERIFIED.
     */
    if (!user.emailVerified) {
      throw new EmailNotVerifiedError(
        'Please verify your email address before signing in. Check your inbox for the ' +
          'verification link we sent when you registered.',
      );
    }

    const familyId = randomUUID();
    const tokens = this.generateTokens(user, familyId);
    await this.refreshTokens.record({
      surface: 'portal',
      subjectId: user.id,
      familyId,
      jti: tokens.jti,
      token: tokens.refreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      device,
    });

    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken, user.id);

    /*
     * The tokens are NOT in the body, deliberately.
     *
     * They live in httpOnly cookies set on this response (R-3.2), and returning
     * them would hand JavaScript the very credential the cookie flag exists to
     * keep away from it — where it lands in browser memory, the network tab,
     * proxy logs and any error-reporting tool the page loads.
     *
     * It also had a concrete consequence: after the cookies became httpOnly, a
     * portal still running the old build kept reading these fields and writing
     * its own JS-readable `access_token` cookie from them. Clearing the browser
     * and logging in again reproduced it every time. Removing the fields makes
     * that impossible rather than merely discouraged.
     */
    return {
      user: this.sanitize(user),
      emailVerified: user.emailVerified,
    };
  }

  // ─── Refresh ──────────────────────────────────────────────────────────────────
  async refreshFromToken(providedRefreshToken: string, res: Response, device?: DeviceFingerprint) {
    /*
     * Every failure below is `SESSION_REVOKED` rather than a bare
     * `UNAUTHENTICATED`, and they are deliberately NOT distinguished from one
     * another: no refresh cookie, a bad signature and a thirty-day expiry all
     * mean the same thing to a client — this session cannot be renewed, sign in
     * again — and telling an unauthenticated caller WHICH of those it hit is a
     * free tutorial on the ones it passed.
     *
     * The distinction that matters is with `TOKEN_EXPIRED`, which the guards
     * answer for a merely stale ACCESS token and which means "renew, do not sign
     * the user out".
     */
    if (!providedRefreshToken) throw new SessionRevokedError('No refresh token provided.');

    let userId: string;
    let jti: string | undefined;
    try {
      const decoded = this.jwt.verify<{ sub: string; jti?: string; typ?: string }>(
        providedRefreshToken,
        {
          secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
          audience: TOKEN_AUDIENCE.portal,
          issuer: TOKEN_ISSUER,
          // Stated, never inherited from the key type — see token-audience.ts.
          algorithms: TOKEN_ALGORITHMS,
          clockTolerance: TOKEN_CLOCK_TOLERANCE_SECONDS,
        },
      );
      // Belt and braces: the separate refresh secret already makes an access
      // token fail here, but that protection is one env-var typo from gone.
      if (!isTokenKind(decoded, TOKEN_KIND.refresh)) {
        throw new SessionRevokedError('Invalid or expired refresh token.');
      }
      userId = decoded.sub;
      jti = decoded.jti;
    } catch {
      throw new SessionRevokedError('Invalid or expired refresh token.');
    }

    // No fallback: an unknown subject is a failed authentication. The previous
    // fallback to the seeded demo client turned any signed token into that
    // account's session.
    const user = await this.users.findById(userId);
    if (!user) throw new SessionRevokedError('User account not found.');

    // A token with no `jti` predates R-3.3 and has no row to judge. Refusing it
    // logs those sessions out once, which is the correct migration cost for a
    // credential that cannot be checked for replay.
    if (!jti) {
      throw new SessionRevokedError('Session has been revoked. Please log in again.');
    }

    /*
     * The token's own row decides — R-3.3.
     *
     * This replaces comparing against a single stored hash, which could express
     * "matches" or "does not match" and nothing else. A replayed token simply
     * failed to match, so an attacker holding a stolen token used the newer one
     * they had also captured, and nothing recorded that anything had leaked.
     */
    const verdict = await this.refreshTokens.verify({
      surface: 'portal',
      jti,
      token: providedRefreshToken,
    });

    if (verdict.outcome === 'reused') {
      // verify() has already revoked the family. The legitimate user and the
      // attacker get the same message, because which one this is, is exactly
      // what we cannot tell.
      throw new SessionReplayedError(
        'This session has been ended for security reasons. Please log in again.',
      );
    }
    if (verdict.outcome !== 'ok' && verdict.outcome !== 'retried') {
      throw new SessionRevokedError('Session has been revoked. Please log in again.');
    }

    if (user.status === 'suspended') {
      // Belt and braces: suspension also revokes every family, but a token
      // minted before that must not survive on this path either.
      await this.refreshTokens.revokeAllForSubject('portal', user.id);
      throw new SessionRevokedError('Your account has been suspended.');
    }

    /*
     * Which row this rotation consumes.
     *
     * Normally the token that was presented. On a `retried` verdict the
     * presented token was already consumed by a rotation whose response never
     * reached the client, so we consume its SUCCESSOR instead — the replacement
     * nobody ever received — and hand out a fresh pair. See `verify()` for why
     * that is a retry rather than theft.
     */
    const jtiToRotate = verdict.outcome === 'retried' ? verdict.successorJti : jti;

    // The SAME family — rotation continues one login rather than starting one,
    // so the new access token must carry the id the old one did or revoking that
    // session would stop reaching it after the next refresh.
    const tokens = this.generateTokens(user, verdict.familyId);
    const rotated = await this.refreshTokens.rotate({
      surface: 'portal',
      jti: jtiToRotate,
      familyId: verdict.familyId,
      subjectId: user.id,
      jtiNext: tokens.jti,
      nextToken: tokens.refreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      /*
       * Re-captured on EVERY rotation, not just at login.
       *
       * The portal refreshes about every ten minutes for thirty days, so a
       * fingerprint written only on the login row would make the session list
       * report where the client signed in a month ago. "Last active an hour
       * ago from an address you do not recognise" is the entire signal this
       * feature exists to surface, and it only exists if this is here.
       */
      device,
    });
    /*
     * Lost a race with a concurrent refresh using the same token. Handing out a
     * second live session is exactly what the conditional update prevents.
     *
     * **The session is alive** — the winner rotated it, and the winner's cookies
     * are already in this browser's jar, because two tabs share one. So this is
     * `SESSION_SUPERSEDED`, not `SESSION_REVOKED`: the client should retry and
     * will succeed. Answering "revoked" here is how two tabs waking together
     * ejected one of them from a perfectly good thirty-day session.
     */
    if (!rotated) {
      throw new SessionSupersededError(
        'This session was renewed by another request. Please retry.',
      );
    }

    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken, user.id);

    return {
      user: this.sanitize(user),
    };
  }

  // ─── Logout ───────────────────────────────────────────────────────────────────
  /**
   * Ends the session, and WORKS WHEN THE ACCESS TOKEN HAS ALREADY EXPIRED.
   *
   * It did not: behind `JwtAuthGuard`, a fifteen-minute-old access token meant
   * 401 and no cookies cleared, leaving the client holding a live thirty-day
   * refresh cookie with no server-side way to drop it. A phone backgrounded over
   * lunch reproduces it every time.
   *
   * Identity comes from the fully-verified REFRESH cookie — the one that is
   * still there in exactly that case — and the cookies are cleared whether or
   * not anything verifies, because clearing a cookie is not a privileged act.
   * Origin validation still runs (`@NoCsrf` waives the token, not the origin
   * check), so no cross-site page can use this to sign a client out.
   *
   * The admin surface carries the identical fix; the two are deliberately the
   * same shape.
   */
  async logoutFromRequest(req: Request, res: Response) {
    const userId = this.subjectFromRefreshCookie(req);
    if (userId) return this.logout(userId, res);

    this.clearAuthCookies(res);
    return { message: 'Logged out successfully.' };
  }

  /**
   * The user a refresh cookie belongs to, or null if it proves nothing.
   *
   * Verified in full rather than decoded: an unverified `sub` would let anyone
   * end anyone else's sessions by writing their own cookie.
   */
  private subjectFromRefreshCookie(req: Request): string | null {
    const token = readSessionCookie(
      req.cookies as Record<string, string | undefined> | undefined,
      COOKIE_BASES.clientRefresh,
    );
    if (!token) return null;
    try {
      const decoded = this.jwt.verify<{ sub: string; typ?: string }>(token, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        audience: TOKEN_AUDIENCE.portal,
        issuer: TOKEN_ISSUER,
        algorithms: TOKEN_ALGORITHMS,
        clockTolerance: TOKEN_CLOCK_TOLERANCE_SECONDS,
      });
      return isTokenKind(decoded, TOKEN_KIND.refresh) ? decoded.sub : null;
    } catch {
      return null;
    }
  }

  async logout(userId: string, res: Response) {
    // Revokes EVERY family for this user, not just the one presenting a token:
    // logging out on one device must not leave the others live (R-3.3).
    await this.refreshTokens.revokeAllForSubject('portal', userId);
    this.clearAuthCookies(res);
    return { message: 'Logged out successfully.' };
  }

  /**
   * Removes every session cookie this app has ever set.
   *
   * Extracted so `logoutFromRequest` can clear them for a caller it could not
   * identify — the case that used to answer 401 and leave a live refresh cookie
   * in the browser.
   */
  private clearAuthCookies(res: Response): void {
    clearSessionCookie(res, sessionCookieNames.clientAccess());
    clearSessionCookie(res, sessionCookieNames.clientRefresh());
    clearSessionCookie(res, sessionCookieNames.portalCsrf());
    clearLegacySessionCookies(res);
  }

  // ─── Me ───────────────────────────────────────────────────────────────────────
  me(user: User) {
    return this.sanitize(user);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  private generateTokens(user: User, familyId: string) {
    const payload = {
      sub: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      type: user.type,
      /*
       * Which login this token belongs to.
       *
       * Without it the access token is anonymous as to session, so revoking a
       * session could only kill the refresh family and the access token went on
       * working for up to fifteen minutes. `JwtStrategy` checks this against
       * `familyIsRevoked` on every request, which is what makes "sign out that
       * device" and "changing my password ends other sessions" true NOW rather
       * than at the next rotation.
       *
       * Minted here rather than inside `record()` because the token has to
       * carry the id, so it must exist before anything is signed.
       */
      fam: familyId,
    };

    // aud/iss so a portal token cannot verify on the admin surface even if the
    // two ever end up sharing a secret (R-3.1). The algorithm is named on the
    // way out as well as the way in, so signing and verification cannot drift.
    const claims = {
      audience: TOKEN_AUDIENCE.portal,
      issuer: TOKEN_ISSUER,
      algorithm: TOKEN_ALGORITHM,
    };
    const accessToken = this.jwt.sign(
      { ...payload, typ: TOKEN_KIND.access },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: '15m',
        ...claims,
      },
    );

    // The refresh token carries a `jti` naming its row in refresh_tokens, which
    // is how a presented token finds out whether it has already been rotated
    // (R-3.3).
    const jti = randomUUID();
    const refreshToken = this.jwt.sign(
      { sub: user.id, jti, typ: TOKEN_KIND.refresh },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: '30d',
        ...claims,
      },
    );

    return { accessToken, refreshToken, jti, familyId };
  }

  /**
   * Sets the session pair plus the anti-forgery token.
   *
   * Names and attributes come from common/security/session-cookies.ts, which
   * explains why `__Host-` and app-unique names matter when many OxShare sites
   * share one registrable domain (PLATFORM-CONVENTIONS §3.0). These cookies were
   * previously httpOnly:false so the portal could read them for a Bearer header;
   * that header was never what authenticated the request, and it put a 30-day
   * refresh token within reach of any script on the origin.
   */
  private setAuthCookies(res: Response, accessToken: string, refreshToken: string, userId: string) {
    // Delete every superseded name first. Those cookies were httpOnly:false and
    // hold real JWTs, so a browser from the old build carries a JS-readable
    // session for up to 30 more days unless we actively remove it here.
    clearLegacySessionCookies(res);
    res.cookie(sessionCookieNames.clientAccess(), accessToken, sessionCookieOptions(ACCESS_TTL_MS));
    res.cookie(
      sessionCookieNames.clientRefresh(),
      refreshToken,
      sessionCookieOptions(REFRESH_TTL_MS),
    );
    res.cookie(
      sessionCookieNames.portalCsrf(),
      this.csrf.issue(userId),
      csrfCookieOptions(CsrfService.TTL_MS),
    );
  }

  /**
   * The user, as the client may see them.
   *
   * An ALLOW-LIST, not a deny-list, and that is the whole point. This used to
   * destructure four secrets out and return the rest — so when password reset
   * added `password_reset_token_hash` and `password_reset_expiry`, both started
   * leaking on login, refresh AND me, and nothing anywhere noticed. A deny-list
   * silently exposes every column added after it was written.
   *
   * The reset hash is stored hashed precisely so a database leak does not yield
   * working reset links (R-3.5); returning it over the API gave that away to
   * anything reading the response — an XSS, a logging proxy, an error reporter.
   *
   * Adding a field here has to be a deliberate act. Forgetting to is now the
   * safe direction.
   */
  private sanitize(user: User) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      type: user.type,
      status: user.status,
      verificationLevel: user.verificationLevel,
      emailVerified: user.emailVerified,
      country: user.country,
      phone: user.phone,
      createdAt: user.createdAt,
      /*
       * A URL, composed here, from a FILENAME stored in the column.
       *
       * The column holds `<uuid>.png` because a URL is a function of how the
       * API is deployed, and §8.5's move to private S3 changes how the bytes
       * are served. Composing at read time means that migration touches this
       * line rather than every row.
       *
       * Null when there is no photo, never a placeholder or a gravatar: the
       * portal renders initials, and an invented image URL would be a request
       * to a third party that leaks the client's e-mail hash.
       */
      avatarUrl: user.avatarFilename ? `/uploads/avatars/${user.avatarFilename}` : null,
    };
  }

  /**
   * Set the client's profile photo.
   *
   * The bytes are validated and written BEFORE the row is updated, so a
   * rejected upload leaves nothing behind and a failed write cannot leave the
   * column pointing at a file that does not exist.
   *
   * The previous photo is deleted after the row is updated, in that order: if
   * the delete fails the client has a working new avatar and one orphaned file,
   * which is a cleanup job. Deleting first and then failing to update would
   * leave a row pointing at bytes that are gone, which is a broken image on
   * every screen the client visits.
   */
  async setAvatar(userId: string, buffer: Buffer, declaredMime: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthenticationError('Your session is no longer valid. Please sign in.');

    const stored = await this.files.write(AVATAR_BUCKET, buffer, declaredMime);
    const previous = user.avatarFilename;

    await this.users.update(userId, { avatarFilename: stored.filename });
    await this.files.remove(AVATAR_BUCKET, previous);

    this.logger.log(`Avatar updated for ${user.email} (${stored.mimeType}, ${stored.size} bytes)`);
    return { avatarUrl: `/uploads/avatars/${stored.filename}` };
  }

  /**
   * Remove it, and go back to initials.
   *
   * The row is cleared first here, which is the opposite order from `setAvatar`
   * and correct for the same reason: the failure that matters is a row pointing
   * at bytes that are gone. Clearing first means a failed delete leaves an
   * orphaned file and a correct row.
   */
  async removeAvatar(userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthenticationError('Your session is no longer valid. Please sign in.');

    // `undefined` is how this store clears a column - see the loop in
    // users.store.update, which maps it to SQL NULL.
    await this.users.update(userId, { avatarFilename: undefined });
    await this.files.remove(AVATAR_BUCKET, user.avatarFilename);

    return { avatarUrl: null };
  }

  async findUserById(id: string): Promise<User | undefined> {
    return await this.users.findById(id);
  }

  // ─── Password change, and the sessions behind it ─────────────────────────────

  /**
   * Change a password from INSIDE a session — FR-CORE-09's other half.
   *
   * The portal had no way to do this. `resetPassword` above is not it: that
   * consumes an e-mailed single-use token and exists for people who cannot sign
   * in. Pointing a signed-in client at it means mailing them a link to prove an
   * identity they have already proved, and it revokes every session including
   * the one they are sitting in.
   *
   * Three things make this safe, and each is here for its own reason:
   *
   *  1. The CURRENT password is required. Without it, any XSS or borrowed
   *     unlocked laptop is a permanent account takeover in one request — this
   *     endpoint would hand over the credential that outlives every cookie.
   *
   *  2. `verify()` runs against the stored hash through PasswordService, which
   *     equalises timing for a missing hash. A user always exists here, so that
   *     matters less than at login, but the shared path is the point: a future
   *     caller inherits the property rather than reimplementing it.
   *
   *  3. Every OTHER session dies. A password change is how someone responds to
   *     "I think somebody is in my account", and it means nothing if the
   *     attacker's thirty-day refresh token keeps working. The caller's own
   *     session survives, because signing someone out for doing the right thing
   *     teaches them not to.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    res: Response,
    device?: DeviceFingerprint,
  ) {
    const user = await this.users.findById(userId);
    // The guard already resolved this user, so absence means the account was
    // deleted between the guard and here. Treated as an auth failure, not a 404.
    if (!user) throw new AuthenticationError('Your session is no longer valid. Please sign in.');

    const { valid } = await this.passwords.verify(currentPassword, user.passwordHash);
    if (!valid) {
      this.logger.warn(`Password change refused for ${user.email}: current password did not match`);
      throw new ValidationError('Your current password is not correct.');
    }

    /*
     * Refused rather than silently accepted.
     *
     * "Change" that changes nothing leaves the client believing they have
     * rotated a credential they may have just told somebody, and it revokes
     * their other sessions for no gain. Compared against the stored hash rather
     * than against the submitted string, so it also catches the case where the
     * two fields were filled from a password manager.
     */
    const { valid: unchanged } = await this.passwords.verify(newPassword, user.passwordHash);
    if (unchanged) {
      throw new ValidationError('Your new password must be different from your current one.');
    }

    await this.users.update(user.id, {
      passwordHash: await this.passwords.hash(newPassword),
      /*
       * The cutoff that makes "every other session is signed out" true NOW.
       *
       * Without it, revoking the refresh families only stops those sessions
       * RENEWING - each keeps working on its already-issued access token for up
       * to fifteen more minutes. Measured, not assumed: before this line, a
       * second device kept answering 200 on /auth/me straight after the change.
       *
       * Fifteen minutes of continued access is precisely what somebody
       * changing their password under duress is trying to prevent.
       */
      passwordChangedAt: new Date(),
      // A pending reset link is a live second key to the account. Someone
      // changing their password because they fear compromise must not leave one
      // sitting in an inbox the attacker may also hold.
      passwordResetTokenHash: undefined,
      passwordResetExpiry: undefined,
    });

    /*
     * EVERY family, including the caller's own, and then a brand new session
     * for them.
     *
     * The first cut kept the caller's family alive and revoked the rest. That
     * was not enough once `passwordChangedAt` started invalidating outstanding
     * ACCESS tokens: the cutoff does not know whose token it is looking at, so
     * it signed the caller out of the device they had just proved their old
     * password on. Measured, not assumed - /auth/me answered 401 for the owner
     * immediately after a successful change.
     *
     * Trying to exempt the caller from the cutoff would mean the cutoff had an
     * exception, and an exception is a hole: any token the check waves through
     * is a token an attacker might be holding. So the cutoff stays absolute and
     * the caller is re-issued instead. They keep working because they are given
     * something NEW, not because something old was spared.
     */
    const revoked = await this.refreshTokens.revokeAllForSubject('portal', user.id);

    const familyId = randomUUID();
    const tokens = this.generateTokens(user, familyId);
    await this.refreshTokens.record({
      surface: 'portal',
      subjectId: user.id,
      familyId,
      jti: tokens.jti,
      token: tokens.refreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      device,
    });
    // The rotated cookies ride back on this response and the browser installs
    // them, exactly as at login. The portal reads no token from the body.
    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken, user.id);

    // `revoked` counts the caller's old family too, so the number reported to
    // them is one less than the rows touched. Saying "3 other sessions" when
    // they had 3 other devices is the number they can check against reality.
    const others = Math.max(0, revoked - 1);
    this.logger.log(
      `Password changed for ${user.email}; all ${revoked} session(s) revoked, caller re-issued`,
    );

    return {
      message:
        others > 0
          ? `Your password has been updated. ${others} other session(s) were signed out.`
          : 'Your password has been updated.',
    };
  }

  /**
   * Which family a refresh-token `jti` belongs to.
   *
   * A thin pass-through so the controller does not reach into
   * `RefreshTokensService` directly. Everything the controller needs about
   * sessions arrives through this service, which is what keeps the token table
   * an implementation detail of it rather than a shared dependency.
   */
  familyIdForJti(jti: string): Promise<string | null> {
    return this.refreshTokens.familyIdForJti('portal', jti);
  }

  /**
   * The client's own live sessions, with the one they are using marked.
   *
   * `currentFamilyId` is resolved from the REFRESH cookie rather than the access
   * token, because the access token carries no family. Getting it wrong only
   * mislabels a row — see `familyIdForJti` — but getting it right is what lets
   * the UI stop someone revoking the session they are sitting in by accident.
   */
  async listSessions(userId: string, currentFamilyId: string | null) {
    const sessions = await this.refreshTokens.listSessions('portal', userId);
    return sessions.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      lastActiveAt: s.lastActiveAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      userAgent: s.userAgent,
      ip: s.ip,
      current: s.id === currentFamilyId,
    }));
  }

  /**
   * Ends one session by family id.
   *
   * Ownership is enforced inside the UPDATE (see `revokeFamilyForSubject`), so
   * a family belonging to somebody else matches nothing. That is reported as a
   * 404 rather than a 403 on purpose: telling a caller "that session exists but
   * is not yours" confirms the existence of another account's session id.
   */
  async revokeSession(userId: string, familyId: string, currentFamilyId: string | null) {
    /*
     * Revoking your CURRENT session through this endpoint is refused, and
     * pointed at logout instead.
     *
     * It would otherwise half-work: the family dies, the httpOnly cookies stay
     * in the browser, and the client sits on a rendered portal where the next
     * request 401s. Logout is the operation that both revokes and clears the
     * cookies, and it is one click away in the same menu.
     */
    if (currentFamilyId && familyId === currentFamilyId) {
      throw new ValidationError('That is the session you are using now. Use Log out to end it.');
    }

    const revoked = await this.refreshTokens.revokeFamilyForSubject('portal', userId, familyId);
    if (revoked === 0) throw new NotFoundError('That session no longer exists.');

    this.logger.log(`Session ${familyId} revoked by its owner (${revoked} token(s))`);
    return { message: 'That session has been signed out.' };
  }
}
