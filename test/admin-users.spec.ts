import { ALL_PERMISSIONS } from './support/all-permissions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors/domain-errors';
import { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { ClientFieldsService } from '../src/modules/admin/client-fields.service';
import { RefreshTokensService } from '../src/common/security/refresh-tokens.service';
import { ApiKeysStore } from '../src/store/api-keys.store';
import { DRIZZLE_DB } from '../src/database/database.module';
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
  permissions: ALL_PERMISSIONS,
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
  /*
   * `admins.suspend`, not `clients.suspend` — suspending an ADMINISTRATOR is
   * its own key, separate from suspending a client. Stale since the rework.
   */
  permissions: ['admins.edit', 'admins.suspend', 'kyc.review'],
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
    // 0154's invariant: at least one active admin still sees every client.
    countActiveFullSight: vi.fn(() => Promise.resolve(1)),
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
    /*
     * Returns the real envelope, because `assertNotLastManager` destructures
     * `{ rows }` from it — the guard that stops a write leaving nobody able to
     * manage administrators.
     *
     * A bare `vi.fn()` resolves undefined, so every path through that guard
     * died on "Cannot destructure property 'rows'" and the tests reported it
     * as the wrong error type. The master is included so the system always has
     * one manager left and the guard's own refusal does not fire in cases that
     * are not about it.
     */
    findAll: vi.fn(() => Promise.resolve({ rows: [MASTER, OPERATOR, target], total: 3 })),
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
      {
        provide: InvitesStore,
        useValue: {
          findPendingByRoleId: vi.fn().mockResolvedValue([]),
          deletePendingByInviter: vi.fn().mockResolvedValue(0),
        },
      },
      { provide: RolesStore, useValue: rolesFake },
      { provide: AdminAuditService, useValue: auditFake },
      {
        provide: RefreshTokensService,
        useValue: { revokeAllForSubject: vi.fn().mockResolvedValue(0) },
      },
      {
        // Suspension also revokes the API keys the suspended admin minted. The
        // cases here assert who may suspend whom, not what suspension ends, so
        // a stub reporting nothing revoked is the honest shape.
        provide: ApiKeysStore,
        useValue: {
          revokeAllCreatedBy: vi.fn().mockResolvedValue(0),
          // An edit clamps the admin's keys to their new sight; none here.
          clampToCreator: vi.fn().mockResolvedValue(0),
        },
      },
      {
        provide: DRIZZLE_DB,
        useValue: {
          transaction: (fn: (tx: unknown) => Promise<unknown>) =>
            fn({ execute: () => Promise.resolve() }),
        },
      },
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
          // The scope a key is clamped to after an edit — unrestricted here.
          scopeFor: vi.fn().mockResolvedValue(UNRESTRICTED),
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

    expect(adminsFake.update).toHaveBeenCalledWith(
      TARGET.id,
      { name: 'Renamed' },
      expect.anything(),
    );
  });

  it('keeps the current name when the patch omits it', async () => {
    // `name: patch.name ?? admin.name` — a role-only patch must not blank it.
    const { service, adminsFake } = await build();
    await service.updateAdmin(TARGET.id, { roleId: 'role-1' }, MASTER);

    expect(adminsFake.update).toHaveBeenCalledWith(
      TARGET.id,
      expect.objectContaining({ name: TARGET.name }),
      expect.anything(),
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
      expect.anything(),
    );
  });

  it('granting direct permissions CLEARS the role', async () => {
    // The exclusivity rule. Leaving roleId set would mean the next edit of that
    // role silently overwrites the direct grants an operator just chose.
    const { service, adminsFake } = await build();
    await service.updateAdmin(TARGET.id, { permissions: ['ib.partners.view'] }, MASTER);

    expect(adminsFake.update).toHaveBeenCalledWith(
      TARGET.id,
      expect.objectContaining({ roleId: undefined, permissions: ['ib.partners.view'] }),
      expect.anything(),
    );
  });

  it('refuses to demote the LAST admins.edit holder to a role without it', async () => {
    /*
     * Suspending the last manager was already refused; moving them to a lesser
     * role produced the same outage and was not. The directory fake holds the
     * master (every key), the operator and the target — so the target is made
     * the sole holder by pointing the others at role-less snapshots without it.
     */
    const soleManager: Admin = { ...TARGET, permissions: ['admins.edit'], roleId: undefined };
    const { service, adminsFake } = await build({
      admin: { permissions: ['admins.edit'], roleId: undefined },
    });
    adminsFake.findAll.mockResolvedValue({
      rows: [
        { ...MASTER, permissions: ['kyc.review'] },
        { ...OPERATOR, permissions: ['kyc.review'] },
        soleManager,
      ],
      total: 3,
    });

    await expect(service.updateAdmin(TARGET.id, { roleId: 'role-1' }, MASTER)).rejects.toThrow(
      /no active administrator holding admins.edit/,
    );
    expect(adminsFake.update).not.toHaveBeenCalled();
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

  /*
   * The master is no longer special, and this asserts the rule that REPLACED
   * the one protecting it.
   *
   * This used to read "refuses to change the MASTER admin's access", on the
   * reasoning that the master was everyone else's recovery path. There is no
   * master to protect any more (see the service: "There is no master admin to
   * protect any more. What is protected is the SYSTEM"), so that rule became
   * two better ones — nobody rewrites their OWN access, whoever they are, and
   * no write may leave the directory unmanageable.
   *
   * Kept as a self-edit case because that is the escalation the old rule was
   * really standing in front of: a one-request privilege widening with no
   * permission change for anyone to notice in the audit log.
   */
  it('refuses ANY administrator rewriting their own access, master included', async () => {
    const { service } = await build();

    await expect(
      service.updateAdmin(MASTER.id, { permissions: ['kyc.review'] }, MASTER),
    ).rejects.toThrow(AuthorizationError);
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

    expect(adminsFake.update).toHaveBeenCalledWith(
      TARGET.id,
      { status: 'suspended' },
      expect.anything(),
    );
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
    const editorOnly: AuthenticatedAdmin = { ...OPERATOR, permissions: ['admins.edit'] };
    const { service, adminsFake } = await build();

    await expect(service.setAdminStatus(TARGET.id, 'suspended', editorOnly)).rejects.toThrow(
      AuthorizationError,
    );
    expect(adminsFake.update).not.toHaveBeenCalled();
  });

  it('lets a sub-admin holding users.suspend do it', async () => {
    const { service, adminsFake } = await build();
    await service.setAdminStatus(TARGET.id, 'suspended', OPERATOR);

    expect(adminsFake.update).toHaveBeenCalledWith(
      TARGET.id,
      { status: 'suspended' },
      expect.anything(),
    );
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

  /*
   * Again the replacement rule, not the removed one.
   *
   * Suspending the master used to be refused BECAUSE it was the master. What
   * is refused now is the write that would leave nobody holding `admins.edit`
   * — "the master admin used to be the way back, and there is none now". So
   * the master is suspendable while somebody else can still manage the
   * directory, and the LAST manager is not, whoever they are.
   *
   * Driven by narrowing the directory to one manager, which is the state the
   * guard is actually about.
   */
  it('refuses the suspension that would leave nobody able to manage administrators', async () => {
    const { service, adminsFake } = await build();
    // OPERATOR is the only remaining manager; suspending them locks the door
    // from the inside.
    adminsFake.findAll.mockResolvedValueOnce({ rows: [OPERATOR, TARGET], total: 2 });

    await expect(service.setAdminStatus(OPERATOR.id, 'suspended', MASTER)).rejects.toThrow(
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
