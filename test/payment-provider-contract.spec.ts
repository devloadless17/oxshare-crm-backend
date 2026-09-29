import { describe, expect, it } from 'vitest';
import { ManualPaymentProvider } from '../src/modules/payments/providers/manual.provider';
import { RivalPaymentProvider } from '../src/modules/payments/providers/rival.provider';
import { PaymentProviderRegistry } from '../src/modules/payments/providers/payment-provider-registry';
import type { PaymentProviderAdapter } from '../src/modules/payments/providers/payment-provider';
import type { RivalClient } from '../src/modules/payments/rival/rival.client';
import type { RivalConfigService } from '../src/modules/payments/rival/rival-config.service';

/**
 * THE CONTRACT EVERY PAYMENT PROVIDER ADAPTER PASSES (0168).
 *
 * Adding a provider is one adapter; this is what makes that safe. Each rule is
 * something the money paths rely on without checking again: a hosted-page
 * deposit channel can actually open and check a payment, a payout says what
 * the client must give, a secret is never a plain setting, and the desk's own
 * channels are never offered to a method. Register a new adapter in ADAPTERS
 * and it is held to all of them.
 */
const ADAPTERS: PaymentProviderAdapter[] = [
  new ManualPaymentProvider(),
  new RivalPaymentProvider(
    {} as RivalClient,
    { isEnabled: () => Promise.resolve(false) } as unknown as RivalConfigService,
  ),
];

describe.each(ADAPTERS.map((adapter) => [adapter.code, adapter] as const))(
  'the %s adapter',
  (_code, adapter) => {
    it('registers: a lower-case code, no channel declared twice, every payout says what it needs', () => {
      expect(adapter.code).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
      expect(() => new PaymentProviderRegistry([adapter])).not.toThrow();
    });

    it('can open and check every hosted-page deposit it declares', () => {
      const redirects = adapter.channels.filter(
        (channel) => channel.direction === 'deposit' && channel.flow === 'redirect',
      );
      for (const channel of redirects) {
        expect(typeof adapter.startPayment, channel.code).toBe('function');
        expect(typeof adapter.checkPayment, channel.code).toBe('function');
      }
    });

    it('takes a receipt only on a deposit paid outside the platform', () => {
      for (const channel of adapter.channels.filter((c) => c.acceptsReceipt)) {
        expect([channel.direction, channel.flow]).toEqual(['deposit', 'offline']);
      }
    });

    it('declares flows that belong to each direction', () => {
      for (const channel of adapter.channels) {
        const flows =
          channel.direction === 'deposit'
            ? ['redirect', 'offline', 'adjustment']
            : ['automated', 'desk', 'cash'];
        expect(flows, `${channel.direction}:${channel.code}`).toContain(channel.flow);
        // The desk's own adjustment is never a method's to bind.
        if (channel.flow === 'adjustment') expect(channel.bindable).toBe(false);
      }
    });

    it('keeps secrets secret: a generated setting is always a secret', () => {
      for (const field of adapter.configFields.filter((f) => f.generated)) {
        expect(field.kind, field.name).toBe('secret');
      }
      if (adapter.builtIn) expect(adapter.configFields).toHaveLength(0);
      else expect(adapter.configFields.some((field) => field.required)).toBe(true);
    });

    it('never offers a settlement scale finer than the platform holds', () => {
      for (const channel of adapter.channels) {
        if (channel.settlementScale !== null) {
          expect(channel.settlementScale).toBeGreaterThanOrEqual(0);
          expect(channel.settlementScale).toBeLessThanOrEqual(8);
        }
      }
    });
  },
);

it('refuses two providers with one code', () => {
  expect(() => new PaymentProviderRegistry([ADAPTERS[0], ADAPTERS[0]])).toThrow(/Two payment/);
});
