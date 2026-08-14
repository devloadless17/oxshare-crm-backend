import { describe, expect, it } from 'vitest';

import { isPayerReachableUrl } from '../src/modules/payments/rival/payer-reachable-url';

/**
 * Pins the CRM's mirror of Rival's redirect-URL rule
 * (transactions-system packages/shared whish-redirect-url.spec): every URL
 * Rival would refuse must make us OMIT the redirects, and every URL Rival
 * accepts must pass through — a drift here turns into deposit creates dying
 * with a validation error the client cannot act on.
 */
describe('isPayerReachableUrl', () => {
  it.each([
    'https://portal.oxshare.com/payments/OX-123/success',
    'https://staging.oxshare.dev/payments/x/failure',
    'http://192.168.1.10:3000/payments/x/success', // LAN — Rival only refuses loopback shapes
    'https://my-localhost-tools.com/done', // "localhost" as a substring, not the host
  ])('accepts payer-reachable %s', (url) => {
    expect(isPayerReachableUrl(url)).toBe(true);
  });

  it.each([
    'http://localhost:3000/payments/OX-123/success',
    'https://LOCALHOST/payments/x/success', // case-insensitive host
    'http://app.localhost/payments/x/success', // *.localhost
    'http://127.0.0.1:3000/payments/x/success',
    'http://127.99.4.2/payments/x/success', // whole 127.0.0.0/8 range
    'http://[::1]:3000/payments/x/success',
    'http://0.0.0.0:3000/payments/x/success',
    'http://[::]:3000/payments/x/success',
    'ftp://portal.oxshare.com/x', // non-http(s) scheme
    'not a url at all',
    '',
  ])('refuses %s', (url) => {
    expect(isPayerReachableUrl(url)).toBe(false);
  });
});
