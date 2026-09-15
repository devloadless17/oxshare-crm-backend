import { describe, expect, it } from 'vitest';
import { rateLimitMessage } from './all-exceptions.filter';

/**
 * The words a throttled user reads.
 *
 * Worth its own file because this is the error ordinary people actually meet.
 * Everything else in the filter is read by a developer looking at a log; this
 * one lands in a red box on the sign-in form, and it used to say
 * `ThrottlerException: Too Many Requests` — a framework class name shown to a
 * client trying to reach their money.
 *
 * The number is NOT invented here: ThrottlerGuard sets `Retry-After` on the
 * response before throwing, so it is authoritative. That matters more than it
 * looks — somebody told "try in 30 seconds" who is refused again at 31 concludes
 * the product is broken rather than busy, so a wrong number is worse than none.
 */
describe('the message a throttled user sees', () => {
  it('never says ThrottlerException', () => {
    expect(rateLimitMessage('43')).not.toMatch(/throttler|exception/i);
  });

  it('counts in seconds under a minute', () => {
    expect(rateLimitMessage('43')).toBe('Too many attempts. Please try again in 43 seconds.');
  });

  /** "Wait 900 seconds" is arithmetic to do while annoyed. */
  it('switches to minutes above a minute, and rounds up', () => {
    expect(rateLimitMessage('900')).toBe('Too many attempts. Please try again in 15 minutes.');
    expect(rateLimitMessage('61')).toBe('Too many attempts. Please try again in 2 minutes.');
  });

  it('says "1 minute", not "1 minutes"', () => {
    expect(rateLimitMessage('60')).toBe('Too many attempts. Please try again in 1 minute.');
  });

  /**
   * A throttle with no Retry-After is still a throttle, and the user can still
   * act on it. Printing "try again in NaN seconds" would be worse than saying
   * nothing about the wait.
   */
  it.each([[undefined], [''], ['not-a-number'], ['0'], ['-5']])(
    'falls back to a wait-free sentence for %s',
    (header) => {
      const message = rateLimitMessage(header);
      expect(message).toBe('Too many attempts. Please wait a moment and try again.');
      expect(message).not.toMatch(/NaN|undefined|Infinity/);
    },
  );

  /** Node hands a repeated header back as an array. */
  it('reads the first value when the header arrives as an array', () => {
    expect(rateLimitMessage(['43', '99'])).toBe(
      'Too many attempts. Please try again in 43 seconds.',
    );
  });

  it('accepts the number form Express also returns', () => {
    expect(rateLimitMessage(43)).toBe('Too many attempts. Please try again in 43 seconds.');
  });
});
