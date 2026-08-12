import { vi } from 'vitest';
import type { CommissionAccrualPort } from '../src/common/provisioning/commission-accrual.port';

/**
 * A recording stand-in for `CommissionAccrualPort`, for the unit suites.
 *
 * Those suites construct `TransactionsService` directly against a real database
 * rather than through Nest, so they have to supply the port themselves — the
 * same reason `audit-stub.ts` exists beside it.
 *
 * A stub rather than the real `CommissionService` because those files are
 * testing DEPOSIT and WITHDRAWAL rules, and the real one would drag in the
 * wallet service, the IB ladder and an `ib_accounts` fixture that has nothing to
 * do with what is being asserted.
 *
 * Whether a settled deposit ACTUALLY accrues a commission is asserted in
 * `commission.spec.ts`, against real data, which is the only form of that
 * question a stub cannot answer. This one only needs to be callable.
 *
 * It returns 0, matching the port's contract for "nobody was owed anything" —
 * the honest answer for a client with no referrer, which is every client in
 * these fixtures.
 */
export function commissionStub() {
  return {
    accrueForSettledDeposit: vi.fn().mockResolvedValue(0),
    accrueForClosedPosition: vi.fn().mockResolvedValue(0),
  };
}

/**
 * The stub, typed as the thing the constructor asks for.
 *
 * No cast, unlike `auditStubAs` beside it — the port is two plain methods, so
 * the mock already satisfies the interface structurally. `AdminAuditService` is
 * a class with private members, which is why its stub needs the double
 * assertion and this one does not.
 */
export function commissionStubAs(): CommissionAccrualPort {
  return commissionStub();
}
