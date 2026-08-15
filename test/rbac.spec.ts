import { ALL_PERMISSIONS } from './support/all-permissions';
import { describe, expect, it, vi } from 'vitest';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthorizationError } from '../src/common/errors/domain-errors';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { ClientFieldsService } from '../src/modules/admin/client-fields.service';
import { AdminRbacService } from '../src/modules/admin/admin-rbac.service';
import {
  AdminAuthenticator,
  ANY_ADMIN_KEY,
  PermissionsGuard,
  PERMISSIONS_KEY,
} from '../src/modules/admin/guards/admin.guard';
import { AdminsStore, type Admin } from '../src/store/admins.store';
import { InvitesStore } from '../src/store/admins.store';
import { RolesStore, type Role } from '../src/store/roles.store';
import { sessionCookieNames } from '../src/common/security/session-cookies';
import { TOKEN_KIND } from '../src/common/security/token-audience';
import { ClientTagsStore } from '../src/store/client-tags.store';
import { AdminClientScopesStore } from '../src/store/admin-client-scopes.store';

// The RBAC surface had ZERO tests, which is how a missing `await` on the
// anti-escalation guard shipped: the rejected promise was discarded and the
// update went through anyway. These tests exist so that specific regression
// cannot recur silently.
//
// They are possible at all because the stores are now injectable classes. As
// module-level `const` object literals over a getDb() singleton there was no
// seam to substitute a fake through, so none of this could be unit tested.

const MASTER: Admin = {
  id: 'master-1',
  email: 'admin@oxshare.com',
  name: 'Master Admin',
  passwordHash: 'x',
  role: 'master_admin',
  status: 'active',
  permissions: ALL_PERMISSIONS,
  createdAt: new Date(),
};

const SUB_ADMIN: Admin = {
  id: 'sub-1',
  email: 'sub@oxshare.com',
  name: 'Sub Admin',
  passwordHash: 'x',
  role: 'sub_admin',
  status: 'active',
  permissions: ['roles.edit', 'roles.view'],
  createdAt: new Date(),
};

/**
 * The same sub-admin, but ASSIGNED to `role-1` — which is the whole difference
 * the self-edit rule turns on. `resolvePermissions` replaces an admin's own
 * column with their role's, so for this actor editing `role-1` is editing
 * themselves.
 */
const SUB_ADMIN_ON_ROLE_1: Admin = { ...SUB_ADMIN, id: 'sub-2', roleId: 'role-1' };

const CUSTOM_ROLE: Role = {
  id: 'role-1',
  name: 'Reviewer',
  permissions: ['kyc.review'],
  maskedFields: [],
  isSystem: false,
  createdAt: new Date(),
};

async function buildRbacService(
  overrides: {
    roles?: Partial<RolesStore>;
    admins?: Partial<AdminsStore>;
  } = {},
) {
  const rolesFake = {
    findAll: vi.fn(),
    findById: vi.fn().mockResolvedValue(CUSTOM_ROLE),
    findByName: vi.fn().mockResolvedValue(undefined),
    create: vi.fn((data: { permissions: string[] }) =>
      Promise.resolve({ ...CUSTOM_ROLE, ...data }),
    ),
    update: vi.fn((_id: string, patch: object) => Promise.resolve({ ...CUSTOM_ROLE, ...patch })),
    delete: vi.fn(),
    resolvePermissions: vi.fn(),
    resolveMaskedFields: vi.fn().mockResolvedValue([]),
    ...overrides.roles,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminRbacService,
      // Real, not a fake: it reads a committed JSON file and has no
      // dependencies, so a fake here would only let mask keys the catalog
      // rejects pass in tests and fail in production.
      ClientFieldsService,
      // The two visibility stores — see the ClientFieldsService note above.
      { provide: ClientTagsStore, useValue: { findByIds: vi.fn().mockResolvedValue([]) } },
      {
        provide: AdminClientScopesStore,
        useValue: {
          replace: vi.fn().mockResolvedValue(undefined),
          // `sanitize` now reports each admin's territory on the row, so the
          // directory can show it without opening a modal.
          describeFor: vi.fn().mockResolvedValue([]),
        },
      },
      {
        provide: AdminsStore,
        useValue: {
          findById: vi.fn(),
          findByEmail: vi.fn(),
          update: vi.fn(),
          create: vi.fn(),
          findAll: vi.fn(),
          ...overrides.admins,
        },
      },
      {
        provide: InvitesStore,
        useValue: { findPendingByRoleId: vi.fn().mockResolvedValue([]) },
      },
      { provide: RolesStore, useValue: rolesFake },
      { provide: AdminAuditService, useValue: { record: vi.fn() } },
    ],
  }).compile();

  return { service: moduleRef.get(AdminRbacService), rolesFake };
}

describe('AdminRbacService anti-escalation', () => {
  it('REGRESSION C1: a sub-admin cannot grant themselves the wildcard via their OWN role', async () => {
    const { service, rolesFake } = await buildRbacService();

    await expect(
      service.updateRole('role-1', { permissions: ALL_PERMISSIONS }, SUB_ADMIN_ON_ROLE_1),
    ).rejects.toThrow(AuthorizationError);

    // The point of the regression: the guard rejecting is not enough — the
    // write must not happen. With the missing `await`, update() still ran.
    expect(rolesFake.update).not.toHaveBeenCalled();
  });

  /*
   * REFUSED, not merely restricted. An earlier version let you edit your own
   * role downward — subset-only — which closed the escalation but left the UI
   * offering an Edit action that failed on save depending on which boxes you
   * ticked. A flat refusal is what lets the roles screen hide the action.
   */
  it('a sub-admin cannot edit their OWN role at all, even to a subset they hold', async () => {
    const { service, rolesFake } = await buildRbacService();

    await expect(
      service.updateRole('role-1', { permissions: ['roles.view'] }, SUB_ADMIN_ON_ROLE_1),
    ).rejects.toThrow(AuthorizationError);
    expect(rolesFake.update).not.toHaveBeenCalled();
  });

  /*
   * The rename and the mask are the same act. `maskedFields` decides which
   * client fields the holder may READ, so leaving it editable on your own role
   * would be the same escalation under a different property name — which is
   * exactly what the earlier `if (patch.permissions)` placement allowed.
   */
  it('refuses a name-only or mask-only edit of your own role', async () => {
    const { service, rolesFake } = await buildRbacService();

    await expect(
      service.updateRole('role-1', { name: 'Renamed' }, SUB_ADMIN_ON_ROLE_1),
    ).rejects.toThrow(AuthorizationError);
    await expect(
      service.updateRole('role-1', { maskedFields: [] }, SUB_ADMIN_ON_ROLE_1),
    ).rejects.toThrow(AuthorizationError);
    expect(rolesFake.update).not.toHaveBeenCalled();
  });

  /*
   * The counterpart, and the reason the rule is "not your own" rather than a
   * flat subset: `roles.edit` has to be able to define a role, including with
   * keys the definer does not personally hold. Otherwise the set of grantable
   * permissions can only ever shrink, and a genuinely new key reaches nobody.
   */
  it('a sub-admin MAY grant a permission they do not hold to a role they are not on', async () => {
    const { service, rolesFake } = await buildRbacService();

    await service.updateRole('role-1', { permissions: ['ib.approve'] }, SUB_ADMIN);
    expect(rolesFake.update).toHaveBeenCalledWith('role-1', { permissions: ['ib.approve'] });
  });

  it('a sub-admin may grant a permission they do hold', async () => {
    const { service, rolesFake } = await buildRbacService();

    await service.updateRole('role-1', { permissions: ['roles.view'] }, SUB_ADMIN);
    expect(rolesFake.update).toHaveBeenCalledWith('role-1', { permissions: ['roles.view'] });
  });

  it('the master admin may grant the wildcard', async () => {
    const { service, rolesFake } = await buildRbacService();

    await service.updateRole('role-1', { permissions: ALL_PERMISSIONS }, MASTER);
    expect(rolesFake.update).toHaveBeenCalled();
  });

  it('rejects permission keys that are not in the catalog', async () => {
    const { service, rolesFake } = await buildRbacService();

    await expect(
      service.updateRole('role-1', { permissions: ['definitely.not.real'] }, MASTER),
    ).rejects.toThrow(/Unknown permission key/);
    expect(rolesFake.update).not.toHaveBeenCalled();
  });

  /*
   * CREATE IS CATALOG-ONLY, AND THIS IS THE TEST THAT SAYS WHY THAT IS SAFE.
   *
   * A role being created has nobody on it, so writing `wallets.credit` into one
   * grants that key to no one. The escalation is the SECOND step — assigning
   * yourself to the role you just wrote — and `updateAdmin` is where it is
   * caught, by checking the role's keys against the actor's own.
   *
   * Guarding `createRole` instead would block defining a role at all while
   * leaving that second step to do the real work anyway.
   */
  it('lets a sub-admin CREATE a powerful role, but not put anybody on it', async () => {
    const escalated: Role = { ...CUSTOM_ROLE, id: 'role-2', permissions: ALL_PERMISSIONS };
    const colleague: Admin = { ...SUB_ADMIN, id: 'sub-9', permissions: ['clients.view'] };
    const { service, rolesFake } = await buildRbacService({
      roles: {
        findById: vi.fn().mockResolvedValue(escalated),
        /*
         * The real fallback: a roleId REPLACES the admin's own snapshot. The
         * colleague holds no role, so `assertActorOutranks` compares against
         * their own column and the sub-admin outranks them — letting the test
         * reach the grant check it is actually about.
         */
        resolvePermissions: vi.fn((roleId: string | undefined, own: string[]) =>
          Promise.resolve(roleId ? escalated.permissions : own),
        ),
      },
      admins: { findById: vi.fn().mockResolvedValue(colleague) },
    });

    await service.createRole('Escalated', undefined, ALL_PERMISSIONS, SUB_ADMIN);
    expect(rolesFake.create).toHaveBeenCalled();

    /*
     * Assigning it to SOMEBODY ELSE, because assigning it to themselves never
     * reaches this guard: `updateAdmin` refuses any self-edit that touches
     * access outright, subset or not. Both doors are shut, by different checks.
     */
    await expect(
      service.updateAdmin(
        colleague.id,
        { roleId: 'role-2' },
        { ...SUB_ADMIN, clientScope: UNRESTRICTED, fieldMask: [] },
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('still rejects unknown keys on create', async () => {
    const { service, rolesFake } = await buildRbacService();

    await expect(
      service.createRole('Typo', undefined, ['definitely.not.real'], SUB_ADMIN),
    ).rejects.toThrow(/Unknown permission key/);
    expect(rolesFake.create).not.toHaveBeenCalled();
  });
});

describe('AdminAuthenticator', () => {
  function build(admin: Admin | undefined, rolePermissions?: string[]) {
    const jwt = {
      // `typ` is required now: access and refresh tokens are signed with the
      // same ADMIN_JWT_SECRET, so this claim is the only thing distinguishing
      // them. See test/token-kind.spec.ts for what happens without it.
      verify: vi.fn().mockReturnValue({
        sub: admin?.id ?? 'ghost',
        role: 'sub_admin',
        status: 'active',
        typ: TOKEN_KIND.access,
        // `fam` names the login. The guard refuses a token without one, because
        // a token it cannot check against a revoked family is one revocation
        // cannot reach — see admin.guard.ts.
        fam: 'family-1',
      }),
    };
    const config = { getOrThrow: vi.fn().mockReturnValue('test-secret') };
    const admins = { findById: vi.fn().mockResolvedValue(admin) };
    const roles = {
      resolvePermissions: vi
        .fn()
        .mockImplementation((_roleId: string | undefined, snapshot: string[]) =>
          Promise.resolve(rolePermissions ?? snapshot),
        ),
      resolveMaskedFields: vi.fn().mockResolvedValue([]),
    };
    return new AdminAuthenticator(
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      admins as unknown as AdminsStore,
      roles as unknown as RolesStore,
      // Unrestricted: no scope rows and an empty mask. These specs are about
      // authentication and permissions, so the two new dimensions are held
      // constant rather than being silently absent.
      { scopeFor: () => Promise.resolve(UNRESTRICTED) } as never,
      { expand: (m: readonly string[]) => [...m] } as never,
      // The `fam` revocation check, held alive: these specs are about
      // permissions, not session lifetime.
      { familyIsRevoked: () => Promise.resolve(false) } as never,
      // No API key ever matches: these specs authenticate by cookie, and a
      // stub that could return a key would make the credential under test
      // ambiguous.
      {
        findActiveByHash: () => Promise.resolve(null),
        touchLastUsed: () => Promise.resolve(),
      } as never,
    );
  }

  // The cookie NAME comes from the same source of truth the guard reads, so a
  // rename cannot leave this test asserting against a name nothing sets.
  const req = (token: string) =>
    ({ cookies: { [sessionCookieNames.adminAccess()]: token } }) as never;

  /** A request carrying no cookies at all — distinct from one carrying a bad token. */
  const reqWithoutCookie = () => ({ cookies: {} }) as never;

  it('rejects a request with no admin cookie', async () => {
    await expect(build(SUB_ADMIN).authenticate(reqWithoutCookie())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('REGRESSION C3: an unknown subject is rejected, never upgraded to the seeded master', async () => {
    // The old code fell back to findByEmail('admin@oxshare.com') here, so any
    // signed token with a stale `sub` became the master admin.
    await expect(build(undefined).authenticate(req('signed'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('resolves permissions from the role live, not from the token snapshot', async () => {
    const authenticator = build({ ...SUB_ADMIN, roleId: 'role-1' }, ['kyc.review']);
    const admin = await authenticator.authenticate(req('signed'));
    // Editing the role must take effect on the next request, with no re-login.
    expect(admin.permissions).toEqual(['kyc.review']);
  });
});

describe('PermissionsGuard', () => {
  function buildGuard(admin: Admin, required: string[] | undefined, anyAdmin?: string) {
    const authenticator = { authenticate: vi.fn().mockResolvedValue(admin) };
    // The guard asks for two keys: the required permissions, then — only when
    // there are none — whether the route explicitly allows any admin.
    const reflector = {
      getAllAndOverride: vi
        .fn()
        .mockImplementation((key: string) => (key === ANY_ADMIN_KEY ? anyAdmin : required)),
    };
    const guard = new PermissionsGuard(
      authenticator as unknown as AdminAuthenticator,
      reflector as unknown as Reflector,
    );
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ cookies: {} }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as never;
    return { guard, context, reflector };
  }

  it('DENIES a route that declares no permission at all (R-4.2)', async () => {
    /*
     * This test asserted the opposite until 4 Aug 2026, and in doing so it
     * pinned the defect: `if (!required) return true` meant a controller
     * decorated with @UseGuards(PermissionsGuard) but no @RequirePermissions
     * admitted any authenticated admin. Coverage was complete, but by
     * discipline — an endpoint that forgot the decorator looked exactly like one
     * that never needed it, and no reviewer can tell those apart in a diff.
     *
     * The absence of a declaration is now a refusal, so the failure mode of
     * forgetting is a 403 in development rather than an open door in production.
     */
    const { guard, context } = buildGuard(SUB_ADMIN, undefined);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('allows a route that explicitly declares @AnyAdmin', async () => {
    // The escape hatch is a written decision, not an omission — and it still
    // requires a valid admin session, since the authenticator runs first.
    const { guard, context } = buildGuard(SUB_ADMIN, undefined, 'reads the shared reason list');
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('allows when the admin holds one of the required permissions', async () => {
    const { guard, context } = buildGuard(SUB_ADMIN, ['roles.edit', 'admins.edit']);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('denies with 403, never 401 — a 401 would log the admin out (§8.8)', async () => {
    const { guard, context } = buildGuard(SUB_ADMIN, ['ib.approve']);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('the wildcard satisfies anything', async () => {
    const { guard, context } = buildGuard(MASTER, ['ib.approve']);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('matches regardless of case, because that is a typo and not a convention', async () => {
    const { guard, context } = buildGuard({ ...SUB_ADMIN, permissions: ['KYC.Review'] }, [
      'kyc.review',
    ]);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('does NOT accept the old colon spelling any more', async () => {
    /*
     * This test used to assert the opposite — "matches colon-style and dot-style
     * keys interchangeably" — and it was pinning a shim rather than a contract.
     *
     * Four copies of `replace(/:/g, '.')` bridged two spellings of every
     * permission key. They were generative, not merely redundant:
     * `assertGrantable` normalised BEFORE checking the catalog, so `kyc:review`
     * passed validation and was then stored verbatim, and the system kept
     * producing the inconsistency it was compensating for.
     *
     * Migration 0009 converts the stored keys; removing the shims is what stops
     * new ones appearing. A colon key reaching here now means either a grant
     * that predates the migration in a database it never ran against, or a
     * fifth spelling someone has just invented — and both should fail loudly
     * rather than be quietly accepted.
     */
    const { guard, context } = buildGuard({ ...SUB_ADMIN, permissions: ['kyc:review'] }, [
      'kyc.review',
    ]);
    await expect(guard.canActivate(context)).rejects.toThrow(/Missing permission/);
  });

  it('reads the metadata key the decorator writes', () => {
    expect(PERMISSIONS_KEY).toBe('required_permissions');
  });
});
