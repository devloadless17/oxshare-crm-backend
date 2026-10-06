import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { legacyRoute } from './support/payment-route';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  admins,
  paymentMethods,
  roles,
  transactions,
  users,
  wallets,
} from '../src/database/schema';

/**
 * THE FINANCIAL PERIOD AND PAYMENT-METHOD FILTERS (the buyer's demo, 6 Oct 2026).
 *
 * The console sends the viewer's own day as instants with offset, `to`
 * EXCLUSIVE; a movement one second either side of the boundary must land on
 * the right side, in the list, the summary and the withdrawal desk alike.
 * The method filter narrows to the methods asked for, deposit or withdrawal,
 * and no transfer ever matches it.
 */

const ADMIN = { email: 'period-admin@oxshare.com', password: 'admin-password-123' };
const LIST = '/v1/admin/transactions';
const SUMMARY = '/v1/admin/transactions/summary';
const DESK = '/v1/admin/withdrawals';

let ctx: HttpTestContext;
let clientId: number;

// "Today" for a Beirut viewer: 6 Oct 2026 00:00 +03:00 → 7 Oct 00:00 +03:00.
const FROM = '2026-10-06T00:00:00+03:00';
const TO = '2026-10-07T00:00:00+03:00';

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const [role] = await db
    .insert(roles)
    .values({ name: 'Period Admin', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await new PasswordService().hash(ADMIN.password),
    name: 'Period Admin',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  const [client] = await db
    .insert(users)
    .values({
      email: 'period-client@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Per',
      lastName: 'Iod',
    })
    .returning();
  clientId = client.id;
  const [wallet] = await db
    .insert(wallets)
    .values({ userId: client.id, currency: 'USD', balance: '0', onHold: '0' })
    .returning();

  await db.insert(paymentMethods).values([
    {
      key: 'omt_period',
      name: 'OMT',
      internalLabel: 'OMT period',
      currency: 'USD',
      providerCode: 'manual',
      channelCode: 'offline',
    },
    {
      key: 'bank_period',
      name: 'Bank',
      internalLabel: 'Bank period',
      currency: 'USD',
      providerCode: 'manual',
      channelCode: 'offline',
    },
  ]);

  const deposit = (ref: string, at: string, methodKey: string) => ({
    userId: client.id,
    walletId: wallet.id,
    direction: 'deposit' as const,
    amount: '10.00000000',
    currency: 'USD',
    state: 'success' as const,
    provider: `manual_${methodKey}`,
    ...legacyRoute(`manual_${methodKey}`, 'deposit'),
    methodKey,
    providerRef: ref,
    createdAt: new Date(at),
  });
  await db.insert(transactions).values([
    // One second before the Beirut day starts (20:59:59 UTC on the 5th).
    deposit('before', '2026-10-05T20:59:59Z', 'omt_period'),
    // The first instant of it, and its last second — both inside.
    deposit('first', '2026-10-05T21:00:00Z', 'omt_period'),
    deposit('last', '2026-10-06T20:59:59Z', 'bank_period'),
    // The first instant of the next day — outside (`to` is exclusive).
    deposit('after', '2026-10-06T21:00:00Z', 'bank_period'),
  ]);
  await db.insert(transactions).values({
    userId: client.id,
    walletId: wallet.id,
    direction: 'withdrawal',
    amount: '5.00000000',
    currency: 'USD',
    state: 'pending',
    provider: 'manual_desk',
    ...legacyRoute('manual_desk', 'withdrawal'),
    providerRef: 'w-today',
    destination: 'x',
    createdAt: new Date('2026-10-06T08:00:00Z'),
  });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

type Page = { items: { providerRef?: string | null }[] };
const refs = (body: unknown) => (body as Page).items.map((i) => i.providerRef).sort();

describe('the period', () => {
  it('includes exactly the viewer’s day — first and last second in, the neighbours out', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session
      .get(
        `${LIST}?userId=${clientId}&direction=deposit&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=50`,
      )
      .expect(200);
    expect(refs(res.body)).toEqual(['first', 'last']);
  });

  it('the summary counts the same set, through the live rows (not UTC-day totals)', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session
      .get(`${SUMMARY}?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`)
      .expect(200);
    expect(JSON.stringify(res.body)).toContain('"20.00000000"');
  });

  it('a date-only period is a whole UTC day, to inclusive', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session
      .get(`${LIST}?userId=${clientId}&direction=deposit&from=2026-10-06&to=2026-10-06&limit=50`)
      .expect(200);
    expect(refs(res.body)).toEqual(['after', 'last']);
  });

  it('the withdrawal desk takes the same period', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const inside = await session
      .get(`${DESK}?state=pending&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`)
      .expect(200);
    expect(refs(inside.body)).toContain('w-today');
    const outside = await session
      .get(`${DESK}?state=pending&from=2026-10-01&to=2026-10-02`)
      .expect(200);
    expect((outside.body as Page).items).toHaveLength(0);
  });

  it('refuses a zoneless instant and a backwards period with a 400', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(`${LIST}?from=2026-10-06T08:00`).expect(400);
    await session.get(`${LIST}?from=2026-10-07&to=2026-10-06`).expect(400);
  });
});

describe('the payment method', () => {
  it('narrows to the methods asked for, several at once', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const omt = await session
      .get(`${LIST}?userId=${clientId}&method=omt_period&limit=50`)
      .expect(200);
    expect(refs(omt.body)).toEqual(['before', 'first']);
    const both = await session
      .get(`${LIST}?userId=${clientId}&method=omt_period,bank_period&limit=50`)
      .expect(200);
    expect(refs(both.body)).toEqual(['after', 'before', 'first', 'last']);
  });

  it('composes with the period', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session
      .get(
        `${LIST}?userId=${clientId}&method=bank_period&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=50`,
      )
      .expect(200);
    expect(refs(res.body)).toEqual(['last']);
  });

  it('refuses a malformed key list rather than ignoring it', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(`${LIST}?method=${encodeURIComponent("a'; drop")}`).expect(400);
  });
});
