import { describe, expect, it } from 'vitest';
import type { Logger } from '@nestjs/common';
import { REDACTED, redact, redactSecretsInText, safeLogPath } from '../src/common/logging/redact';
import { ALERT_KINDS, ALERT_THRESHOLDS, raiseAlert } from '../src/common/logging/alerts';

/**
 * PLATFORM-CONVENTIONS R-6.3 — the never-log list, enforced at the sink.
 *
 * It was a list: a rule that held only while everyone remembered it on every
 * logging call, forever. One `logger.log(dto)` on a KYC submission puts a
 * passport number into the log store permanently, including whatever aggregator
 * or error tracker it ships to. No review catches that reliably, so it is
 * enforced where the data actually leaves.
 */
describe('R-6.3 log redaction', () => {
  it('removes credentials whatever they are called', () => {
    const output = redact({
      password: 'hunter2',
      passwordHash: '$argon2id$v=19$...',
      accessToken: 'eyJhbGciOi.abc.def',
      refresh_token: 'r-123',
      Authorization: 'Bearer abc',
      'X-OxShare-CSRF': 'nonce.sig',
      apiKey: 'k-live-123',
      otp: '123456',
    }) as Record<string, unknown>;

    for (const value of Object.values(output)) {
      expect(value).toBe(REDACTED);
    }
  });

  it('removes the identity data KYC review handles', () => {
    const output = redact({
      documentNumber: 'X1234567',
      dateOfBirth: '1990-04-12',
      address: '12 Somewhere St',
      phone: '+971501234567',
      iban: 'AE07 0331 2345 6789 0123 456',
    }) as Record<string, unknown>;

    for (const value of Object.values(output)) {
      expect(value).toBe(REDACTED);
    }
  });

  it('keeps everything a log is actually for', () => {
    // Over-redacting until a log is useless is its own failure: people then
    // reach past the logger to console.log, and the rule stops applying at all.
    const output = redact({
      userId: 'u-1',
      email: 'client@oxshare.com',
      amount: '250.00000000',
      currency: 'USD',
      state: 'pending',
    }) as Record<string, unknown>;

    expect(output).toEqual({
      userId: 'u-1',
      email: 'client@oxshare.com',
      amount: '250.00000000',
      currency: 'USD',
      state: 'pending',
    });
  });

  it('reaches nested objects and arrays', () => {
    const output = redact({
      user: { id: 'u-1', profile: { password: 'x', country: 'AE' } },
      sessions: [{ token: 'a' }, { token: 'b' }],
    }) as { user: { profile: Record<string, unknown> }; sessions: Record<string, unknown>[] };

    expect(output.user.profile.password).toBe(REDACTED);
    expect(output.user.profile.country).toBe('AE');
    expect(output.sessions.map((s) => s.token)).toEqual([REDACTED, REDACTED]);
  });

  it('does not mutate the object it was given', () => {
    // This runs on live domain objects on their way past. A logger that blanked
    // a field on the object it was handed would be a spectacular bug source.
    const original = { password: 'hunter2', id: 'u-1' };
    redact(original);
    expect(original.password).toBe('hunter2');
  });

  it('keeps an Error readable instead of serialising it to {}', () => {
    const output = redact(new Error('boom')) as Record<string, unknown>;
    expect(output.message).toBe('boom');
    expect(output.stack).toBeTypeOf('string');
  });

  it('survives a cycle rather than throwing inside the logger', () => {
    const cyclic: Record<string, unknown> = { id: 'a' };
    cyclic.self = cyclic;
    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
  });

  it('catches a JWT interpolated into a plain string', () => {
    // The common shape: `logger.log(\`token: ${token}\`)`. Field-name redaction
    // cannot see inside a string, so the text pass has to.
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactSecretsInText(`refresh failed for ${jwt}`)).toBe(`refresh failed for ${REDACTED}`);
  });

  it('catches a long hex signature or hash', () => {
    const signature = 'a'.repeat(64);
    expect(redactSecretsInText(`signature ${signature} rejected`)).toBe(
      `signature ${REDACTED} rejected`,
    );
  });

  it('leaves ordinary prose and short ids alone', () => {
    const message = 'Withdrawal w-42 approved by admin 6d7a2682 for 250.00 USD';
    expect(redactSecretsInText(message)).toBe(message);
  });
});

describe('§12.3 alert signals', () => {
  /*
   * ARCHITECTURE §9 says to set up alerting "before go-live, not after", and
   * nothing existed. Choosing a paging provider is not an engineering decision,
   * so this does the part that IS ours: make the signal unambiguous and
   * machine-detectable, so wiring a provider later is a log-drain filter rather
   * than archaeology.
   */
  it('emits one line carrying alert:true, a kind and a severity', () => {
    const emitted: unknown[] = [];
    const logger = { error: (payload: unknown) => emitted.push(payload) } as unknown as Logger;

    raiseAlert(logger, ALERT_KINDS.RECONCILIATION_MISMATCH, 'page', 'wallet w-1 disagrees', {
      walletId: 'w-1',
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      alert: true,
      kind: 'reconciliation.mismatch',
      severity: 'page',
      context: { walletId: 'w-1' },
    });
  });

  it('logs at error for BOTH severities', () => {
    // A `page` buried at warn level is one filter mistake away from silence.
    const levels: string[] = [];
    const logger = {
      error: () => levels.push('error'),
      warn: () => levels.push('warn'),
      log: () => levels.push('log'),
    } as unknown as Logger;

    raiseAlert(logger, ALERT_KINDS.REFRESH_TOKEN_REUSE, 'page', 'replayed');
    raiseAlert(logger, ALERT_KINDS.WEBHOOK_SIGNATURE_FAILURE, 'notify', 'bad signature');

    expect(levels).toEqual(['error', 'error']);
  });

  it('gives every kind a written threshold, so no alert routes on folklore', () => {
    for (const kind of Object.values(ALERT_KINDS)) {
      const threshold = ALERT_THRESHOLDS[kind];
      expect(threshold, `${kind} has no threshold`).toBeDefined();
      // A real sentence, not a placeholder — the rule is the decision.
      expect(threshold.rule.length).toBeGreaterThan(40);
      expect(['page', 'notify']).toContain(threshold.severity);
    }
  });

  it('pages for anything that means money is wrong', () => {
    // The judgement of what is worth a phone call belongs with the code that
    // knows what the event means, not with whoever configures the drain.
    for (const kind of [
      ALERT_KINDS.RECONCILIATION_MISMATCH,
      ALERT_KINDS.UNPAID_CONFIRMED_ACCRUAL,
      ALERT_KINDS.COMMISSION_CEILING_BREACH,
      ALERT_KINDS.REFRESH_TOKEN_REUSE,
    ]) {
      expect(ALERT_THRESHOLDS[kind].severity).toBe('page');
    }
  });

  it('redacts an alert payload like anything else', () => {
    // Alerts are logged, so they are subject to R-6.3. Nothing should ever put a
    // token in `context`, but the sink must not depend on that being remembered.
    const output = redact({
      alert: true,
      kind: ALERT_KINDS.REFRESH_TOKEN_REUSE,
      context: { subjectId: 'u-1', token: 'leaked' },
    }) as { context: Record<string, unknown> };

    expect(output.context.token).toBe(REDACTED);
    expect(output.context.subjectId).toBe('u-1');
  });
});

/**
 * Credentials travel in the query string on two routes in this system:
 * `GET /auth/verify-email?token=…` and the password-reset link. Every place a
 * URL was logged wrote them verbatim.
 *
 * The worst was `request-id.middleware`, which stores the path in the
 * async-local context — `JsonLogger` stamps that on EVERY line of the request,
 * so one reset wrote its token into the log repeatedly rather than once.
 *
 * A log file is a weaker boundary than the database: shipped to aggregators,
 * read by more people, retained longer, rarely encrypted at rest. A single-use
 * token sitting in one is a credential in the least protected place we have.
 */
describe('R-6.3 safe log paths', () => {
  it('redacts the value of a token in the query string', () => {
    const safe = safeLogPath('/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.secret.value');

    expect(safe).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(safe).not.toContain('secret.value');
    expect(safe).toContain('/auth/verify-email');
  });

  it('keeps the parameter NAME, so the log still says what was asked for', () => {
    // Dropping the query string wholesale trades one problem for another: the
    // next person debugging a 500 just adds the raw URL back.
    expect(safeLogPath('/auth/reset-password?token=abc123')).toContain('token=');
  });

  it('leaves ordinary parameters intact — they are what makes a 500 diagnosable', () => {
    const safe = safeLogPath('/admin/clients?page=3&status=pending&limit=25');

    expect(safe).toContain('page=3');
    expect(safe).toContain('status=pending');
    expect(safe).toContain('limit=25');
  });

  it('redacts every sensitive parameter in a mixed query, not just the first', () => {
    const safe = safeLogPath('/x?page=2&token=aaa&sort=name&apiKey=bbb&csrf=ccc');

    for (const secret of ['aaa', 'bbb', 'ccc']) {
      expect(safe, secret).not.toContain(secret);
    }
    expect(safe).toContain('page=2');
    expect(safe).toContain('sort=name');
  });

  it('uses the same field list as object redaction, so the two cannot drift', () => {
    // `token` covers accessToken/refresh_token/emailVerificationToken already;
    // a second hand-maintained list here would fall behind the first.
    expect(safeLogPath('/x?refresh_token=v')).not.toContain('v');
    expect(safeLogPath('/x?emailVerificationToken=v')).not.toContain('=v');
    expect(safeLogPath('/x?password=v')).not.toContain('=v');
  });

  it('passes a path with no query through untouched', () => {
    expect(safeLogPath('/health')).toBe('/health');
    expect(safeLogPath('/admin/clients/9f1c')).toBe('/admin/clients/9f1c');
  });

  it('does not choke on an empty or malformed query', () => {
    expect(safeLogPath('/x?')).toBe('/x');
    expect(safeLogPath('/x?=&&')).not.toContain('undefined');
  });
});
