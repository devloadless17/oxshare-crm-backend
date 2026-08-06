import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors/domain-errors';
import { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { ClientFieldsService } from '../src/modules/admin/client-fields.service';
import { AdminRbacService } from '../src/modules/admin/admin-rbac.service';
import { AdminsStore, InvitesStore, type Admin } from '../src/store/admins.store';
import { RolesStore, type Role } from '../src/store/roles.store';
import type { AuthenticatedAdmin } from '../src/modules/admin/guards/admin.guard';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import { EMPTY_MASK } from '../src/common/security/field-mask';
import { ClientTagsStore } from '../src/store/client-tags.store';
import { AdminClientScopesStore } from '../src/store/admin-client-scopes.store';

/**
 * The admin DIRECTORY half of RBAC — `updateAdmin` and `setAdminStatus`.
 *
 * `test/rbac.spec.ts` covers roles and the anti-escalation guard. It does not
 * touch either method here: before this file, `updateAdmin` — the endpoint that
 * changes what a named administrator may do — had **no test at all**, and
 * `setAdminStatus` did not exist.
 *
 * Two properties are worth stating plainly, because both are load-bearing and
 * neither is obvious from the call site:
 *
 *  1. `roleId` and direct `permissions` are EXCLUSIVE. Setting a role copies its
 *     permissions onto the admin and records the roleId; setting permissions
 *     directly clears the roleId. An admin carrying both would have two answers
 *     to "what may this person do", and role edits propagate to holders — so the
 *     stale one would win or lose depending on which code path read it.
 *
 *  2. Suspension is the reversible alternative to deleting an administrator.
 *     Deleting destroys the subject every audit_log row points at; that is why
 *     `admins.status` exists, and why this service can never delete instead.
 */

/*
 * `AuthenticatedAdmin`: what the guard puts on the request, and what every
 * access-changing service method now demands. Unrestricted and unmasked here —
 * these specs are about permissions and anti-escalation, so the two visibility
 * dimensions are held constant rather than left undefined. The scope-specific
 * cases state their own.
 */
const MASTER: AuthenticatedAdmin = {
  id: 'master-1',
  email: 'admin@oxshare.com',
  name: 'Master Admin',
  passwordHash: 'x',
  role: 'master_admin',
  status: 'active',
  permissions: ['*'],
  clientScope: UNRESTRICTED,
  fieldMask: EMPTY_MASK,
  createdAt: new Date(),
};

/** Holds users.edit + users.suspend, but deliberately NOT ib.approve. */
const OPERATOR: AuthenticatedAdmin = {
  id: 'op-1',
  email: 'ops@oxshare.com',
  name: 'Ops Admin',
  passwordHash: 'x',
  role: 'sub_admin',
  status: 'active',
  permissions: ['users.edit', 'users.suspend', 'kyc.review'],
  clientScope: UNRESTRICTED,
  fieldMask: EMPTY_MASK,
  createdAt: new Date(),
};

const TARGET: Admin = {
  id: 'target-1',
  email: 'sub@oxshare.com',
  name: 'Sub Admin',
  passwordHash: 'x',
  role: 'sub_admin',
  status: 'active',
  permissions: ['kyc.review'],
  roleId: 'role-1',
  createdAt: new Date(),
};

const CUSTOM_ROLE: Role = {
  id: 'role-1',
  name: 'Reviewer',
  permissions: ['kyc.review'],
  maskedFields: [],
  isSystem: false,
  createdAt: new Date(),
};

async function build(overrides: { admin?: Partial<Admin>; role?: Role | undefined } = {}) {
  const target = { ...TARGET, ...overrides.admin };

  const adminsFake = {
    findById: vi.fn((id: string) =>
      Promise.resolve(
        id === MASTER.id
          ? MASTER
          : id === OPERATOR.id
            ? OPERATOR
            : id === target.id
              ? target
              : null,
      ),
    ),
    findByEmail: vi.fn(),
    findAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn((_id: string, patch: Partial<Admin>) => Promise.resolve({ ...target, ...patch })),
  };

  const rolesFake = {
    findAll: vi.fn(),
    findById: vi.fn().mockResolvedValue('role' in overrides ? overrides.role : CUSTOM_ROLE),
    findByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    // sanitize() resolves the LIVE permission set; echo whatever it is handed.
    resolveMaskedFields: vi.fn().mockResolvedValue([]),
    resolvePermissions: vi.fn((_roleId: string | undefined, direct: string[]) =>
      Promise.resolve(direct),
    ),
  };

  const auditFake = { record: vi.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminRbacService,
      { provide: AdminsStore, useValue: adminsFake },
      { provide: InvitesStore, useValue: { findPendingByRoleId: vi.fn().mockResolvedValue([]) } },
      { provide: RolesStore, useValue: rolesFake },
      { provide: AdminAuditService, useValue: auditFake },
      // Real, not a fake: it reads a committed JSON file and has no dependencies,
      // so substituting it would only let a mask key that the catalog rejects
      // pass here and fail in production.
      ClientFieldsService,
      // The two visibility stores. Fakes rather than omissions, so the DI graph
      // matches the real one and the scope cases below have somewhere to hook in.
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
    ],
  }).compile();

  return {
    service: moduleRef.get(AdminRbacService),
    adminsFake,
    rolesFake,
    auditFake,
    target,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('updateAdmin — changing what an administrator may do', () => {
  it('renames without touching access', async () => {
    const { service, adminsFake } = await build();
    await service.updateAdmin(TARGET.id, { name: 'Renamed' }, MASTER);

    expect(adminsFake.update).toHaveBeenCalledWith(TARGET.id, { name: 'Renamed' });
  });

  it('keeps the current name when the patch omits it', async () => {
    // `name: patch.name ?? admin.name` — a role-only patch must not blank it.
    const { service, adminsFake } = await build();
    await service.updateAdmin(TARGET.id, { roleId: 'role-1' }, MASTER);

    expect(adminsFake.update).toHaveBeenCalledWith(
      TARGET.id,
      expect.objectContaining({ name: TARGET.name }),
    );
  });

  it('assigning a role COPIES its permissions onto the admin', async () => {
    // Not a reference: the guard reads admins.permissions, so the role's set is
    // materialised here and re-materialised whenever the role is edited.
    const { service, adminsFake } = await build();
    await service.updateAdmin(TARGET.id, { roleId: 'role-1' }, MASTER);

    expect(adminsFake.update).toHaveBeenCalledWith(
      TARGET.id,
      expect.objectContaining({ roleId: 'role-1', permissions: CUSTOM_ROLE.permissions }),
    );
  });

  it('granting direct permissions CLEARS the role', async () => {
    // The exclusivity rule. Leaving roleId set would mean the next edit of that
    // role silently overwrites the direct grants an operator just chose.
    const { service, adminsFake } = await build();
    await service.updateAdmin(TARGET.id, { permissions: ['ib.view'] }, MASTER);

    expect(adminsFake.update).toHaveBeenCalledWith(
      TARGET.id,
      expect.objectContaining({ roleId: undefined, permissions: ['ib.view'] }),
    );
  });

  it('refuses a role the actor could not grant directly (anti-escalation)', async () => {
    // The regression test/rbac.spec.ts exists for, on the path it did NOT cover:
    // routing an over-grant through a role rather than through permissions.
    const { service, adminsFake } = await build({
      role: { ...CUSTOM_ROLE, permissions: ['ib.approve'] },
    });

    await expect(service.updateAdmin(TARGET.id, { roleId: 'role-1' }, OPERATOR)).rejects.toThrow(
      AuthorizationError,
    );
    expect(adminsFake.update).not.toHaveBeenCalled();
  });

  it('refuses direct permissions the actor does not hold', async () => {
    const { service, adminsFake } = await build();

    await expect(
      service.updateAdmin(TARGET.id, { permissions: ['ib.approve'] }, OPERATOR),
    ).rejects.toThrow(AuthorizationError);
    expect(adminsFake.update).not.toHaveBeenCalled();
  });

  it('lets an actor grant what it does hold', async () => {
    const { service, adminsFake } = await build();
    await service.updateAdmin(TARGET.id, { permissions: ['kyc.review'] }, OPERATOR);

    expect(adminsFake.update).toHaveBeenCalled();
  });

  it('refuses to change the MASTER admin’s access', async () => {
    // The master is everyone else's recovery path.
    const { service } = await build();

    await expect(
      service.updateAdmin(MASTER.id, { permissions: ['kyc.review'] }, MASTER),
    ).rejects.toThrow(ValidationError);
  });

  it('allows renaming the master, which changes no access', async () => {
    const { service, adminsFake } = await build();
    await service.updateAdmin(MASTER.id, { name: 'Renamed Master' }, MASTER);

    expect(adminsFake.update).toHaveBeenCalled();
  });

  it('refuses to let anyone rewrite their OWN access', async () => {
    // Keeps every permission change attributable to someone else's decision.
    const { service } = await build();

    await expect(
      service.updateAdmin(OPERATOR.id, { permissions: ['kyc.review'] }, OPERATOR),
    ).rejects.toThrow(AuthorizationError);
  });

  it('reports an unknown admin rather than creating one', async () => {
    const { service } = await build();
    await expect(
      service.updateAdmin('11111111-1111-1111-1111-111111111111', { name: 'x' }, MASTER),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('setAdminStatus — cutting off an administrator', () => {
  it('suspends, and says so in the audit log', async () => {
    const { service, adminsFake, auditFake } = await build();
    await service.setAdminStatus(TARGET.id, 'suspended', MASTER);

    expect(adminsFake.update).toHaveBeenCalledWith(TARGET.id, { status: 'suspended' });
    expect(auditFake.record).toHaveBeenCalledWith(
      MASTER.id,
      'admin.suspend',
      'admin',
      TARGET.id,
      expect.objectContaining({ before: 'active', after: 'suspended' }),
    );
  });

  it('reactivates, under a distinct audit action', async () => {
    // Distinct verbs: "someone was cut off" and "someone was let back in" are
    // different events to anyone reading the log after an incident.
    const { service, auditFake } = await build({ admin: { status: 'suspended' } });
    await service.setAdminStatus(TARGET.id, 'active', MASTER);

    expect(auditFake.record).toHaveBeenCalledWith(
      MASTER.id,
      'admin.activate',
      'admin',
      TARGET.id,
      expect.objectContaining({ before: 'suspended', after: 'active' }),
    );
  });

  it('refuses without users.suspend, even holding users.edit', async () => {
    // Editing someone's permissions and revoking their access are different
    // powers. An operator with only users.edit must not be able to do this.
    const editorOnly: AuthenticatedAdmin = { ...OPERATOR, permissions: ['users.edit'] };
    const { service, adminsFake } = await build();

    await expect(service.setAdminStatus(TARGET.id, 'suspended', editorOnly)).rejects.toThrow(
      AuthorizationError,
    );
    expect(adminsFake.update).not.toHaveBeenCalled();
  });

  it('lets a sub-admin holding users.suspend do it', async () => {
    const { service, adminsFake } = await build();
    await service.setAdminStatus(TARGET.id, 'suspended', OPERATOR);

    expect(adminsFake.update).toHaveBeenCalledWith(TARGET.id, { status: 'suspended' });
  });

  it('refuses suspending YOURSELF', async () => {
    // Suspension bites on the next request, so this is an administrator locking
    // themselves out mid-session — and the account that could undo it is the
    // one just disabled.
    const { service, adminsFake } = await build();

    await expect(service.setAdminStatus(OPERATOR.id, 'suspended', OPERATOR)).rejects.toThrow(
      AuthorizationError,
    );
    expect(adminsFake.update).not.toHaveBeenCalled();
  });

  it('refuses suspending the MASTER admin', async () => {
    const { service, adminsFake } = await build();

    await expect(service.setAdminStatus(MASTER.id, 'suspended', OPERATOR)).rejects.toThrow(
      ValidationError,
    );
    expect(adminsFake.update).not.toHaveBeenCalled();
  });

  it('refuses a no-op rather than writing a misleading audit row', async () => {
    // "Already suspended" in the log reads as a second incident that never
    // happened. Clients behave the same way (admin-clients.service.ts).
    const { service, adminsFake, auditFake } = await build({ admin: { status: 'suspended' } });

    await expect(service.setAdminStatus(TARGET.id, 'suspended', MASTER)).rejects.toThrow(
      ValidationError,
    );
    expect(adminsFake.update).not.toHaveBeenCalled();
    expect(auditFake.record).not.toHaveBeenCalled();
  });

  it('reports an unknown admin', async () => {
    const { service } = await build();
    await expect(
      service.setAdminStatus('11111111-1111-1111-1111-111111111111', 'suspended', MASTER),
    ).rejects.toThrow(NotFoundError);
  });

  it('returns the admin with the new status, never a password hash', async () => {
    // sanitize() is an allow-list; status joining it is the whole reason the
    // directory can stop rendering a hardcoded "Active".
    const { service } = await build();
    const result = await service.setAdminStatus(TARGET.id, 'suspended', MASTER);

    expect(result.status).toBe('suspended');
    expect(result).not.toHaveProperty('passwordHash');
  });
});
