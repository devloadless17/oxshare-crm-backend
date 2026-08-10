import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { EmailService } from '../src/modules/email/email.service';

/**
 * PLATFORM-CONVENTIONS R-6.3 — the never-log list, for the file whose whole job
 * is sending bearer credentials.
 *
 * This test exists because the leak it guards had already been "fixed" once. The
 * `console.log` was removed from `auth.service.ts` and a comment was added there
 * saying the link "is emailed and never written to stdout" — while the
 * `logger.log` in `email.service.ts` kept printing it. Both the code comment and
 * PLATFORM-CONVENTIONS R-6.3 then recorded the leak as closed for months.
 *
 * A comment cannot enforce this. The verification link, the reset link and the
 * ADMIN INVITE link are each a credential in a query string, and the invite one
 * turns into a live admin account at POST /admin/invite/accept. So the assertion
 * is deliberately blunt: capture every log line this service emits and fail if
 * any of them contains the token, on the success path or the failure path.
 *
 * Failure paths matter as much as success paths — the old code logged the URL
 * *again* in the catch block, on the theory that a developer would need it. That
 * is precisely when a real SMTP outage would dump every pending credential into
 * a log aggregator at once.
 */

const TOKEN = 'tok-1234567890-secret-value';

/** Every message passed to the Nest logger, whatever the level. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const record = (message: unknown) => {
    lines.push(String(message));
  };

  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    vi.spyOn(Logger.prototype, level).mockImplementation(record),
  );

  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

/**
 * A service whose transport always fails, so BOTH branches run.
 *
 * `NODE_ENV=test` already skips the real sendMail, so the success path is
 * exercised by the default config; the failing transport below is what drives
 * the catch blocks.
 */
function makeService(options: { failing: boolean }): EmailService {
  const config = {
    get: (key: string, fallback?: unknown) => {
      if (key === 'NODE_ENV') return options.failing ? 'development' : 'test';
      if (key === 'PORTAL_URL') return 'https://portal.example.test';
      if (key === 'ADMIN_URL') return 'https://admin.example.test';
      return fallback;
    },
  };

  /*
   * A stub resolver rather than the real one: this file is about what gets
   * LOGGED, and the service now reads its SMTP settings through
   * SmtpConfigService, which would otherwise need a database.
   */
  const smtpConfig = {
    resolve: () =>
      Promise.resolve({
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        username: null,
        password: null,
        from: '"OxShare" <no-reply@example.test>',
        source: 'environment' as const,
        fingerprint: 'stub',
      }),
  };

  const service = new EmailService(config as never, smtpConfig as never);

  if (options.failing) {
    /*
     * Seeding the private transporter cache is the point: it is the only way to
     * drive the catch blocks without a network, and those are the branches that
     * used to log the credential a second time.
     *
     * The fingerprint must match what the stub resolver returns above, because
     * `transporterFor` only reuses a cached transporter when they agree — a
     * mismatch would build a real one and try to open a socket.
     */
    (
      service as unknown as {
        cached: { fingerprint: string; transporter: { sendMail: () => Promise<never> } };
      }
    ).cached = {
      fingerprint: 'stub',
      transporter: { sendMail: () => Promise.reject(new Error('SMTP connection refused')) },
    };
  }

  return service;
}

let capture: ReturnType<typeof captureLogs>;

beforeEach(() => {
  capture = captureLogs();
});

afterEach(() => {
  capture.restore();
});

describe('R-6.3 — no email credential ever reaches a log line', () => {
  it('does not log the verification token when the mail is sent', async () => {
    await makeService({ failing: false }).sendVerificationEmail('client@test.local', TOKEN);

    expect(capture.lines.length).toBeGreaterThan(0);
    expect(capture.lines.join('\n')).not.toContain(TOKEN);
  });

  it('does not log the verification token when sending FAILS', async () => {
    await makeService({ failing: true }).sendVerificationEmail('client@test.local', TOKEN);

    const output = capture.lines.join('\n');
    expect(output).not.toContain(TOKEN);
    // The failure must still be diagnosable: who it was for, and why it failed.
    expect(output).toContain('client@test.local');
    expect(output).toContain('SMTP connection refused');
  });

  it('does not log the password-reset token, sent or failed', async () => {
    await makeService({ failing: false }).sendPasswordResetEmail('client@test.local', TOKEN);
    await makeService({ failing: true }).sendPasswordResetEmail('client@test.local', TOKEN);

    expect(capture.lines.join('\n')).not.toContain(TOKEN);
  });

  it('does not log the ADMIN INVITE url — it creates an admin account', async () => {
    const inviteUrl = `https://admin.example.test/invite/accept?token=${TOKEN}`;

    await makeService({ failing: false }).sendAdminInviteEmail('new@test.local', 'New', inviteUrl);
    await makeService({ failing: true }).sendAdminInviteEmail('new@test.local', 'New', inviteUrl);

    const output = capture.lines.join('\n');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(inviteUrl);
  });

  it('logs no URL at all from any send path', async () => {
    const service = makeService({ failing: true });
    await service.sendVerificationEmail('a@test.local', TOKEN);
    await service.sendPasswordResetEmail('b@test.local', TOKEN);
    await service.sendAdminInviteEmail('c@test.local', 'C', `https://x.test/?token=${TOKEN}`);
    await service.sendKycDecisionEmail('d@test.local', 'D', 'rejected', 'Blurry document');
    await service.sendPartnerDecisionEmail('e@test.local', 'E', 'approved', {
      referralCode: 'OX-E1',
    });
    await service.sendDepositOutcomeEmail('f@test.local', 'F', 'succeeded', '250.00000000', 'USD');
    await service.sendWithdrawalDecisionEmail(
      'g@test.local',
      'G',
      'approved',
      '100.00000000',
      'USD',
    );

    // Broader than the token check: a URL in a log line from this service is a
    // finding regardless of which parameter carries the secret.
    for (const line of capture.lines) {
      expect(line, `log line contains a URL: ${line}`).not.toMatch(/https?:\/\//);
    }
  });

  it('reports the real reason for every failed send, not a bare "failed"', async () => {
    const service = makeService({ failing: true });
    await service.sendKycDecisionEmail('d@test.local', 'D', 'approved');
    await service.sendPartnerDecisionEmail('e@test.local', 'E', 'rejected', {
      reason: 'Incomplete',
    });

    // Both used to swallow the error entirely, so "the client never got the
    // email" was indistinguishable from auth failure, DNS, or a bad recipient.
    const output = capture.lines.join('\n');
    expect(output.match(/SMTP connection refused/g)?.length).toBe(2);
  });
});
