import { vi } from 'vitest';
import { PaymentProviderRegistry } from '../src/modules/payments/providers/payment-provider-registry';
import { ManualPaymentProvider } from '../src/modules/payments/providers/manual.provider';
import { RivalPaymentProvider } from '../src/modules/payments/providers/rival.provider';
import type { RivalClient } from '../src/modules/payments/rival/rival.client';
import type { RivalConfigService } from '../src/modules/payments/rival/rival-config.service';

/**
 * The payment provider registry the money specs run against (0168).
 *
 * The REAL registry with the REAL adapters' channel declarations — so a spec
 * exercises the same route logic production does: which channel is a hosted
 * page, what a payout destination must look like, the settlement scale. Only
 * the three calls that would reach a provider over the network are mocks:
 *
 *   rivalUsable   — is Rival configured and on? NOT unless a spec says so
 *                   (`rivalUsable.mockResolvedValue(true)`), as on a deployment
 *                   with no Rival credentials. Manual — the desk — is always
 *                   usable, answered by the real adapter.
 *   startPayment  — a hosted payment opened: `{ paymentUrl, externalId }`.
 *   checkPayment  — what the provider says it is now.
 */
export function gatewayStub() {
  const rivalUsable = vi.fn().mockResolvedValue(false);
  const rival = new RivalPaymentProvider(
    {} as RivalClient,
    { isEnabled: rivalUsable } as unknown as RivalConfigService,
  );
  const registry = new PaymentProviderRegistry([new ManualPaymentProvider(), rival]);
  return Object.assign(registry, {
    rivalUsable,
    startPayment: vi.fn().mockResolvedValue({
      paymentUrl: 'https://example.test/pay/stub',
      externalId: '424242',
    }),
    checkPayment: vi.fn().mockResolvedValue({
      settled: false,
      paid: false,
      rawStatus: 'PENDING',
      needsAttention: false,
    }),
  });
}

export function gatewayStubAs(): PaymentProviderRegistry {
  return gatewayStub();
}
