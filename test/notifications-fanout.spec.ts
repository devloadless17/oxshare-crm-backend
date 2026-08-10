import { describe, expect, it, vi } from 'vitest';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { ClientNotFoundError } from '../src/common/errors/domain-errors';
import type { AdminsStore } from '../src/store/admins.store';
import type { RolesStore } from '../src/store/roles.store';
import type { AdminClientScopesStore } from '../src/store/admin-client-scopes.store';
import type { NotificationsStore } from '../src/store/notifications.store';
import type { ClientVisibilityService } from '../src/common/security/client-visibility.service';
import { UNRESTRICTED, scopeOf } from '../src/common/security/client-scope';

/**
 * The admin fan-out's two filters — permission and client scope — applied at
 * WRITE time. A wrong include here is a disclosure (a scoped admin holding a
 * row about a client outside their territory), which is why this is unit-pinned
 * separately from the storage contract.
 */

const CLIENT_ID = 'c1111111-1111-1111-1111-111111111111';

interface FakeAdmin {
  id: string;
  status: 'active' | 'suspended';
  roleId?: string;
  permissions: string[];
}

function build(opts: {
  admins: FakeAdmin[];
  /** roleId → live permission list. Missing id falls back to the snapshot. */
  rolePermissions?: Record<string, string[]>;
  /** adminId → tag ids ([] = unrestricted). */
  scopeTags?: Record<string, string[]>;
  /** adminIds whose scope covers CLIENT_ID. */
  visibleTo?: string[];
}) {
  const insertMany = vi.fn().mockResolvedValue(0);
  const service = new NotificationsService(
    { insertMany } as unknown as NotificationsStore,
    {
      findAll: vi.fn().mockResolvedValue({ rows: opts.admins, total: opts.admins.length }),
    } as unknown as AdminsStore,
    {
      resolvePermissions: vi
        .fn()
        .mockImplementation((roleId: string | undefined, snapshot: string[]) =>
          Promise.resolve((roleId && opts.rolePermissions?.[roleId]) || snapshot),
        ),
    } as unknown as RolesStore,
    {
      scopeFor: vi
        .fn()
        .mockImplementation((adminId: string) =>
          Promise.resolve(
            (opts.scopeTags?.[adminId] ?? []).length > 0
              ? scopeOf(opts.scopeTags?.[adminId] ?? [])
              : UNRESTRICTED,
          ),
        ),
    } as unknown as AdminClientScopesStore,
    {
      assertVisible: vi.fn().mockImplementation((clientId: string, scope) => {
        void clientId;
        void scope;
        return Promise.resolve();
      }),
    } as unknown as ClientVisibilityService,
  );
  return { service, insertMany };
}

describe('notifyAdminsWithPermission', () => {
  it('notifies only ACTIVE admins holding the permission, resolved live', async () => {
    const { service, insertMany } = build({
      admins: [
        { id: 'a1', status: 'active', permissions: ['withdrawals.approve'] },
        { id: 'a2', status: 'active', permissions: ['kyc.review'] },
        { id: 'a3', status: 'suspended', permissions: ['withdrawals.approve'] },
        // Role wins over a stale snapshot — the live resolution is the point.
        { id: 'a4', status: 'active', roleId: 'r1', permissions: ['withdrawals.approve'] },
      ],
      rolePermissions: { r1: ['clients.view'] },
    });

    await service.notifyAdminsWithPermission('withdrawals.approve', {
      kind: 'admin.withdrawal.requested',
      params: { transactionId: 't1', amount: '10.00000000', currency: 'USD' },
    });

    // One batched statement — a loop would strand recipients after a failure.
    expect(insertMany).toHaveBeenCalledTimes(1);
    const recipients = (insertMany.mock.calls[0][0] as { id: string }[]).map((r) => r.id);
    expect(recipients).toEqual(['a1']);
  });

  it('drops scoped admins whose territory does not cover the subject client', async () => {
    const visibility = {
      assertVisible: vi.fn().mockImplementation((clientId: string, scope) => {
        void clientId;
        // Only the tag 'north' covers this client.
        const tags = (scope as { tagIds: readonly string[] }).tagIds;
        return tags.includes('north')
          ? Promise.resolve()
          : Promise.reject(new ClientNotFoundError());
      }),
    };
    const insertMany = vi.fn().mockResolvedValue(0);
    const service = new NotificationsService(
      { insertMany } as unknown as NotificationsStore,
      {
        findAll: vi.fn().mockResolvedValue({
          rows: [
            { id: 'unrestricted', status: 'active', permissions: ['kyc.review'] },
            { id: 'in-territory', status: 'active', permissions: ['kyc.review'] },
            { id: 'out-of-territory', status: 'active', permissions: ['kyc.review'] },
          ],
          total: 3,
        }),
      } as unknown as AdminsStore,
      {
        resolvePermissions: vi
          .fn()
          .mockImplementation((_roleId: string | undefined, snapshot: string[]) =>
            Promise.resolve(snapshot),
          ),
      } as unknown as RolesStore,
      {
        scopeFor: vi.fn().mockImplementation((adminId: string) => {
          if (adminId === 'in-territory') return Promise.resolve(scopeOf(['north']));
          if (adminId === 'out-of-territory') return Promise.resolve(scopeOf(['south']));
          return Promise.resolve(UNRESTRICTED);
        }),
      } as unknown as AdminClientScopesStore,
      visibility as unknown as ClientVisibilityService,
    );

    await service.notifyAdminsWithPermission(
      'kyc.review',
      { kind: 'admin.kyc.submitted', params: { userId: CLIENT_ID } },
      { subjectClientId: CLIENT_ID },
    );

    const recipients = (insertMany.mock.calls[0][0] as { id: string }[]).map((r) => r.id);
    expect(recipients).toEqual(['unrestricted', 'in-territory']);
  });

  it('treats an INFRASTRUCTURE error during visibility as a failure to log, not a scoping decision', async () => {
    const insertMany = vi.fn().mockResolvedValue(0);
    const service = new NotificationsService(
      { insertMany } as unknown as NotificationsStore,
      {
        findAll: vi.fn().mockResolvedValue({
          rows: [{ id: 'scoped', status: 'active', permissions: ['kyc.review'] }],
          total: 1,
        }),
      } as unknown as AdminsStore,
      {
        resolvePermissions: vi
          .fn()
          .mockImplementation((_roleId: string | undefined, snapshot: string[]) =>
            Promise.resolve(snapshot),
          ),
      } as unknown as RolesStore,
      {
        scopeFor: vi.fn().mockResolvedValue(scopeOf(['north'])),
      } as unknown as AdminClientScopesStore,
      {
        // NOT a NotFoundError: the database blipped. Swallowing this as
        // "not visible" would silently drop the admin with no log anywhere.
        assertVisible: vi.fn().mockRejectedValue(new Error('connection reset')),
      } as unknown as ClientVisibilityService,
    );

    await expect(
      service.notifyAdminsWithPermission(
        'kyc.review',
        { kind: 'admin.kyc.submitted', params: {} },
        { subjectClientId: CLIENT_ID },
      ),
    ).resolves.toBeUndefined();
    // The failure aborted the sweep into the LOGGING catch — nothing was
    // written under a half-known recipient set.
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('NEVER throws — a fan-out failure must not fail the domain change behind it', async () => {
    const service = new NotificationsService(
      { insertMany: vi.fn() } as unknown as NotificationsStore,
      {
        findAll: vi.fn().mockRejectedValue(new Error('database gone')),
      } as unknown as AdminsStore,
      {} as unknown as RolesStore,
      {} as unknown as AdminClientScopesStore,
      {} as unknown as ClientVisibilityService,
    );

    await expect(
      service.notifyAdminsWithPermission('kyc.review', {
        kind: 'admin.kyc.submitted',
        params: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('post-commit notify() swallows storage failures; in-tx notify() propagates them', async () => {
    const failingStore = {
      insert: vi.fn().mockRejectedValue(new Error('insert failed')),
    } as unknown as NotificationsStore;
    const { service } = build({ admins: [] });
    const failing = new NotificationsService(
      failingStore,
      {} as unknown as AdminsStore,
      {} as unknown as RolesStore,
      {} as unknown as AdminClientScopesStore,
      {} as unknown as ClientVisibilityService,
    );
    void service;

    const input = {
      recipient: { kind: 'client' as const, id: 'u1' },
      kind: 'kyc.approved',
      params: {},
    };
    // Post-commit: the state change is already real; a missed row is UX.
    await expect(failing.notify(input)).resolves.toBeUndefined();
    // In-tx: a failure here is infrastructure failure and must fail the caller.
    await expect(
      failing.notify(input, {} as unknown as Parameters<typeof failing.notify>[1]),
    ).rejects.toThrow('insert failed');
  });
});
