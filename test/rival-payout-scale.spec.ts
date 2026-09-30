import { describe, expect, it, vi } from 'vitest';
import {
  RIVAL_MONEY_SCALE,
  RivalClient,
} from '../src/modules/payments/providers/rival/rival.client';
import type { RivalConfigService } from '../src/modules/payments/providers/rival/rival-config.service';

/**
 * The CRM must never ask Rival for a different amount than it debited.
 *
 * ## Why this is a separate, structural check
 *
 * `requestWithdrawal` refuses an over-precise amount at the door, bounded by the
 * SMALLER of the currency's declared decimals and the rail's own scale. That is
 * the check a client meets, and it is where the good error message lives.
 *
 * This is the one underneath it. `quantiseOut` used to round DOWN silently: the
 * client was debited 50.12345679 and paid 50.12, with the difference kept and
 * nothing recording it. The door check makes that unreachable in normal
 * operation — which is precisely why the rounding had to go rather than stay as
 * "belt and braces". A value arriving here with more places than Rival can send
 * now means the door was BYPASSED or is WRONG: a new rail, a currency
 * reconfigured past the rail's scale, a row created before the rule existed. All
 * three are configuration problems a person should see, and all three used to
 * resolve as a sub-cent rounding nobody ever would.
 *
 * `submitApproved` turns the throw into a definite refusal — claim cleared, row
 * flagged with the reason, approvers told — so the failure is loud and
 * recoverable rather than silent and permanent.
 */

/** A client wired to a fake transport, so nothing leaves the process. */
function clientSending(capture: { body?: Record<string, unknown> }) {
  const config = {
    resolve: () =>
      Promise.resolve({ baseUrl: 'https://rival.test/v1', apiKey: 'k', enabled: true }),
  } as unknown as RivalConfigService;

  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: { body?: string }) => {
      capture.body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            statusCode: 201,
            data: { id: 'rw-1', amount: '10.00', currency: 'USD', netAmount: '10.00' },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      );
    }),
  );

  return new RivalClient(config);
}

const payout = (amount: string) => ({
  amount,
  currency: 'USD',
  notes: 'crm:test',
  method: 'WISH' as const,
  recipientName: 'Test Client',
  recipientPhone: '+96170123456',
});

describe('the amount handed to Rival', () => {
  it('REFUSES a deposit amount the platform cannot collect exactly', async () => {
    /*
     * The money-IN twin, and on a deposit the divergence can favour either side:
     * the link is created at the rounded figure while the wallet is credited
     * `tx.amount`, and the rounding was half-UP, so the CRM could credit MORE
     * than was collected.
     *
     * Rival's own schemas quantise an incoming amount rather than rejecting it,
     * because "the deposit already happened at the provider" — true when
     * INGESTING a payment already made, and the opposite of this moment.
     * `createWhishPayment` creates the link: nothing is paid yet, so nothing can
     * be stranded by refusing.
     */
    const capture: { body?: Record<string, unknown> } = {};
    const client = clientSending(capture);

    await expect(
      client.createWhishPayment({
        amount: '25.12345678',
        currency: 'USD',
        invoice: 'OX-TEST',
        idempotencyKey: 'OX-TEST',
      }),
    ).rejects.toThrow(/cannot take 25\.12345678 exactly/i);

    expect(capture.body, 'no link may be created for an uncollectable amount').toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('REFUSES an amount the platform cannot send exactly', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const client = clientSending(capture);

    await expect(client.createWithdrawal(payout('50.12345679'))).rejects.toThrow(
      /cannot send 50\.12345679 exactly/i,
    );

    // And it never left. Refusing AFTER the request would be the double-payment
    // risk this file exists to avoid.
    expect(capture.body, 'nothing may be sent when the amount is unpayable').toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('sends an exactly-payable amount unchanged, at the rail scale', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const client = clientSending(capture);

    await client.createWithdrawal(payout('10.5'));

    // Padded to the rail's scale, and the VALUE is untouched — the guard must
    // not become "reject anything that is not already 2dp text".
    expect(capture.body?.amount).toBe('10.50');
    vi.unstubAllGlobals();
  });

  it('names the rail scale from one place', () => {
    // The literal 2 used to live anonymously inside two quantise helpers, which
    // is why nothing could compare it against the currency's own decimals.
    expect(RIVAL_MONEY_SCALE).toBe(2);
  });
});
