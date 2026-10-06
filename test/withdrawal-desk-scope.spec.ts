import { ALL_PERMISSIONS } from './support/all-permissions';
import { legacyRoute } from './support/payment-route';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  roles,
  transactions,
  users,
  wallets,
} from '../src/database/schema';

/**
 * The withdrawal DESK scopes its per-state COUNTS, not just its rows — the
 * defect the 13 Aug scoped walk found live and the code audit missed.
 *
 * The desk list was scoped correctly, but the `counts` map beside it (which
 * drives the tab totals and the nav badge) was aggregated over EVERY
 * withdrawal, ignoring the reader's territory. A scoped desk saw one row and a
 * badge of six — aggregate intelligence about clients outside their tags,
 * exactly the kind of leak row-level scoping exists to prevent, one level up.
 *
 * Real Postgres, because the property is the SQL: the count query now carries
 * the same `clientScopePredicate` as the row query.
 */

const MASTER = { email: 'wd-scope-master@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'wd-scope-scoped@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;

async function seedWithdrawal(userId: number, amount: string) {
  const db = ctx.db.db;
  const [wallet] = await db
    .insert(wallets)
    .values({ userId, currency: 'USD', balance: '0', onHold: '0' })
    .returning();
  await db.insert(transactions).values({
    userId,
    walletId: wallet.id,
    direction: 'withdrawal',
    amount,
    currency: 'USD',
    state: 'pending',
    provider: 'manual_test',
    ...legacyRoute('manual_test', 'withdrawal'),
    destination: 'test-destination',
  });
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'WD Scope Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'WD Scope Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  const [scopedRole] = await db
    .insert(roles)
    .values({ name: 'WD Scope Desk', permissions: ['clients.view', 'withdrawals.view'] })
    .returning();
  const [scopedAdmin] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: await passwords.hash(SCOPED.password),
      name: 'WD Scope Desk',
      role: 'sub_admin',
      roleId: scopedRole.id,
      permissions: [],
      // Restricted from intake so the untagged out-of-scope client is genuinely
      // out of reach — this file is about territory, not the intake pool.
      status: 'active',
    })
    .returning();

  const [tag] = await db
    .insert(clientTags)
    .values({ slug: 'wd-scope-mine', label: 'WD Scope Mine' })
    .returning();
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: scopedAdmin.id, tagId: tag.id, createdBy: scopedAdmin.id });

  const [mine] = await db
    .insert(users)
    .values({
      email: 'wd-mine@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Mine',
      lastName: 'C',
    })
    .returning();
  await db.insert(clientTagAssignments).values({ userId: mine.id, tagId: tag.id });

  // Three OUT-OF-SCOPE clients, each with a pending withdrawal, and one IN-scope.
  const [a] = await db
    .insert(users)
    .values({
      email: 'wd-out-a@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'OutA',
      lastName: 'C',
    })
    .returning();
  const [b] = await db
    .insert(users)
    .values({
      email: 'wd-out-b@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'OutB',
      lastName: 'C',
    })
    .returning();
  const [c] = await db
    .insert(users)
    .values({
      email: 'wd-out-c@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'OutC',
      lastName: 'C',
    })
    .returning();

  await seedWithdrawal(mine.id, '10.00000000');
  await seedWithdrawal(a.id, '20.00000000');
  await seedWithdrawal(b.id, '30.00000000');
  await seedWithdrawal(c.id, '40.00000000');
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

interface DeskBody {
  items: { userId: number }[];
  total: number;
  counts: Record<string, number>;
}
const deskBody = (res: { body: unknown }) => res.body as DeskBody;

describe('the withdrawal desk scopes its counts, not only its rows', () => {
  it('a scoped desk sees one pending row AND a pending count of one', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/withdrawals?state=pending&limit=100');
    expect(res.status).toBe(200);

    const b = deskBody(res);
    expect(b.items.length, 'the scoped desk saw more than its own territory').toBe(1);
    // The property: the tab/badge count must match the territory, not the platform.
    expect(b.counts['pending'], 'counts.pending leaked the whole platform').toBe(1);
    expect(b.counts['all'], 'counts.all leaked the whole platform').toBe(1);
  });

  it('a MASTER desk sees all four, proving the counts are about scope', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/withdrawals?state=pending&limit=100');
    const b = deskBody(res);
    expect(b.counts['pending']).toBe(4);
    expect(b.counts['all']).toBe(4);
  });
});

describe('who decided, on the desk', () => {
  /*
   * `reviewedBy` has been recorded on every approve, reject and settle since
   * the lifecycle existed, and no screen rendered it — the column holds a
   * uuid, and a uuid is not an answer to "who approved this". On a console
   * that splits `withdrawals.approve` from `withdrawals.settle` precisely so
   * two people can be required, the one screen showing the decision could name
   * neither of them.
   */
  it('resolves the reviewer to a NAME once a decision has been made', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);

    const pending = await session.get('/v1/admin/withdrawals?state=pending&limit=1');
    expect(pending.status).toBe(200);
    const target = (pending.body as { items: { id: string }[] }).items[0];
    expect(target, 'no pending withdrawal in the fixture to decide on').toBeTruthy();

    const rejected = await session.patch(
      `/v1/admin/withdrawals/${target.id}/reject`,
      { reason: 'Checking the reviewer name reaches the desk.' },
      // The money routes are `@Idempotent()` and refuse without a key.
      { headers: { 'idempotency-key': `desk-reviewer-name-${target.id}` } },
    );
    expect(rejected.status).toBe(200);

    const after = await session.get('/v1/admin/withdrawals?state=rejected&limit=50');
    const row = (
      after.body as { items: { id: string; reviewedByName: string | null }[] }
    ).items.find((r) => r.id === target.id);

    expect(row?.reviewedByName).toBe('WD Scope Master');
  });
});
