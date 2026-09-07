import { vi } from 'vitest';
import type { PaymentGateways } from '../src/modules/payments/payment-gateways.service';

/**
 * A stand-in for `PaymentGateways`, for the unit suites.
 *
 * Those suites construct `PaymentMethodsService` and `TransactionsService`
 * directly against a real database rather than through Nest, so they have to
 * supply the registry themselves — the same reason `audit-stub.ts` and
 * `commission-stub.ts` exist beside it.
 *
 * A stub rather than the real thing because those files test MANUAL deposit and
 * withdrawal rules, and the real registry would reach for a Rival connection
 * that no test environment has. `isConfigured` therefore answers FALSE, which
 * is the honest answer for a deployment with no platform key — and it keeps
 * every manual method in those fixtures behaving exactly as before, since the
 * kind-aware check only consults this for gateway rows.
 *
 * The gateway path itself is covered in `rival-deposit-flow.spec.ts` against a
 * stubbed RivalClient, which is the only form of that test not requiring a
 * live platform.
 */
export function gatewayStub() {
  return {
    /*
     * `isImplemented` answers TRUE for whish and `isConfigured` answers FALSE —
     * the same split the real registry makes, and the reason both exist.
     *
     * Implemented is a fact about the BUILD: the whish key routes through
     * Rival, so a method with that key behaves as a `gateway` and must not
     * fall back to manual. Configured is a fact about the CONFIGURATION: no
     * test environment holds a Rival key, so it is correctly not offered.
     *
     * Collapsing the two here would hide exactly the bug the pair prevents — a
     * gateway silently serving bank-transfer instructions for a provider that
     * has no bank account.
     */
    isImplemented: vi.fn((key: string) => key === 'whish'),
    /*
     * The rail's settlement scale, mirroring the real registry — 2 for whish,
     * null for anything settled by a human.
     *
     * Not stubbed to a constant: the withdrawal door validates against the
     * SMALLER of this and the currency's own decimals, so a stub that always
     * answered null would quietly stop testing that half of the rule, and a
     * stub that always answered 2 would apply a rail's limit to manual methods
     * that have none.
     */
    payoutScale: vi.fn((key: string) => (key === 'whish' ? 2 : null)),
    // Async, like the real registry: the answer now lives in rival_settings.
    isConfigured: vi.fn().mockResolvedValue(false),
    startPayment: vi.fn().mockResolvedValue({
      paymentUrl: 'https://example.test/pay/stub',
      rivalExternalId: '424242',
    }),
    checkPayment: vi.fn().mockResolvedValue({
      settled: false,
      paid: false,
      rawStatus: 'PENDING',
      needsAttention: false,
    }),
  };
}

/** The stub, typed as the thing the constructors ask for. */
export function gatewayStubAs(): PaymentGateways {
  return gatewayStub() as unknown as PaymentGateways;
}
