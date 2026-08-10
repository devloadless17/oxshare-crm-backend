import { vi } from 'vitest';
import type { NotificationDispatchPort } from '../src/common/provisioning/notification-dispatch.port';

/**
 * A recording stand-in for `NotificationDispatchPort`, for the unit suites —
 * the same reason `commission-stub.ts` and `audit-stub.ts` exist beside it:
 * those suites construct the domain services directly rather than through
 * Nest, so they supply the port themselves.
 *
 * A stub rather than the real `NotificationsService` because those files are
 * testing MONEY and KYC rules; whether a state change actually lands a row is
 * asserted in `notifications-hooks.spec.ts` against real data, which is the
 * only form of that question a stub cannot answer.
 */
export function notificationsStub() {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    notifyAdminsWithPermission: vi.fn().mockResolvedValue(undefined),
  };
}

/** The stub, typed as the thing the constructors ask for. Structurally
 * satisfied — the port is two methods — so no cast is needed. */
export function notificationsStubAs(): NotificationDispatchPort {
  return notificationsStub();
}
