import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AdminService } from '../src/modules/admin/admin.service';
import {
  AdminAuthenticator,
  PermissionsGuard,
  PERMISSIONS_KEY,
} from '../src/modules/admin/guards/admin.guard';
import { AdminsStore, type Admin } from '../src/store/admins.store';
import { AuditLogStore } from '../src/store/audit-log.store';
import { InvitesStore } from '../src/store/admins.store';
import { KycConfigStore } from '../src/store/kyc-config.store';
import { RejectionReasonsStore } from '../src/store/rejection-reasons.store';
import { RolesStore, type Role } from '../src/store/roles.store';
import { UsersStore } from '../src/store/users.store';
import { KycService } from '../src/modules/compliance/kyc.service';
import { EmailService } from '../src/modules/email/email.service';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { ProgramsService } from '../src/modules/partners/programs.service';

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

async function buildAdminService(overrides: {
  roles?: Partial<RolesStore>;
  admins?: Partial<AdminsStore>;
} = {}) {
  const rolesFake = {
    findAll: vi.fn(),
    findById: vi.fn().mockResolvedValue(CUSTOM_ROLE),
    findByName: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(async (data: { permissions: string[] }) => ({ ...CUSTOM_ROLE, ...data })),
    update: vi.fn(async (id: string, patch: object) => ({ ...CUSTOM_ROLE, ...patch })),
    delete: vi.fn(),
    resolvePermissions: vi.fn(),
    ...overrides.roles,
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminService,
      { provide: JwtService, useValue: { sign: vi.fn(), verify: vi.fn() } },
      { provide: ConfigService, useValue: { get: vi.fn(), getOrThrow: vi.fn() } },
      { provide: KycService, useValue: {} },
      { provide: EmailService, useValue: { sendAdminInviteEmail: vi.fn() } },
      { provide: TransactionsService, useValue: {} },
      { provide: WalletService, useValue: {} },
      { provide: ProgramsService, useValue: {} },
      { provide: AdminsStore, useValue: { findById: vi.fn(), findByEmail: vi.fn(), update: vi.fn(), create: vi.fn(), findAll: vi.fn(), ...overrides.admins } },
      { provide: InvitesStore, useValue: { create: vi.fn(), findByToken: vi.fn(), markAccepted: vi.fn(), findPendingByRoleId: vi.fn().mockResolvedValue([]) } },
      { provide: UsersStore, useValue: {} },
      { provide: RolesStore, useValue: rolesFake },
      { provide: KycConfigStore, useValue: {} },
      { provide: AuditLogStore, useValue: { record: vi.fn(), findAll: vi.fn() } },
      { provide: RejectionReasonsStore, useValue: {} },
    ],
  }).compile();

  return { service: moduleRef.get(AdminService), rolesFake };
}

describe('AdminService anti-escalation', () => {
  it('REGRESSION C1: a sub-admin cannot grant themselves the wildcard via updateRole', async () => {
    const { service, rolesFake } = await buildAdminService();

    await expect(service.updateRole('role-1', { permissions: ['*'] }, SUB_ADMIN)).rejects.toThrow(
      ForbiddenException,
    );

    // The point of the regression: the guard rejecting is not enough — the
    // write must not happen. With the missing `await`, update() still ran.
    expect(rolesFake.update).not.toHaveBeenCalled();
  });

  it('a sub-admin cannot grant a permission they do not themselves hold', async () => {
    const { service, rolesFake } = await buildAdminService();

    await expect(
      service.updateRole('role-1', { permissions: ['withdrawals.approve'] }, SUB_ADMIN),
    ).rejects.toThrow(ForbiddenException);
    expect(rolesFake.update).not.toHaveBeenCalled();
  });

  it('a sub-admin may grant a permission they do hold', async () => {
    const { service, rolesFake } = await buildAdminService();

    await service.updateRole('role-1', { permissions: ['roles.view'] }, SUB_ADMIN);
    expect(rolesFake.update).toHaveBeenCalledWith('role-1', { permissions: ['roles.view'] });
  });

  it('the master admin may grant the wildcard', async () => {
    const { service, rolesFake } = await buildAdminService();

    await service.updateRole('role-1', { permissions: ['*'] }, MASTER);
    expect(rolesFake.update).toHaveBeenCalled();
  });

  it('rejects permission keys that are not in the catalog', async () => {
    const { service, rolesFake } = await buildAdminService();

    await expect(
      service.updateRole('role-1', { permissions: ['definitely.not.real'] }, MASTER),
    ).rejects.toThrow(/Unknown permission key/);
    expect(rolesFake.update).not.toHaveBeenCalled();
  });

  it('applies the same guard on create, not just update', async () => {
    const { service, rolesFake } = await buildAdminService();

    await expect(service.createRole('Escalated', undefined, ['*'], SUB_ADMIN)).rejects.toThrow(
      ForbiddenException,
    );
    expect(rolesFake.create).not.toHaveBeenCalled();
  });
});

describe('AdminAuthenticator', () => {
  function build(admin: Admin | undefined, rolePermissions?: string[]) {
    const jwt = { verify: vi.fn().mockReturnValue({ sub: admin?.id ?? 'ghost', role: 'sub_admin' }) };
    const config = { getOrThrow: vi.fn().mockReturnValue('test-secret') };
    const admins = { findById: vi.fn().mockResolvedValue(admin) };
    const roles = {
      resolvePermissions: vi
        .fn()
        .mockImplementation(async (_roleId: string | undefined, snapshot: string[]) =>
          rolePermissions ?? snapshot,
        ),
    };
    return new AdminAuthenticator(
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
      admins as unknown as AdminsStore,
      roles as unknown as RolesStore,
    );
  }

  const req = (cookies: Record<string, string>) => ({ cookies }) as never;

  it('rejects a request with no admin cookie', async () => {
    await expect(build(SUB_ADMIN).authenticate(req({}))).rejects.toThrow(UnauthorizedException);
  });

  it('REGRESSION C3: an unknown subject is rejected, never upgraded to the seeded master', async () => {
    // The old code fell back to findByEmail('admin@oxshare.com') here, so any
    // signed token with a stale `sub` became the master admin.
    await expect(
      build(undefined).authenticate(req({ admin_access_token: 'signed' })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('resolves permissions from the role live, not from the token snapshot', async () => {
    const authenticator = build({ ...SUB_ADMIN, roleId: 'role-1' }, ['kyc.review']);
    const admin = await authenticator.authenticate(req({ admin_access_token: 'signed' }));
    // Editing the role must take effect on the next request, with no re-login.
    expect(admin.permissions).toEqual(['kyc.review']);
  });
});

describe('PermissionsGuard', () => {
  function buildGuard(admin: Admin, required: string[] | undefined) {
    const authenticator = { authenticate: vi.fn().mockResolvedValue(admin) };
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(required) };
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

  it('allows a route with no @RequirePermissions', async () => {
    const { guard, context } = buildGuard(SUB_ADMIN, undefined);
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

  it('matches colon-style and dot-style keys interchangeably', async () => {
    const legacy = { ...SUB_ADMIN, permissions: ['KYC:Review'] };
    const { guard, context } = buildGuard(legacy, ['kyc.review']);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('reads the metadata key the decorator writes', () => {
    expect(PERMISSIONS_KEY).toBe('required_permissions');
  });
});
