import { describe, expect, it } from 'vitest';
import { ManualPaymentProvider } from '../src/modules/payments/providers/manual/manual.provider';
import { RivalPaymentProvider } from '../src/modules/payments/providers/rival/rival.provider';
import { PaymentProviderRegistry } from '../src/modules/payments/providers/payment-provider-registry';
import type { PaymentProviderAdapter } from '../src/modules/payments/providers/payment-provider';
import type { RivalClient } from '../src/modules/payments/providers/rival/rival.client';
import type { RivalConfigService } from '../src/modules/payments/providers/rival/rival-config.service';

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

    it('declares what the core needs to PAY every automated payout it offers (0173)', () => {
      const automated = adapter.channels.filter(
        (channel) => channel.direction === 'payout' && channel.flow === 'automated',
      );
      if (automated.length === 0) return;
      const rail = adapter.payouts;
      expect(rail, 'an automated payout channel needs payout operations').toBeDefined();
      if (!rail) return;
      // The one question that decides whether a lost payout can ever be paid twice.
      expect(['key', 'reference', 'none']).toContain(rail.idempotency);
      expect(['desk', 'wait']).toContain(rail.whenUnavailable);
      expect(rail.adoptWindowMs).toBeGreaterThan(0);
      if (rail.cancellable) expect(typeof rail.cancel).toBe('function');
      for (const name of ['quote', 'submit', 'find', 'read'] as const) {
        expect(typeof rail[name], name).toBe('function');
      }
    });

    it('says what every hosted deposit credits, and nothing hosted anywhere else', () => {
      for (const channel of adapter.channels) {
        if (channel.flow === 'redirect') {
          expect(['exact', 'received', undefined]).toContain(channel.creditPolicy);
        } else {
          expect(channel.creditPolicy, `${channel.direction}:${channel.code}`).toBeUndefined();
          expect(channel.hostedPageReturns, `${channel.direction}:${channel.code}`).toBeUndefined();
        }
        // An asset moved at par is always tied to named wallet currencies.
        if (channel.asset) expect(channel.currencies).not.toBe('any');
      }
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

/*
 * THE BOOT REFUSES what the core could not honour — found at start-up, never
 * by a client's money. The worst of them: an AUTOMATED payout channel with no
 * payout operations, which approval would mark PAID with nothing sent.
 */
it('refuses an automated payout channel on a provider with no payout operations', () => {
  const broken: PaymentProviderAdapter = {
    code: 'broken',
    name: 'Broken',
    builtIn: false,
    configFields: [{ name: 'key', label: 'Key', kind: 'secret', required: true }],
    channels: [
      {
        code: 'usdt',
        direction: 'payout',
        label: 'USDT',
        flow: 'automated',
        settlementScale: 2,
        currencies: ['USD'],
        bindable: true,
        destination: { kind: 'crypto_address', label: 'Address' },
      },
    ],
    isUsable: () => Promise.resolve(true),
  };
  expect(() => new PaymentProviderRegistry([broken])).toThrow(/no payout operations/);
});

it('refuses a hosted deposit the provider cannot open or report on', () => {
  const broken: PaymentProviderAdapter = {
    code: 'broken',
    name: 'Broken',
    builtIn: false,
    configFields: [{ name: 'key', label: 'Key', kind: 'secret', required: true }],
    channels: [
      {
        code: 'page',
        direction: 'deposit',
        label: 'Page',
        flow: 'redirect',
        settlementScale: 2,
        currencies: 'any',
        bindable: true,
      },
    ],
    isUsable: () => Promise.resolve(true),
  };
  expect(() => new PaymentProviderRegistry([broken])).toThrow(/cannot open or report/);
});
