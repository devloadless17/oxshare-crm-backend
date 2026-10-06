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
  ibAccruals,
  ibApplications,
  roles,
  tradingAccounts,
  transactions,
  transfers,
  users,
  wallets,
} from '../src/database/schema';

/**
 * `?id=` on the four desks a notification deep link opens (withdrawals,
 * financial movements, IB applications, IB accruals).
 *
 * The security half is the point: the id is AND-ed with the reader's client
 * scope, so a scoped admin asking for an out-of-scope record's id gets the same
 * empty page as for an id that does not exist — never an existence oracle. And
 * a non-uuid is a 400 naming `id`, not a database cast error.
 */

const FULL = { email: 'idf-full@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'idf-scoped@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
const ids = { mine: {} as Record<string, string>, theirs: {} as Record<string, string> };

async function seedClient(tag: 'mine' | 'theirs', login: string) {
  const db = ctx.db.db;
  const [client] = await db
    .insert(users)
    .values({
      email: `idf-${tag}@oxshare-e2e.test`,
      passwordHash: 'x',
      firstName: 'Id',
      lastName: 'Filter',
    })
    .returning();
  const [wallet] = await db
    .insert(wallets)
    .values({ userId: client.id, currency: 'USD', balance: '0', onHold: '0' })
    .returning();
  const [account] = await db
    .insert(tradingAccounts)
    .values({
      userId: client.id,
      login,
      mt5Group: 'real\\Standard',
      environment: 'live',
      currency: 'USD',
      leverage: 100,
    })
    .returning();
  // A handled withdrawal: `?id=` must return it with no state filter.
  const [withdrawal] = await db
    .insert(transactions)
    .values({
      userId: client.id,
      walletId: wallet.id,
      direction: 'withdrawal',
      amount: '10.00000000',
      currency: 'USD',
      state: 'success',
      provider: 'manual_test',
      ...legacyRoute('manual_test', 'withdrawal'),
      providerRef: `idf-${tag}-wd`,
    })
    .returning();
  const [transfer] = await db
    .insert(transfers)
    .values({
      userId: client.id,
      walletId: wallet.id,
      tradingAccountId: account.id,
      direction: 'wallet_to_account',
      amount: '5.00000000',
      currency: 'USD',
      state: 'settled',
    })
    .returning();
  const [application] = await db
    .insert(ibApplications)
    .values({ userId: client.id, status: 'approved' })
    .returning();
  // A commission: the beneficiary (and so the scope column) is ib_user_id.
  const [accrual] = await db
    .insert(ibAccruals)
    .values({
      ibUserId: client.id,
      clientUserId: client.id,
      sourceType: 'deal',
      sourceId: crypto.randomUUID(),
      depth: 1,
      rateValue: '10.0000',
      baseAmount: '100.00000000',
      amount: '10.00000000',
      currency: 'USD',
    })
    .returning();
  ids[tag] = {
    withdrawal: withdrawal.id,
    transfer: transfer.id,
    application: application.id,
    accrual: accrual.id,
  };
  return client.id;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();
  const hash = await passwords.hash(FULL.password);

  const [fullRole] = await db
    .insert(roles)
    .values({ name: 'Idf Full', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: FULL.email,
    passwordHash: hash,
    name: 'Idf Full',
    role: 'sub_admin',
    roleId: fullRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });
  const [scopedRole] = await db
    .insert(roles)
    .values({ name: 'Idf Scoped', permissions: ALL_PERMISSIONS })
    .returning();
  const [scoped] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: hash,
      name: 'Idf Scoped',
      role: 'sub_admin',
      roleId: scopedRole.id,
      permissions: [],
      status: 'active',
    })
    .returning();

  const mineId = await seedClient('mine', '5199001');
  await seedClient('theirs', '5199002');
  const [tag] = await db
    .insert(clientTags)
    .values({ slug: 'idf-mine', label: 'Idf Mine' })
    .returning();
  await db.insert(clientTagAssignments).values({ userId: mineId, tagId: tag.id });
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: scoped.id, tagId: tag.id, createdBy: scoped.id });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** The page's rows, whatever the route calls them. */
const rowsOf = (body: Record<string, unknown>): unknown[] =>
  (body.items ?? body.rows ?? body.data) as unknown[];

const ROUTES = [
  { name: 'withdrawals', path: '/v1/admin/withdrawals', key: 'withdrawal' },
  { name: 'financial (payment arm)', path: '/v1/admin/transactions', key: 'withdrawal' },
  { name: 'financial (transfer arm)', path: '/v1/admin/transactions', key: 'transfer' },
  { name: 'ib applications', path: '/v1/admin/ib/applications', key: 'application' },
  { name: 'ib accruals', path: '/v1/admin/ib/accruals', key: 'accrual' },
];

describe('?id= narrows a desk to one record, inside the reader’s scope', () => {
  for (const r of ROUTES) {
    it(`${r.name}: returns exactly that record, handled or not`, async () => {
      const session = await actingAs(ctx, 'admin', FULL);
      const res = await session.get(`${r.path}?id=${ids.theirs[r.key]}`);
      expect(res.status).toBe(200);
      const rows = rowsOf(res.body as Record<string, unknown>);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).toContain(ids.theirs[r.key]);
    });

    it(`${r.name}: an out-of-scope id is an empty page, a mine id is not`, async () => {
      const session = await actingAs(ctx, 'admin', SCOPED);
      const outside = await session.get(`${r.path}?id=${ids.theirs[r.key]}`);
      expect(outside.status).toBe(200);
      expect(rowsOf(outside.body as Record<string, unknown>)).toHaveLength(0);
      // The control: an empty answer for everything would prove nothing.
      const inside = await session.get(`${r.path}?id=${ids.mine[r.key]}`);
      expect(rowsOf(inside.body as Record<string, unknown>)).toHaveLength(1);
    });

    it(`${r.name}: a non-uuid id is a 400 naming id`, async () => {
      const session = await actingAs(ctx, 'admin', FULL);
      const res = await session.get(`${r.path}?id=not-a-uuid`);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('id');
    });
  }
});
