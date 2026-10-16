import { describe, expect, it } from 'vitest';
import {
  clientErrorLogLine,
  pathOnly,
  scrub,
  scrubStack,
} from '../src/modules/client-errors/client-error-report';

/** A crash report must never carry a person into the log. */
describe('client crash reports keep no personal data', () => {
  it('drops the query string and fragment, which can hold a reset token or a code', () => {
    expect(pathOnly('/auth/reset-password?token=abc123&lang=ar')).toBe('/auth/reset-password');
    expect(pathOnly('/auth/register#step2')).toBe('/auth/register');
  });

  it('blanks emails and long digit runs from the message and the stack', () => {
    expect(scrub('Invalid user hamwe653@gmail.com phone 96170123456')).toBe(
      'Invalid user [email] phone [digits]',
    );
    const line = clientErrorLogLine(
      {
        app: 'portal',
        boundary: 'page',
        name: 'TypeError',
        message: 'x for a@b.co',
        stack: 'at f (https://portal.oxshare.com/_next/static/chunks/1234.js:1:99)\nuser 1000245',
        path: '/auth/register?ref=EU79H6WV',
      },
      'Mozilla/5.0',
    );
    expect(line).toMatchObject({ path: '/auth/register', message: 'x for [email]' });
    expect(line.stack).toContain('user [digits]');
  });

  it('keeps the code positions in stack frames, which name no one', () => {
    const stack =
      'NotFoundError: code 123456 for a@b.co\n' +
      '    at iR (https://portal.oxshare.com/_next/static/chunks/37bd.js?dpl=380234356f06:31:204567)';
    expect(scrubStack(stack)).toBe(
      'NotFoundError: code [digits] for [email]\n' +
        '    at iR (https://portal.oxshare.com/_next/static/chunks/37bd.js?dpl=380234356f06:31:204567)',
    );
  });
});
