import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { PaymentsReturnController } from '../src/modules/payments/payments-return.controller';

/**
 * The payer-return bounce — an UNAUTHENTICATED redirect surface, so what this
 * spec pins is mostly what it must NOT do: reflect attacker-controlled values
 * into the redirect target. The host comes only from PORTAL_URL; every
 * interpolated value is allowlisted first.
 */
describe('PaymentsReturnController', () => {
  let controller: PaymentsReturnController;
  let redirected: { status?: number; url?: string };

  const res = {
    redirect(status: number, url: string) {
      redirected = { status, url };
    },
  } as unknown as Response;

  beforeEach(() => {
    redirected = {};
    const config = new ConfigService({ PORTAL_URL: 'https://portal.oxshare.com' });
    controller = new PaymentsReturnController(config);
  });

  it('bounces a valid return to the portal result page with reference and method', () => {
    controller.bounce('OX-846SMQ', 'success', 'whish', res);
    expect(redirected.status).toBe(302);
    expect(redirected.url).toBe(
      'https://portal.oxshare.com/deposit/success?reference=OX-846SMQ&method=whish',
    );
  });

  it('treats any outcome that is not "success" as failure — the payer cannot invent states', () => {
    controller.bounce('OX-846SMQ', 'paid-i-promise', 'whish', res);
    expect(redirected.url).toContain('/deposit/failure?');
  });

  it('refuses a reference that is not reference-shaped instead of reflecting it', () => {
    controller.bounce('../../../evil', 'success', 'whish', res);
    expect(redirected.url).toBe(
      'https://portal.oxshare.com/deposit/success?reference=&method=whish',
    );
  });

  it('drops a method that could smuggle a URL', () => {
    controller.bounce('OX-846SMQ', 'failure', '//attacker.com/x', res);
    expect(redirected.url).toBe('https://portal.oxshare.com/deposit/failure?reference=OX-846SMQ');
  });

  /*
   * No `whish` default any more (0168): a deposit is found by its reference and
   * its owner alone, so a missing method is simply not passed on — guessing one
   * would send a second provider's payer to look for a Rival deposit.
   */
  it('passes no method when none came back', () => {
    controller.bounce('OX-846SMQ', 'success', undefined, res);
    expect(redirected.url).toBe('https://portal.oxshare.com/deposit/success?reference=OX-846SMQ');
  });

  it('never 301s — the portal address is config, not something to cache into browsers', () => {
    controller.bounce('OX-846SMQ', 'success', 'whish', res);
    expect(redirected.status).toBe(302);
  });
});
