import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthorizationError } from '../src/common/errors/domain-errors';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AdminAuditService } from '../src/modules/admin/admin-audit.service';
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
  permissions: ['*'],
  createdAt: new Date(),
};

const SUB_ADMIN: Admin = {
  id: 'sub-1',
  email: 'sub@oxshare.com',
  name: 'Sub Admin',
  passwordHash: 'x',
  role: 'sub_admin',
  permissions: ['roles.manage', 'roles.view'],
  createdAt: new Date(),
};

const CUSTOM_ROLE: Role = {
  id: 'role-1',
  name: 'Reviewer',
  permissions: ['kyc.review'],
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
    ...overrides.roles,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminRbacService,
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
  it('REGRESSION C1: a sub-admin cannot grant themselves the wildcard via updateRole', async () => {
    const { service, rolesFake } = await buildRbacService();

    await expect(service.updateRole('role-1', { permissions: ['*'] }, SUB_ADMIN)).rejects.toThrow(
      AuthorizationError,
    );

    // The point of the regression: the guard rejecting is not enough — the
    // write must not happen. With the missing `await`, update() still ran.
    expect(rolesFake.update).not.toHaveBeenCalled();
  });

  it('a sub-admin cannot grant a permission they do not themselves hold', async () => {
    const { service, rolesFake } = await buildRbacService();

    await expect(
      service.updateRole('role-1', { permissions: ['withdrawals.approve'] }, SUB_ADMIN),
    ).rejects.toThrow(AuthorizationError);
    expect(rolesFake.update).not.toHaveBeenCalled();
  });

  it('a sub-admin may grant a permission they do hold', async () => {
    const { service, rolesFake } = await buildRbacService();

    await service.updateRole('role-1', { permissions: ['roles.view'] }, SUB_ADMIN);
    expect(rolesFake.update).toHaveBeenCalledWith('role-1', { permissions: ['roles.view'] });
  });

  it('the master admin may grant the wildcard', async () => {
    const { service, rolesFake } = await buildRbacService();

    await service.updateRole('role-1', { permissions: ['*'] }, MASTER);
    expect(rolesFake.update).toHaveBeenCalled();
  });

  it('rejects permission keys that are not in the catalog', async () => {
    const { service, rolesFake } = await buildRbacService();

    await expect(
      service.updateRole('role-1', { permissions: ['definitely.not.real'] }, MASTER),
    ).rejects.toThrow(/Unknown permission key/);
    expect(rolesFake.update).not.toHaveBeenCalled();
  });

  it('applies the same guard on create, not just update', async () => {
    const { service, rolesFake } = await buildRbacService();

    await expect(service.createRole('Escalated', undefined, ['*'], SUB_ADMIN)).rejects.toThrow(
      AuthorizationError,
    );
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
        typ: TOKEN_KIND.access,
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
    };
    return new AdminAuthenticator(
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      admins as unknown as AdminsStore,
      roles as unknown as RolesStore,
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
    const { guard, context } = buildGuard(SUB_ADMIN, ['roles.manage', 'users.edit']);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('denies with 403, never 401 — a 401 would log the admin out (§8.8)', async () => {
    const { guard, context } = buildGuard(SUB_ADMIN, ['withdrawals.approve']);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('the wildcard satisfies anything', async () => {
    const { guard, context } = buildGuard(MASTER, ['withdrawals.approve']);
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
