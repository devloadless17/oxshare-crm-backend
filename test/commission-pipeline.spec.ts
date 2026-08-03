import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import {
  commissionAccruals,
  ibProfiles,
  ibPrograms,
  referralAttributions,
  tradingAccounts,
  users,
} from '../src/database/schema';
import { CommissionService } from '../src/modules/partners/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { money } from '../src/modules/wallet/money';

// ARCHITECTURE §11 reconciliation, in its full form:
// "Replay a fixture set of closed deals through the full pipeline and assert
//  that the sum of all ledger entries per wallet equals the wallet balance,
//  to the cent."
//
// Plus the idempotency half: "deliver the same deal twice — balances must be
// identical after the second delivery."

let ctx: MoneyTestContext;
let wallets: WalletService;
let commission: CommissionService;

let l1UserId: string;
let l2UserId: string;
let clientUserId: string;
let programId: string;

const MT5_LOGIN = '500001';
const CLOSED_AT = new Date('2026-08-01T10:00:00Z');

async function makeUser(email: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({ email, passwordHash: 'x', firstName: 'Test', lastName: email.split('@')[0] })
    .returning();
  return row.id;
}

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  resetDb();
  wallets = new WalletService();
  commission = new CommissionService(wallets);

  // A two-level IB structure: client → L1 → L2
  l2UserId = await makeUser('l2@test.local');
  l1UserId = await makeUser('l1@test.local');
  clientUserId = await makeUser('client@test.local');

  const [program] = await ctx.db
    .insert(ibPrograms)
    .values({
      name: 'Pipeline Test Plan',
      mode: 'commission',
      method: 'spread_share',
      commissionValue: '30', // 30% of spread revenue
      rebateValue: '0',
      l1Share: '70',
      l2Share: '30',
      settlementWindowHours: 24,
    })
    .returning();
  programId = program.id;

  await ctx.db.insert(ibProfiles).values([
    { userId: l2UserId, parentIbId: null, programId, status: 'approved' },
    { userId: l1UserId, parentIbId: l2UserId, programId, status: 'approved' },
  ]);
  await ctx.db
    .insert(referralAttributions)
    .values({ clientUserId, ibUserId: l1UserId, active: true });
  await ctx.db
    .insert(tradingAccounts)
    .values({ userId: clientUserId, mt5Login: MT5_LOGIN, environment: 'live' });
});

afterAll(async () => {
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

// spread × volume × 30%, then split 70/30
const FIXTURE = [
  { ticket: 'T-1', volume: '1', spread: '2.0' },      // pool 0.60
  { ticket: 'T-2', volume: '2.5', spread: '1.4' },    // pool 1.05
  { ticket: 'T-3', volume: '0.01', spread: '3.33' },  // pool 0.009999
  { ticket: 'T-4', volume: '100', spread: '0.7' },    // pool 21.00
];

const poolOf = (f: { volume: string; spread: string }) =>
  new Decimal(f.spread).times(f.volume).times(30).dividedBy(100);

describe('§8.6 pipeline — ingest, accrue, confirm', () => {
  it('ingests the fixture and accrues exactly two legs per deal', async () => {
    for (const f of FIXTURE) {
      const result = await commission.ingestAndAccrue({
        mt5Ticket: f.ticket,
        mt5Login: MT5_LOGIN,
        symbol: 'EURUSD',
        volume: f.volume,
        spread: f.spread,
        closedAt: CLOSED_AT,
      });
      expect(result.created, `${f.ticket} should be new`).toBe(true);
      expect(result.accruals, `${f.ticket} should pay L1 and L2`).toHaveLength(2);
    }

    const all = await ctx.db.select().from(commissionAccruals);
    expect(all).toHaveLength(FIXTURE.length * 2);
    expect(all.every((a) => a.status === 'accrued')).toBe(true);
  });

  it('holds accruals until the settlement window elapses', async () => {
    // One hour after close, with a 24h window — nothing is due yet.
    const tooEarly = new Date(CLOSED_AT.getTime() + 60 * 60 * 1000);
    const result = await commission.confirmMatured(tooEarly);
    expect(result.confirmed).toBe(0);

    const l1Wallets = await wallets.listWallets(l1UserId);
    expect(l1Wallets.length === 0 || l1Wallets[0].balance === '0.00000000').toBe(true);
  });

  it('credits both IBs once the window has passed', async () => {
    const afterWindow = new Date(CLOSED_AT.getTime() + 25 * 60 * 60 * 1000);
    const result = await commission.confirmMatured(afterWindow);
    expect(result.confirmed).toBe(FIXTURE.length * 2);

    const expectedPool = FIXTURE.reduce((acc, f) => acc.plus(poolOf(f)), new Decimal(0));
    const [l1Wallet] = await wallets.listWallets(l1UserId);
    const [l2Wallet] = await wallets.listWallets(l2UserId);

    expect(l1Wallet.balance).toBe(money(expectedPool.times(70).dividedBy(100)));
    expect(l2Wallet.balance).toBe(money(expectedPool.times(30).dividedBy(100)));
  });

  it('§11 RECONCILIATION — every wallet balances to the cent after the pipeline', async () => {
    for (const userId of [l1UserId, l2UserId]) {
      const [wallet] = await wallets.listWallets(userId);
      const result = await wallets.reconcile(wallet.id);
      expect(
        result.balanced,
        `wallet ${wallet.id} drifted: balance ${result.balance} vs ledger ${result.ledgerSum}`,
      ).toBe(true);
    }
  });

  it('never pays out more than the pool the deals generated', async () => {
    const expectedPool = FIXTURE.reduce((acc, f) => acc.plus(poolOf(f)), new Decimal(0));
    const [l1Wallet] = await wallets.listWallets(l1UserId);
    const [l2Wallet] = await wallets.listWallets(l2UserId);
    const paid = new Decimal(l1Wallet.balance).plus(l2Wallet.balance);
    expect(paid.lessThanOrEqualTo(expectedPool)).toBe(true);
  });
});

describe('§11 idempotency — replaying the whole pipeline', () => {
  it('re-delivering every deal changes no balance', async () => {
    const before = await Promise.all([
      wallets.listWallets(l1UserId),
      wallets.listWallets(l2UserId),
    ]);

    // Same tickets, delivered again — as an at-least-once queue would.
    for (const f of FIXTURE) {
      const result = await commission.ingestAndAccrue({
        mt5Ticket: f.ticket,
        mt5Login: MT5_LOGIN,
        symbol: 'EURUSD',
        volume: f.volume,
        spread: f.spread,
        closedAt: CLOSED_AT,
      });
      expect(result.created, `${f.ticket} must not be ingested twice`).toBe(false);
    }
    // And the confirm job runs again over the same accruals.
    const confirmAgain = await commission.confirmMatured(
      new Date(CLOSED_AT.getTime() + 48 * 60 * 60 * 1000),
    );
    expect(confirmAgain.confirmed).toBe(0);

    const after = await Promise.all([
      wallets.listWallets(l1UserId),
      wallets.listWallets(l2UserId),
    ]);
    expect(after[0][0].balance).toBe(before[0][0].balance);
    expect(after[1][0].balance).toBe(before[1][0].balance);

    const accruals = await ctx.db.select().from(commissionAccruals);
    expect(accruals).toHaveLength(FIXTURE.length * 2);
  });

  it('forcing accrual again on an already-accrued deal writes nothing', async () => {
    const [deal] = await ctx.db.select().from(commissionAccruals).limit(1);
    const result = await commission.accrueForDeal(deal.dealId);
    expect(result.accruals).toHaveLength(0);
  });
});

describe('§8.6 chain rules through the real pipeline', () => {
  it('an L1 without a parent pays exactly one accrual', async () => {
    const soloIb = await makeUser('solo-ib@test.local');
    const soloClient = await makeUser('solo-client@test.local');
    await ctx.db
      .insert(ibProfiles)
      .values({ userId: soloIb, parentIbId: null, programId, status: 'approved' });
    await ctx.db
      .insert(referralAttributions)
      .values({ clientUserId: soloClient, ibUserId: soloIb, active: true });
    await ctx.db
      .insert(tradingAccounts)
      .values({ userId: soloClient, mt5Login: '500002', environment: 'live' });

    const result = await commission.ingestAndAccrue({
      mt5Ticket: 'T-SOLO',
      mt5Login: '500002',
      symbol: 'EURUSD',
      volume: '1',
      spread: '2.0',
      closedAt: CLOSED_AT,
    });
    expect(result.accruals).toHaveLength(1);
    expect(result.accruals[0].level).toBe(1);
  });

  it('a client with no attribution accrues nothing', async () => {
    const direct = await makeUser('direct@test.local');
    await ctx.db
      .insert(tradingAccounts)
      .values({ userId: direct, mt5Login: '500003', environment: 'live' });

    const result = await commission.ingestAndAccrue({
      mt5Ticket: 'T-DIRECT',
      mt5Login: '500003',
      symbol: 'EURUSD',
      volume: '1',
      spread: '2.0',
      closedAt: CLOSED_AT,
    });
    expect(result.created).toBe(true);
    expect(result.accruals).toHaveLength(0);
    expect(result.reason).toBe('no-attribution');
  });

  it('a pending (unapproved) IB earns nothing', async () => {
    const pendingIb = await makeUser('pending-ib@test.local');
    const theirClient = await makeUser('pending-client@test.local');
    await ctx.db
      .insert(ibProfiles)
      .values({ userId: pendingIb, parentIbId: null, programId, status: 'pending' });
    await ctx.db
      .insert(referralAttributions)
      .values({ clientUserId: theirClient, ibUserId: pendingIb, active: true });
    await ctx.db
      .insert(tradingAccounts)
      .values({ userId: theirClient, mt5Login: '500004', environment: 'live' });

    const result = await commission.ingestAndAccrue({
      mt5Ticket: 'T-PENDING',
      mt5Login: '500004',
      symbol: 'EURUSD',
      volume: '1',
      spread: '2.0',
      closedAt: CLOSED_AT,
    });
    expect(result.accruals).toHaveLength(0);
    expect(result.reason).toBe('chain-empty');
  });

  it('a deal for an unknown MT5 login is ignored, not crashed on', async () => {
    const result = await commission.ingestAndAccrue({
      mt5Ticket: 'T-GHOST',
      mt5Login: '999999',
      symbol: 'EURUSD',
      volume: '1',
      spread: '2.0',
      closedAt: CLOSED_AT,
    });
    expect(result.deal).toBeNull();
    expect(result.created).toBe(false);
  });
});
