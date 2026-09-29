import { describe, expect, it, vi } from 'vitest';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { ClientNotFoundError } from '../src/common/errors/domain-errors';
import type { AdminsStore } from '../src/store/admins.store';
import type { RolesStore } from '../src/store/roles.store';
import type { AdminClientScopesStore } from '../src/store/admin-client-scopes.store';
import type { NotificationsStore } from '../src/store/notifications.store';
import type { ClientVisibilityService } from '../src/common/security/client-visibility.service';
import { UNRESTRICTED, scopeOf } from '../src/common/security/client-scope';

/*
 * A lease this instance always wins. Leader election has its own suite; a lease
 * mocked to refuse here would make every case pass by never running the job.
 */
const alwaysLeads = () =>
  ({ run: (_n: string, _t: number, work: () => Promise<void>) => work() }) as never;

/**
 * The admin fan-out's two filters — permission and client scope — applied at
 * WRITE time, where they decide who is PUSHED a task (the read path applies
 * them again on every request; see notifications-read-scope.spec.ts). A wrong
 * include here is a disclosure (a toast about a client outside the reader's
 * territory), which is why this is unit-pinned separately from the storage
 * contract.
 *
 * Since migration 0140 the PERMISSION comes from the catalogue, never from the
 * call site — the kind names which keys qualify — and the SUBJECT is required,
 * so there is no unscoped fan-out left to test.
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
  const insertAdminTask = vi.fn().mockResolvedValue(0);
  const service = new NotificationsService(
    { insertAdminTask } as unknown as NotificationsStore,
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
        .mockImplementation(({ id: adminId }: { id: string }) =>
          Promise.resolve(
            (opts.scopeTags?.[adminId] ?? []).length > 0
              ? scopeOf(
                  opts.scopeTags?.[adminId] ?? [],
                  false,
                  (opts.scopeTags?.[adminId] ?? []).length === 0,
                )
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
    alwaysLeads(),
  );
  return { service, insertAdminTask };
}

describe('notifyAdmins', () => {
  it('rings ACTIVE admins holding ANY of the kind’s catalogue permissions, resolved live', async () => {
    const { service, insertAdminTask } = build({
      admins: [
        { id: 'a1', status: 'active', permissions: ['withdrawals.approve'] },
        { id: 'a2', status: 'active', permissions: ['kyc.review'] },
        { id: 'a3', status: 'suspended', permissions: ['withdrawals.approve'] },
        // Role wins over a stale snapshot — the live resolution is the point.
        { id: 'a4', status: 'active', roleId: 'r1', permissions: ['withdrawals.approve'] },
        /*
         * The recipient bug the catalogue fixed: approving a withdrawal PAYS,
         * which needs `withdrawals.settle`. The fan-out used to ring only
         * `withdrawals.approve` holders, so the admin who could actually
         * approve was never told.
         */
        { id: 'a5', status: 'active', permissions: ['withdrawals.settle'] },
      ],
      rolePermissions: { r1: ['clients.view'] },
    });

    await service.notifyAdmins({
      kind: 'admin.withdrawal.requested',
      params: { transactionId: 't1', amount: '10.00000000', currency: 'USD' },
      subject: { id: 't1', clientId: CLIENT_ID },
    });

    // One batched statement — a loop would strand recipients after a failure.
    expect(insertAdminTask).toHaveBeenCalledTimes(1);
    const [recipients, task] = insertAdminTask.mock.calls[0] as [string[], Record<string, unknown>];
    expect(recipients).toEqual(['a1', 'a5']);
    // The item's kind and its open-state rule come from the catalogue too.
    expect(task).toMatchObject({
      kind: 'admin.withdrawal.requested',
      subjectKind: 'transaction',
      subjectId: 't1',
      subjectUserId: CLIENT_ID,
      stillOpen: 'pending',
    });
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
    const insertAdminTask = vi.fn().mockResolvedValue(0);
    const service = new NotificationsService(
      { insertAdminTask } as unknown as NotificationsStore,
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
        // Takes the admin ROW since 0154 — matching on an id string made every admin
        // unrestricted here, and the refusal this case proves went unobserved.
        scopeFor: vi.fn().mockImplementation(({ id: adminId }: { id: string }) => {
          if (adminId === 'in-territory') return Promise.resolve(scopeOf(['north'], false, false));
          if (adminId === 'out-of-territory')
            return Promise.resolve(scopeOf(['south'], false, false));
          return Promise.resolve(UNRESTRICTED);
        }),
      } as unknown as AdminClientScopesStore,
      visibility as unknown as ClientVisibilityService,
      alwaysLeads(),
    );

    await service.notifyAdmins({
      kind: 'admin.kyc.submitted',
      params: { userId: CLIENT_ID },
      subject: { id: CLIENT_ID, clientId: CLIENT_ID },
    });

    const recipients = insertAdminTask.mock.calls[0][0] as string[];
    expect(recipients).toEqual(['unrestricted', 'in-territory']);
  });

  it('checks scope for EVERY kind — the payout disagreement used to skip it', async () => {
    const assertVisible = vi.fn().mockRejectedValue(new ClientNotFoundError());
    const insertAdminTask = vi.fn().mockResolvedValue(0);
    const service = new NotificationsService(
      { insertAdminTask } as unknown as NotificationsStore,
      {
        findAll: vi.fn().mockResolvedValue({
          rows: [{ id: 'scoped', status: 'active', permissions: ['withdrawals.settle'] }],
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
        scopeFor: vi.fn().mockResolvedValue(scopeOf(['south'], false, false)),
      } as unknown as AdminClientScopesStore,
      { assertVisible } as unknown as ClientVisibilityService,
      alwaysLeads(),
    );

    await service.notifyAdmins({
      kind: 'withdrawal.rival_attention',
      params: { transactionId: 't1', ourState: 'success', event: 'rejected' },
      subject: { id: 't1', clientId: CLIENT_ID },
    });

    expect(assertVisible).toHaveBeenCalledWith(CLIENT_ID, expect.anything());
    expect(insertAdminTask.mock.calls[0][0]).toEqual([]);
  });

  it('treats an INFRASTRUCTURE error during visibility as a failure to log, not a scoping decision', async () => {
    const insertAdminTask = vi.fn().mockResolvedValue(0);
    const service = new NotificationsService(
      { insertAdminTask } as unknown as NotificationsStore,
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
        scopeFor: vi.fn().mockResolvedValue(scopeOf(['north'], false, false)),
      } as unknown as AdminClientScopesStore,
      {
        // NOT a NotFoundError: the database blipped. Swallowing this as
        // "not visible" would silently drop the admin with no log anywhere.
        assertVisible: vi.fn().mockRejectedValue(new Error('connection reset')),
      } as unknown as ClientVisibilityService,
      alwaysLeads(),
    );

    await expect(
      service.notifyAdmins({
        kind: 'admin.kyc.submitted',
        params: {},
        subject: { id: CLIENT_ID, clientId: CLIENT_ID },
      }),
    ).resolves.toBeUndefined();
    // The failure aborted the sweep into the LOGGING catch — nothing was
    // written under a half-known recipient set.
    expect(insertAdminTask).not.toHaveBeenCalled();
  });

  it('NEVER throws — a fan-out failure must not fail the domain change behind it', async () => {
    const service = new NotificationsService(
      { insertAdminTask: vi.fn() } as unknown as NotificationsStore,
      {
        findAll: vi.fn().mockRejectedValue(new Error('database gone')),
      } as unknown as AdminsStore,
      {} as unknown as RolesStore,
      {} as unknown as AdminClientScopesStore,
      {} as unknown as ClientVisibilityService,
      alwaysLeads(),
    );

    await expect(
      service.notifyAdmins({
        kind: 'admin.kyc.submitted',
        params: {},
        subject: { id: CLIENT_ID, clientId: CLIENT_ID },
      }),
    ).resolves.toBeUndefined();
  });

  it('post-commit notify() swallows storage failures; in-tx notify() propagates them', async () => {
    const failingStore = {
      insert: vi.fn().mockRejectedValue(new Error('insert failed')),
    } as unknown as NotificationsStore;
    const failing = new NotificationsService(
      failingStore,
      {} as unknown as AdminsStore,
      {} as unknown as RolesStore,
      {} as unknown as AdminClientScopesStore,
      {} as unknown as ClientVisibilityService,
      alwaysLeads(),
    );

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
