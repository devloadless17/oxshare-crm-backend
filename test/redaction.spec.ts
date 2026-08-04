import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactSecretsInText } from '../src/common/logging/redact';

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
