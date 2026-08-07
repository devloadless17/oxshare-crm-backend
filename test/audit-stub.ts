import { vi } from 'vitest';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import type { Actor } from '../src/common/security/actor';

/**
 * A recording stand-in for `AdminAuditService`, for the unit suites.
 *
 * Those suites construct their service directly against a real database rather
 * than through Nest, so they have to supply the audit writer themselves. A stub
 * rather than the real service because these files are testing the DOMAIN rules
 * — "do these levels total more than 100%" — and a real writer would need an
 * `admins` row to resolve the actor's email against, which is a fixture with
 * nothing to do with what is being asserted.
 *
 * Whether the audit call actually HAPPENS on each route is asserted elsewhere,
 * and deliberately not here: `audit-completeness.spec.ts` drives real HTTP and
 * reads the table, which is the only form of that question a stub cannot
 * satisfy. This one only needs to be callable.
 */
export function auditStub() {
  return { record: vi.fn(), recordWithin: vi.fn() };
}

/** The stub, typed as the thing the constructors ask for. */
export function auditStubAs(): AdminAuditService {
  return auditStub() as unknown as AdminAuditService;
}

/**
 * An acting administrator for a unit suite.
 *
 * `permissions: ['*']` because these suites are asserting domain rules, not
 * authorization — the permission checks have their own coverage in
 * `service-authorization.spec.ts` and `route-authorization.spec.ts`, and a
 * scoped actor here would make every test in the file also a test of RBAC.
 */
export const TEST_ACTOR: Actor = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'unit-test-admin@oxshare.internal',
  permissions: ['*'],
};
