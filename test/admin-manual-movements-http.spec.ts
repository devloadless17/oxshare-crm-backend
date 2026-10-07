/**
 * The desk's hand movements on a client (owner, 7 Oct 2026) — the client
 * profile's Deposit / Withdraw / Transfer actions.
 *
 * - `POST /admin/wallets/debit`: money LEAVES the platform from the wallet, as a
 *   completed manual withdrawal, never past the AVAILABLE balance.
 * - `POST /admin/trading-accounts/:id/fund` with `source`: a deposit from the
 *   SYSTEM mints, from the WALLET moves what the client holds; a withdrawal to
 *   the WALLET lands there, to the SYSTEM then leaves the platform.
 *
 * Driven through the real controllers, services and Postgres, with only the MT5
 * bridge faked — and the bridge can be switched to fail, so the "money stopped
 * at the wallet" path is exercised rather than assumed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles, tradingAccounts, users } from '../src/database/schema';
import { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import { EmailService } from '../src/modules/email/email.service';
import { emailRecorder } from './email-recorder';

const MASTER = { email: 'manual-moves-master@oxshare-e2e.test', password: 'Sup3rSecret!' };
const NO_DEBIT = { email: 'manual-moves-nodebit@oxshare-e2e.test', password: 'Sup3rSecret!' };

let ctx: HttpTestContext;
let clientId: number;
let accountId: string;
/** Flipped by a test to make the bridge's balance call fail (indeterminate). */
let bridgeDown = false;

const idem = (key = randomUUID()) => ({ headers: { 'idempotency-key': key } });

async function walletOf(userId: number): Promise<{ balance: string; onHold: string }> {
  const { rows } = await ctx.db.db.execute<{ balance: string; on_hold: string }>(sql`
    SELECT balance, on_hold FROM wallets WHERE user_id = ${userId} AND currency = 'USD' AND kind = 'main'
  `);
  return { balance: rows[0]?.balance ?? '0.00000000', onHold: rows[0]?.on_hold ?? '0.00000000' };
}

async function manualRows(direction: 'deposit' | 'withdrawal'): Promise<number> {
  const { rows } = await ctx.db.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM transactions
     WHERE user_id = ${clientId} AND provider = 'manual_admin' AND direction = ${direction}
  `);
  return rows[0].n;
}

/** Puts the client's main USD wallet at exactly `amount`, with nothing held. */
async function setWallet(amount: string) {
  const admin = await actingAs(ctx, 'admin', MASTER);
  const { balance } = await walletOf(clientId);
  await ctx.db.db.execute(sql`UPDATE wallets SET on_hold = 0 WHERE user_id = ${clientId}`);
  const diff = Number(amount) - Number(balance);
  if (diff > 0) {
    await admin
      .post(
        '/v1/admin/wallets/credit',
        { userId: clientId, amount: diff.toFixed(8), currency: 'USD', reason: 'Fixture top-up.' },
        idem(),
      )
      .expect(201);
  } else if (diff < 0) {
    await admin
      .post(
        '/v1/admin/wallets/debit',
        { userId: clientId, amount: (-diff).toFixed(8), currency: 'USD', reason: 'Fixture trim.' },
        idem(),
      )
      .expect(201);
  }
}

beforeAll(async () => {
  ctx = await startHttpTestApp({
    overrides: [
      { token: EmailService, value: emailRecorder().service },
      {
        token: Mt5BridgeClient,
        value: {
          isConfigured: true,
          balance: () =>
            bridgeDown
              ? Promise.reject(new Error('bridge unreachable'))
              : Promise.resolve({ dealId: String(Date.now()), replayed: false }),
          getAccount: () =>
            Promise.resolve({
              login: 5099101,
              balance: '1000.00',
              equity: '1000.00',
              currency: 'USD',
            }),
        },
      },
    ],
  });
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Manual Moves Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Manual Moves Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });
  const withoutDebit = ALL_PERMISSIONS.filter((key) => key !== 'wallets.debit');
  const [noDebitRole] = await db
    .insert(roles)
    .values({ name: 'Manual Moves No Debit', permissions: withoutDebit })
    .returning();
  await db.insert(admins).values({
    email: NO_DEBIT.email,
    passwordHash: await passwords.hash(NO_DEBIT.password),
    name: 'No Debit',
    role: 'sub_admin',
    roleId: noDebitRole.id,
    permissions: withoutDebit,
    status: 'active',
  });

  const [client] = await db
    .insert(users)
    .values({
      email: 'manual-moves-client@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Manual',
      lastName: 'Moves',
      verificationLevel: 1,
      emailVerified: true,
    })
    .returning();
  clientId = client.id;

  const [account] = await db
    .insert(tradingAccounts)
    .values({
      userId: clientId,
      login: '5099101',
      name: 'Manual Moves',
      mt5Group: 'real\\Standard',
      environment: 'live',
      currency: 'USD',
      balance: '1000.00000000',
    })
    .returning();
  accountId = account.id;
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

beforeEach(() => {
  bridgeDown = false;
});

describe('POST /admin/wallets/debit — money leaves the platform from the wallet', () => {
  it('debits the wallet and records a completed manual withdrawal', async () => {
    await setWallet('100');
    const before = await manualRows('withdrawal');
    const admin = await actingAs(ctx, 'admin', MASTER);

    const res = await admin.post(
      '/v1/admin/wallets/debit',
      { userId: clientId, amount: '40.00000000', currency: 'USD', reason: 'Paid out in cash.' },
      idem(),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.transaction.direction).toBe('withdrawal');
    expect(res.body.transaction.state).toBe('success');
    expect((await walletOf(clientId)).balance).toBe('60.00000000');
    expect(await manualRows('withdrawal')).toBe(before + 1);

    const { rows } = await ctx.db.db.execute<{ amount: string; entry_type: string }>(sql`
      SELECT amount, entry_type FROM ledger_entries WHERE reference_id = ${res.body.transaction.id}
    `);
    expect(rows).toEqual([{ amount: '-40.00000000', entry_type: 'withdrawal' }]);
  });

  it('withdraws once when the same request is replayed', async () => {
    await setWallet('100');
    const admin = await actingAs(ctx, 'admin', MASTER);
    const key = randomUUID();
    const body = { userId: clientId, amount: '10.00000000', currency: 'USD', reason: 'Replay.' };

    await admin.post('/v1/admin/wallets/debit', body, idem(key)).expect(201);
    await admin.post('/v1/admin/wallets/debit', body, idem(key));

    expect((await walletOf(clientId)).balance).toBe('90.00000000');
  });

  it('refuses more than the wallet holds, and moves nothing', async () => {
    await setWallet('50');
    const admin = await actingAs(ctx, 'admin', MASTER);

    const res = await admin.post(
      '/v1/admin/wallets/debit',
      { userId: clientId, amount: '50.00000001', currency: 'USD', reason: 'Too much.' },
      idem(),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.message).toMatch(/insufficient available balance/i);
    expect((await walletOf(clientId)).balance).toBe('50.00000000');
  });

  it('refuses money held by an in-flight transfer, with a sentence rather than a 500', async () => {
    await setWallet('60');
    await ctx.db.db.execute(sql`UPDATE wallets SET on_hold = 50 WHERE user_id = ${clientId}`);
    const admin = await actingAs(ctx, 'admin', MASTER);

    const res = await admin.post(
      '/v1/admin/wallets/debit',
      { userId: clientId, amount: '20.00000000', currency: 'USD', reason: 'Into the hold.' },
      idem(),
    );

    expect(res.status).toBeLessThan(500);
    expect(res.body.message).toMatch(/\$10\.00 available/);
    expect((await walletOf(clientId)).balance).toBe('60.00000000');
    await ctx.db.db.execute(sql`UPDATE wallets SET on_hold = 0 WHERE user_id = ${clientId}`);
  });

  it('refuses a withdrawal with no reason', async () => {
    await setWallet('20');
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.post(
      '/v1/admin/wallets/debit',
      { userId: clientId, amount: '5.00000000', currency: 'USD', reason: '   ' },
      idem(),
    );
    expect(res.status).toBe(400);
    expect((await walletOf(clientId)).balance).toBe('20.00000000');
  });

  it('403s for an admin without wallets.debit', async () => {
    await setWallet('20');
    const admin = await actingAs(ctx, 'admin', NO_DEBIT);
    const res = await admin.post(
      '/v1/admin/wallets/debit',
      { userId: clientId, amount: '5.00000000', currency: 'USD', reason: 'Not allowed.' },
      idem(),
    );
    expect(res.status).toBe(403);
    expect((await walletOf(clientId)).balance).toBe('20.00000000');
  });
});

describe('POST /admin/trading-accounts/:id/fund — where the money comes from and goes to', () => {
  const fund = (body: Record<string, unknown>, who = MASTER) =>
    actingAs(ctx, 'admin', who).then((admin) =>
      admin.post(`/v1/admin/trading-accounts/${accountId}/fund`, body, idem()),
    );

  it('a deposit FROM THE WALLET moves the client’s money and mints nothing', async () => {
    await setWallet('80');
    const minted = await manualRows('deposit');

    const res = await fund({
      amount: '30.00000000',
      reason: 'From their wallet.',
      direction: 'deposit',
      source: 'wallet',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.transfer.state).toBe('settled');
    expect(res.body.transaction).toBeNull();
    expect((await walletOf(clientId)).balance).toBe('50.00000000');
    expect(await manualRows('deposit')).toBe(minted);
  });

  it('a deposit from the wallet is refused past the wallet, before anything moves', async () => {
    await setWallet('10');
    const res = await fund({
      amount: '30.00000000',
      reason: 'More than they hold.',
      direction: 'deposit',
      source: 'wallet',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await walletOf(clientId)).toEqual({ balance: '10.00000000', onHold: '0.00000000' });
  });

  it('a deposit FROM THE SYSTEM (the default) mints, then moves it on', async () => {
    await setWallet('10');
    const minted = await manualRows('deposit');

    const res = await fund({ amount: '25.00000000', reason: 'New money.', direction: 'deposit' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.transaction.direction).toBe('deposit');
    expect(res.body.transfer.state).toBe('settled');
    expect(await manualRows('deposit')).toBe(minted + 1);
    // Credited and moved on: the wallet is where it was.
    expect((await walletOf(clientId)).balance).toBe('10.00000000');
  });

  it('a withdrawal TO THE WALLET (the default) lands there', async () => {
    await setWallet('10');
    const res = await fund({ amount: '15.00000000', reason: 'To wallet.', direction: 'withdraw' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.destination).toBe('wallet');
    expect((await walletOf(clientId)).balance).toBe('25.00000000');
  });

  it('a withdrawal TO THE SYSTEM leaves the platform: account → wallet → withdrawn', async () => {
    await setWallet('10');
    const paidOut = await manualRows('withdrawal');

    const res = await fund({
      amount: '15.00000000',
      reason: 'Out of the platform.',
      direction: 'withdraw',
      source: 'system',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.destination).toBe('system');
    expect(res.body.transferError).toBeNull();
    expect(res.body.transaction.direction).toBe('withdrawal');
    expect(await manualRows('withdrawal')).toBe(paidOut + 1);
    expect((await walletOf(clientId)).balance).toBe('10.00000000');
  });

  it('a withdrawal to the system whose transfer has not settled stops, and says so', async () => {
    await setWallet('10');
    const paidOut = await manualRows('withdrawal');
    bridgeDown = true;

    const res = await fund({
      amount: '15.00000000',
      reason: 'Bridge down.',
      direction: 'withdraw',
      source: 'system',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.transfer.state).toBe('pending');
    expect(res.body.transferError).toMatch(/has not reached the wallet yet/i);
    expect(await manualRows('withdrawal')).toBe(paidOut);
    expect((await walletOf(clientId)).balance).toBe('10.00000000');
    // Leave nothing in flight for the next case.
    await ctx.db.db.execute(
      sql`UPDATE transfers SET state = 'failed' WHERE trading_account_id = ${accountId} AND state = 'pending'`,
    );
  });

  it('a withdrawal to the system needs wallets.debit, and nothing moves without it', async () => {
    await setWallet('10');
    const res = await fund(
      { amount: '15.00000000', reason: 'No key.', direction: 'withdraw', source: 'system' },
      NO_DEBIT,
    );
    expect(res.status).toBe(403);
    expect((await walletOf(clientId)).balance).toBe('10.00000000');
  });

  it('refuses an unknown source', async () => {
    const res = await fund({
      amount: '1.00000000',
      reason: 'Bad source.',
      direction: 'deposit',
      source: 'bank',
    });
    expect(res.status).toBe(400);
  });
});
