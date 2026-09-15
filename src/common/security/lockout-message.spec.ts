import { describe, expect, it } from 'vitest';
import { lockoutMessage } from './lockout-message';

/**
 * The account-lockout copy.
 *
 * Pinned for the same reason as `rateLimitMessage`: this and the throttle notice
 * are the two errors ordinary clients actually meet, they land in the same red
 * box on the same sign-in form, and they have to read like they were written by
 * the same person.
 *
 * The case that prompted it: a client whose password was CORRECT saw
 * "Try again in 8 minute(s)" and concluded their password was wrong. The lockout
 * was doing its job; the sentence was doing half of its.
 */
describe('the lockout message', () => {
  it('never shows the programmer plural', () => {
    for (const ms of [1_000, 40_000, 60_000, 480_000]) {
      expect(lockoutMessage(ms)).not.toContain('(s)');
    }
  });

  /**
   * A 40-second wait rounded up to "1 minute(s)" both misread and overstated:
   * somebody who waits the minute they were told to wait was let in at 40
   * seconds and did not know.
   */
  it('counts in seconds under a minute rather than rounding up to one', () => {
    expect(lockoutMessage(40_000)).toBe(
      'Too many failed sign-in attempts. Please try again in 40 seconds.',
    );
  });

  it('counts in minutes above a minute', () => {
    expect(lockoutMessage(480_000)).toBe(
      'Too many failed sign-in attempts. Please try again in 8 minutes.',
    );
  });

  it.each([
    [1_000, '1 second'],
    [60_000, '1 minute'],
    [61_000, '2 minutes'],
  ])('%dms reads as "%s"', (ms, expected) => {
    expect(lockoutMessage(ms)).toContain(expected);
    expect(lockoutMessage(ms)).not.toMatch(/1 seconds|1 minutes/);
  });
});
