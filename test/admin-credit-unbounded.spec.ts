import { randomUUID } from 'node:crypto';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles, users } from '../src/database/schema';

/**
 * A hand-credit has NO ceiling, and that is deliberate (0168).
 *
 * ## What this file used to assert, and why it now asserts the opposite
 *
 * `max_admin_credit` bounded the two routes that MINT money — `POST
 * /admin/wallets/credit` and the trading-account fund path. Every other bound in
 * this system constrains money that already exists; those two create balance
 * from nothing, with no provider, no statement and no second party, so they
 * carried a ceiling against a mistyped zero.
 *
 * The owner removed it on 29 Sep 2026: the desk does not work to a per-action
 * ceiling, and a limit raised whenever it binds is a dialog, not a control.
 *
 * ## Why the removal is TESTED rather than simply done
 *
 * Because it is a decision, not an absence. The amount DTO accepts
 * `^\d{1,20}(\.\d{1,8})?$` and permission checks ask WHO may credit, never HOW
 * MUCH — so nothing else in the stack would notice a ceiling being reintroduced,
 * and nothing would notice it being left out either. A test that asserts a large
 * credit SUCCEEDS fails loudly the day somebody adds a bound back without asking,
 * which is exactly the conversation worth forcing.
 *
 * This is NOT a permission test. `wallets.credit` exists, is deliberately its own
 * key, and is covered elsewhere.
 *
 * Its own suite, with its own database, because it moves balances: folding these
 * into a journey spec made a later step's balance assertion fail — which is
 * itself the reminder that a credit is not a read.
 */

const MASTER = { email: 'credit-ceiling-master@oxshare-e2e.test', password: 'Sup3rSecret!' };

let ctx: HttpTestContext;
let clientId: number;

const idem = () => ({ headers: { 'idempotency-key': randomUUID() } });

const balanceOf = async (userId: number): Promise<string | undefined> => {
  const { rows } = await ctx.db.db.execute<{ balance: string }>(sql`
    SELECT balance FROM wallets WHERE user_id = ${userId} AND currency = 'USD'
  `);
  return rows[0]?.balance;
};

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Credit Ceiling Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Credit Ceiling Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  const [client] = await db
    .insert(users)
    .values({
      email: 'credit-ceiling-client@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Ceiling',
      lastName: 'Client',
    })
    .returning();
  clientId = client.id;
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a hand-credit is NOT bounded by an amount', () => {
  it('ACCEPTS an amount that the old ceiling would have refused', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);

    const res = await admin.post(
      '/v1/admin/wallets/credit',
      {
        userId: clientId,
        // Ten times the ceiling that used to stand here. The point of the
        // number is that it is one this endpoint once refused by policy.
        amount: '500000.00000000',
        currency: 'USD',
        reason: 'Above the ceiling that no longer exists.',
      },
      idem(),
    );

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    expect(await balanceOf(clientId)).toBe('500000.00000000');
  });

  it('allows an ordinary credit', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.post(
      '/v1/admin/wallets/credit',
      {
        userId: clientId,
        amount: '250.00000000',
        currency: 'USD',
        reason: 'An ordinary funding.',
      },
      idem(),
    );

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    // Cumulative: this suite shares one wallet, and the credit above landed.
    expect(await balanceOf(clientId)).toBe('500250.00000000');
  });

  /**
   * The reason a REASON is still required.
   *
   * Removing the ceiling took away the only thing that refused an amount, which
   * leaves the audit row as the whole record of a credit. That row is worth
   * nothing without the reason field, so the one remaining refusal on this path
   * is worth pinning: it is now load-bearing in a way it was not before.
   */
  it('still refuses a credit with no reason, which is now the only record', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const before = await balanceOf(clientId);

    const res = await admin.post(
      '/v1/admin/wallets/credit',
      { userId: clientId, amount: '10.00000000', currency: 'USD', reason: '   ' },
      idem(),
    );

    expect(res.status).toBe(400);
    expect(await balanceOf(clientId)).toBe(before);
  });
});
