import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyRoute } from './support/payment-route';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, paymentMethods, transactions, users, wallets } from '../src/database/schema';

/**
 * THE DEPOSIT DESK ON ITS OWN KEY, AND THE NEW EXPORTS (6 Oct 2026).
 *
 * The catalogue gives a deposit clerk `deposits.view` and says they must NOT be
 * handed every movement on the platform (`transactions.view`). The desk read
 * through `/admin/transactions` until today, so a clerk set up that way loaded
 * nothing. Now `/admin/deposits` serves the desk on its own key — and ONLY the
 * desk's rows: a clerk must not reach a withdrawal or a provider-settled deposit
 * through it. Each new export (deposits, ledger, commissions) is refused to a
 * reader without its list's key: an export must never be a way around a screen.
 */

const PASSWORD = 'admin-password-123';
const CLERK = { email: 'desk-clerk@oxshare.com', password: PASSWORD };
const OUTSIDER = { email: 'desk-outsider@oxshare.com', password: PASSWORD };

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const hash = await new PasswordService().hash(PASSWORD);
  await db.insert(admins).values([
    {
      email: CLERK.email,
      passwordHash: hash,
      name: 'Desk Clerk',
      role: 'sub_admin',
      // Exactly what the catalogue says a clerk is given — and sight of every client.
      permissions: ['deposits.view', 'deposits.approve'],
      seesAllClients: true,
      status: 'active',
    },
    {
      email: OUTSIDER.email,
      passwordHash: hash,
      name: 'Desk Outsider',
      role: 'sub_admin',
      permissions: ['clients.view'],
      seesAllClients: true,
      status: 'active',
    },
  ]);

  const [client] = await db
    .insert(users)
    .values({
      email: 'desk-client@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Desk',
      lastName: 'Client',
    })
    .returning();
  const [wallet] = await db
    .insert(wallets)
    .values({ userId: client.id, currency: 'USD', balance: '0', onHold: '0' })
    .returning();
  await db.insert(paymentMethods).values({
    key: 'omt_desk',
    name: 'OMT',
    internalLabel: 'OMT desk',
    currency: 'USD',
    providerCode: 'manual',
    channelCode: 'offline',
  });
  const base = { userId: client.id, walletId: wallet.id, currency: 'USD', amount: '10.00000000' };
  await db.insert(transactions).values([
    // The desk's: an offline deposit a person decides.
    {
      ...base,
      direction: 'deposit',
      state: 'pending',
      provider: 'manual_omt_desk',
      ...legacyRoute('manual_omt_desk', 'deposit'),
      methodKey: 'omt_desk',
      providerRef: 'desk-offline',
    },
    // NOT the desk's: a withdrawal, and a deposit a provider settles.
    {
      ...base,
      direction: 'withdrawal',
      state: 'pending',
      provider: 'manual_desk',
      ...legacyRoute('manual_desk', 'withdrawal'),
      providerRef: 'desk-withdrawal',
      destination: 'x',
    },
    {
      ...base,
      direction: 'deposit',
      state: 'pending',
      provider: 'whish',
      ...legacyRoute('whish', 'deposit'),
      providerRef: 'desk-hosted',
    },
  ]);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the deposit desk, on deposits.view', () => {
  it('serves a clerk the desk — and only the desk’s rows', async () => {
    const clerk = await actingAs(ctx, 'admin', CLERK);
    const res = await clerk.get('/v1/admin/deposits?limit=50').expect(200);
    const refs = (res.body as { items: { providerRef: string }[] }).items.map((i) => i.providerRef);
    expect(refs).toContain('desk-offline');
    expect(refs).not.toContain('desk-withdrawal');
    expect(refs).not.toContain('desk-hosted');
  });

  it('cannot widen to other movements by passing the Financial filters', async () => {
    const clerk = await actingAs(ctx, 'admin', CLERK);
    const res = await clerk.get('/v1/admin/deposits?direction=withdrawal&limit=50').expect(200);
    const refs = (res.body as { items: { providerRef: string }[] }).items.map((i) => i.providerRef);
    expect(refs).not.toContain('desk-withdrawal');
  });

  it('still refuses the clerk every movement on the platform', async () => {
    const clerk = await actingAs(ctx, 'admin', CLERK);
    await clerk.get('/v1/admin/transactions').expect(403);
  });

  it('exports the desk as a file, desk rows only', async () => {
    const clerk = await actingAs(ctx, 'admin', CLERK);
    const res = await clerk.get('/v1/admin/deposits/export?format=csv').expect(200);
    const text = res.text;
    expect(text).toContain('desk-offline');
    expect(text).not.toContain('desk-withdrawal');
    expect(text).not.toContain('desk-hosted');
  });
});

describe('every new export is refused without its list’s key', () => {
  it.each([
    '/v1/admin/deposits',
    '/v1/admin/deposits/export?format=csv',
    '/v1/admin/ledger/export?format=csv',
    '/v1/admin/ib/accruals/export?format=csv',
  ])('%s', async (path) => {
    const outsider = await actingAs(ctx, 'admin', OUTSIDER);
    await outsider.get(path).expect(403);
  });
});
