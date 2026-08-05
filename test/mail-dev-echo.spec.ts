import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../src/modules/email/email.service';
import { validateEnv } from '../src/config/env.validation';

/**
 * The development-only outlet for emailed credentials.
 *
 * Links and one-time codes are deliberately not logged (R-6.3): read access to a
 * log store was once enough to mint an admin, because an invite link IS an admin
 * account waiting to be claimed. Removing that logging was right — and it left
 * anyone without a working SMTP server unable to test registration, invites or
 * withdrawal OTP at all, because the mail goes to a mailbox that does not exist.
 *
 * `MAIL_DEV_ECHO` is the narrow way back in. What matters is that it stays
 * narrow, so this file pins BOTH directions: that it prints when a developer
 * asks for it, and that it cannot be carried into production by a copied .env.
 */

function emailServiceWith(env: Record<string, string | undefined>) {
  const config = {
    get: <T>(key: string, fallback?: T) => (env[key] as unknown as T) ?? fallback,
  } as unknown as ConfigService;
  return new EmailService(config);
}

/**
 * The lines the service actually wrote, via the Nest logger.
 *
 * Spying on `Logger.prototype` rather than on the instance: the service builds
 * its own `new Logger(EmailService.name)` privately, so there is nothing on the
 * outside to substitute.
 */
function captureWarnings() {
  const lines: string[] = [];
  const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

const BASE_ENV = {
  NODE_ENV: 'development',
  PORTAL_URL: 'http://localhost:3000',
  SMTP_HOST: 'smtp.example.com',
};

beforeEach(() => vi.restoreAllMocks());

describe('when a developer asks for it', () => {
  it('prints the verification link, which is otherwise unobtainable', async () => {
    const { lines, restore } = captureWarnings();
    const service = emailServiceWith({ ...BASE_ENV, MAIL_DEV_ECHO: 'true' });

    await service.sendVerificationEmail('kay@example.com', 'the-token-value');
    restore();

    const echoed = lines.join('\n');
    expect(echoed).toContain('MAIL_DEV_ECHO');
    expect(echoed).toContain('the-token-value');
    expect(echoed).toContain('kay@example.com');
  });

  it('prints the withdrawal OTP', async () => {
    const { lines, restore } = captureWarnings();
    const service = emailServiceWith({ ...BASE_ENV, MAIL_DEV_ECHO: 'true' });

    await service.sendWithdrawalOtpEmail('kay@example.com', '250.00000000', 'USD', '482913');
    restore();

    expect(lines.join('\n')).toContain('482913');
  });

  it('prints the admin invite link — the one that creates an account', async () => {
    const { lines, restore } = captureWarnings();
    const service = emailServiceWith({ ...BASE_ENV, MAIL_DEV_ECHO: 'true' });

    await service.sendAdminInviteEmail(
      'new@example.com',
      'New',
      'http://x/invite/accept?token=abc',
    );
    restore();

    expect(lines.join('\n')).toContain('token=abc');
  });
});

describe('when nobody asked', () => {
  it('prints NOTHING without the flag — the default stays silent', async () => {
    // The behaviour R-6.3 established. A credential must not reach a log because
    // someone forgot to turn something off.
    const { lines, restore } = captureWarnings();
    const service = emailServiceWith(BASE_ENV);

    await service.sendVerificationEmail('kay@example.com', 'the-token-value');
    await service.sendWithdrawalOtpEmail('kay@example.com', '1.00', 'USD', '482913');
    restore();

    expect(lines.join('\n')).not.toContain('the-token-value');
    expect(lines.join('\n')).not.toContain('482913');
  });

  it('prints nothing when the flag is any value other than true', async () => {
    const { lines, restore } = captureWarnings();
    const service = emailServiceWith({ ...BASE_ENV, MAIL_DEV_ECHO: 'false' });

    await service.sendVerificationEmail('kay@example.com', 'the-token-value');
    restore();

    expect(lines.join('\n')).not.toContain('the-token-value');
  });
});

describe('it cannot reach production', () => {
  const prodEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/x',
    ADMIN_JWT_SECRET: 'a'.repeat(40),
    ADMIN_JWT_REFRESH_SECRET: 'b'.repeat(40),
    JWT_ACCESS_SECRET: 'c'.repeat(40),
    JWT_REFRESH_SECRET: 'd'.repeat(40),
    MT5_BRIDGE_SECRET: 'e'.repeat(40),
    REDIS_URL: 'redis://localhost:6379',
    PORTAL_URL: 'https://portal.example.com',
    ADMIN_URL: 'https://admin.example.com',
    // PROD_REQUIRED demands real mail config in production; without these the
    // completeness check fires first and this file would be testing that instead.
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'mailer',
    SMTP_PASS: 'mailer-password',
    SMTP_FROM: '"OxShare" <no-reply@oxshare.com>',
    // Also required in production — the allowlist, rate limiter and audit trail
    // all read the client IP through it (D-13b).
    TRUSTED_PROXY_HOPS: '0',
  };

  it('REFUSES TO BOOT rather than silently ignoring the flag', () => {
    // Silently disabling would be friendlier and wrong: whoever set it believes
    // they are seeing those values, and a deploy carrying a copied .env should
    // be told loudly at boot, not by the feature mysteriously not working.
    expect(() => validateEnv({ ...prodEnv, MAIL_DEV_ECHO: 'true' })).toThrow(/MAIL_DEV_ECHO/);
  });

  it('names WHY in the refusal, not just the variable', () => {
    // The person reading a failed deploy needs to know an invite link mints an
    // admin — otherwise the obvious fix is to make the check go away.
    expect(() => validateEnv({ ...prodEnv, MAIL_DEV_ECHO: 'true' })).toThrow(/bearer credential/i);
  });

  it('starts normally in production without it', () => {
    expect(() => validateEnv(prodEnv)).not.toThrow();
  });

  it('starts normally in production with it explicitly false', () => {
    expect(() => validateEnv({ ...prodEnv, MAIL_DEV_ECHO: 'false' })).not.toThrow();
  });
});
