import { randomUUID } from 'node:crypto';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles, users } from '../src/database/schema';

/**
 * The ceiling on the two routes that MINT money.
 *
 * Every other bound in `money-limits.ts` constrains money that already exists: a
 * withdrawal moves a balance out, a deposit declares an inbound transfer that a
 * human then confirms against a bank statement. `POST /admin/wallets/credit` and
 * the trading-account fund path are different in kind — they create balance from
 * nothing, with no provider, no statement and no second party.
 *
 * Their DTO accepts `^\d{1,20}(\.\d{1,8})?$`, and nothing downstream consulted a
 * maximum. So the whole protection against a mistyped zero was the operator
 * noticing — against an APPEND-ONLY ledger, where the correction is not a delete
 * but a compensating entry somebody writes after the client has already seen the
 * balance.
 *
 * This is NOT a permission test. `wallets.credit` exists, is deliberately its own
 * key, and is covered elsewhere. This is the bound that holds when the person IS
 * authorised and is simply wrong, which is the likelier of the two.
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

describe('a hand-credit is bounded, because it mints', () => {
  it('REFUSES an amount above the ceiling and changes no balance', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const before = await balanceOf(clientId);

    const res = await admin.post(
      '/v1/admin/wallets/credit',
      {
        userId: clientId,
        // One keystroke away from 50,000 — the actual failure this guards.
        amount: '500000.00000000',
        currency: 'USD',
        reason: 'The mistyped zero.',
      },
      idem(),
    );

    expect(res.status).toBe(400);
    // Naming the limit is the requirement, not merely refusing: an operator
    // refused without a number retries with another guess.
    expect(JSON.stringify(res.body)).toContain('50000');
    expect(await balanceOf(clientId)).toBe(before);
  });

  it('allows an ordinary credit well under the ceiling', async () => {
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
    expect(await balanceOf(clientId)).toBe('250.00000000');
  });

  /**
   * The boundary belongs in a test because "above" and "at or above" are one
   * character apart in the implementation and identical in every description of
   * it. A ceiling nobody may reach is a different rule from the one documented.
   */
  it('allows exactly the ceiling — the bound is ABOVE, not at', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.post(
      '/v1/admin/wallets/credit',
      {
        userId: clientId,
        amount: '50000.00000000',
        currency: 'USD',
        reason: 'Exactly at the ceiling, which is allowed.',
      },
      idem(),
    );

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    expect(await balanceOf(clientId)).toBe('50250.00000000');
  });
});
