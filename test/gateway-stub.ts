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
 * withdrawal rules, and the real registry would reach for Whish credentials that
 * no test environment has. `isConfigured` therefore answers FALSE, which is the
 * honest answer for a deployment with no gateway keys — and it keeps every
 * manual method in those fixtures behaving exactly as before, since the
 * kind-aware check only consults this for `kind === 'gateway'` rows.
 *
 * The gateway path itself is covered in `whish-provider.spec.ts` against a fake
 * fetch, which is the only form of that test not requiring a live provider.
 */
export function gatewayStub() {
  return {
    /*
     * `isImplemented` answers TRUE for whish and `isConfigured` answers FALSE —
     * the same split the real registry makes, and the reason both exist.
     *
     * Implemented is a fact about the BUILD: Whish has a provider, so a method
     * with that key behaves as a `gateway` and must not fall back to manual.
     * Configured is a fact about the ENVIRONMENT: no test environment holds
     * Whish credentials, so it is correctly not offered to clients.
     *
     * Collapsing the two here would hide exactly the bug the pair prevents — a
     * gateway silently serving bank-transfer instructions for a provider that
     * has no bank account.
     */
    isImplemented: vi.fn((key: string) => key === 'whish'),
    isConfigured: vi.fn().mockReturnValue(false),
    startPayment: vi.fn().mockResolvedValue({ paymentUrl: 'https://example.test/pay/stub' }),
    checkPayment: vi.fn().mockResolvedValue({ settled: false, paid: false, rawStatus: 'pending' }),
  };
}

/** The stub, typed as the thing the constructors ask for. */
export function gatewayStubAs(): PaymentGateways {
  return gatewayStub() as unknown as PaymentGateways;
}
