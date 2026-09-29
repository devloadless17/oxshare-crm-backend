import { ALL_PERMISSIONS } from './support/all-permissions';
import { legacyRoute } from './support/payment-route';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { RivalClient } from '../src/modules/payments/rival/rival.client';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { admins, roles, transactions, users, wallets } from '../src/database/schema';

/** The money routes declare `@Idempotent()` and answer 400 without a key. */
const idem = () => ({ headers: { 'idempotency-key': randomUUID() } });

/**
 * Cancelling a withdrawal must not touch Rival unless the CANCEL WILL ACTUALLY
 * HAPPEN here.
 *
 * ## The bug this pins, and why nothing caught it
 *
 * `AdminMoneyService.cancelWithdrawal` called Rival FIRST — deliberately, and
 * with a good reason: if the payout can no longer be stopped, Rival's 409 must
 * abort the whole thing so nothing local changes. That reasoning is sound for
 * the case it was written for.
 *
 * What it missed is that the LOCAL step can refuse too. `markFailed` is what
 * enforces "only an approved withdrawal can be cancelled", and it runs after
 * the remote call. So cancelling a row that was already `success` cancelled the
 * PAYOUT AT RIVAL and only then answered 422:
 *
 *   - the desk saw a refusal and reasonably assumed nothing had happened
 *   - the CRM row stayed `success`, and the client had been emailed "paid"
 *   - the money never left Rival
 *
 * That is exactly the "cancelled there, paid here" split-brain this integration
 * exists to prevent, reached from the other direction — and the 4xx is what
 * makes it invisible, because the failure is dressed as a refusal.
 *
 * `rival-withdrawal-flow.spec.ts` covers `cancelApproved` thoroughly, which is
 * why this survived: the defect is in the ORDER ITS CALLER uses, and the caller
 * had no test. So this one drives the real HTTP route.
 *
 * The assertion is deliberately about the SIDE EFFECT rather than the status
 * code. A test asserting only "422" passes just as happily while Rival is being
 * cancelled behind it — which is the state that shipped.
 */

const ADMIN = { email: 'cancel-order-admin@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let rival: RivalClient;

/** A withdrawal already handed to Rival, in whatever local state we need. */
async function seedSubmitted(state: 'success' | 'failure' | 'pending') {
  const db = ctx.db.db;
  const [user] = await db
    .insert(users)
    .values({
      email: `cancel-order-${state}-${Date.now()}@test.local`,
      passwordHash: 'x',
      firstName: 'Cancel',
      lastName: 'Order',
      emailVerified: true,
    })
    .returning();
  const [wallet] = await db
    .insert(wallets)
    .values({ userId: user.id, currency: 'USD', balance: '100', onHold: '0' })
    .returning();
  const [tx] = await db
    .insert(transactions)
    .values({
      userId: user.id,
      walletId: wallet.id,
      direction: 'withdrawal',
      amount: '25',
      currency: 'USD',
      state,
      provider: 'whish',
      ...legacyRoute('whish', 'withdrawal'),
      destination: '+96170123456',
      // The row IS at Rival — without this `cancelApproved` returns early and
      // the test would pass for the wrong reason.
      rivalWithdrawalId: `rival-${state}-${Date.now()}`,
      rivalSubmittedAt: new Date(),
      ...(state === 'success' ? { settledAt: new Date(), providerRef: `ref-${Date.now()}` } : {}),
    })
    .returning();
  return tx.id;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;
  const [role] = await db
    .insert(roles)
    .values({ name: 'Cancel Order Admin', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Cancel Order Admin',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
    // The seeded clients carry no tags, so they are UNTRIAGED. Without this the
    // desk cannot see them and every assertion below is a 404 that proves
    // nothing about ordering.
    seesUntriaged: true,
    status: 'active',
  });
  rival = ctx.app.get(RivalClient);
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('cancelling a withdrawal only reaches Rival when the cancel is real', () => {
  it('a SETTLED row is refused WITHOUT cancelling the payout at Rival', async () => {
    const txId = await seedSubmitted('success');
    const session = await actingAs(ctx, 'admin', ADMIN);
    // Throws if reached, so a regression fails loudly rather than by a count.
    const spy = vi
      .spyOn(rival, 'cancelWithdrawal')
      .mockRejectedValue(
        new Error('Rival must not be asked to cancel a payout the CRM will refuse to cancel'),
      );

    const res = await session.patch(
      `/v1/admin/withdrawals/${txId}/cancel`,
      { reason: 'mis-click' },
      idem(),
    );

    expect(res.status).toBe(422);
    expect(String(res.body.message)).toMatch(/only an approved withdrawal can be cancelled/i);
    // THE assertion. Everything above can hold while this one is broken.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a FAILED row is refused the same way — already refunded, nothing to unwind', async () => {
    const txId = await seedSubmitted('failure');
    const session = await actingAs(ctx, 'admin', ADMIN);
    const spy = vi
      .spyOn(rival, 'cancelWithdrawal')
      .mockRejectedValue(new Error('must not be called'));

    const res = await session.patch(
      `/v1/admin/withdrawals/${txId}/cancel`,
      { reason: 'mis-click' },
      idem(),
    );

    expect(res.status).toBe(422);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a PENDING row is refused too — cancel un-does an APPROVAL, and there is none', async () => {
    const txId = await seedSubmitted('pending');
    const session = await actingAs(ctx, 'admin', ADMIN);
    const spy = vi
      .spyOn(rival, 'cancelWithdrawal')
      .mockRejectedValue(new Error('must not be called'));

    const res = await session.patch(
      `/v1/admin/withdrawals/${txId}/cancel`,
      { reason: 'too early' },
      idem(),
    );

    expect(res.status).toBe(422);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('an APPROVED row DOES reach Rival — the guard must not disarm the feature', async () => {
    const txId = await seedSubmitted('pending');
    // Promote it to approved the way the desk would leave it on the rail path.
    await ctx.db.db
      .update(transactions)
      .set({ state: 'approved' })
      .where(eq(transactions.id, txId));
    const session = await actingAs(ctx, 'admin', ADMIN);
    const spy = vi.spyOn(rival, 'cancelWithdrawal').mockResolvedValue(undefined as never);

    const res = await session.patch(
      `/v1/admin/withdrawals/${txId}/cancel`,
      { reason: 'desk change' },
      idem(),
    );

    expect(res.status).toBeLessThan(400);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
