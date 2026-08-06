import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, getDb, resetDb } from '../src/database/db';
import {
  commissionAccruals,
  deals,
  ibPrograms,
  tradingAccounts,
  transactions,
  users,
} from '../src/database/schema';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { MoneyLimits } from '../src/config/money-limits';
import { CommissionService } from '../src/modules/partners/commission.service';

/**
 * Real limits, reading the documented defaults.
 *
 * Not a stub: the §12.4 ceilings are part of what accrual must satisfy, so a
 * test that bypassed them would pass on numbers production would refuse.
 */
function moneyLimits(): MoneyLimits {
  return new MoneyLimits({ get: () => undefined } as never);
}

// FAULT-INJECTION TESTS.
//
// The existing suite only exercised happy paths, which is why several
// money-losing defects passed review. Each test here forces a failure at the
// exact point that previously left money duplicated, lost or frozen, and
// asserts the system is still consistent afterwards.
//
// These are the tests that must fail if anyone reverts the transaction
// boundaries.

let ctx: MoneyTestContext;
let wallets: WalletService;
let txService: TransactionsService;
let commission: CommissionService;

async function makeVerifiedUser(email: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email,
      passwordHash: 'x',
      firstName: 'Test',
      lastName: 'User',
      verificationLevel: 1,
      emailVerified: true,
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  resetDb();
  wallets = new WalletService(getDb());
  txService = new TransactionsService(
    wallets,
    getDb(),
    moneyLimits(),
    new CurrenciesService(getDb()),
  );
  commission = new CommissionService(wallets, getDb(), moneyLimits());
});

afterAll(async () => {
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('settle() is atomic — a failure mid-settlement leaves no money stranded', () => {
  it('rolls the state change back when the ledger debit fails', async () => {
    const userId = await makeVerifiedUser('settle-fault@test.local');
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '1000',
      entryType: 'deposit',
      referenceType: 'seed',
      referenceId: 'sf-1',
    });

    const requested = await txService.requestWithdrawal({
      userId,
      amount: '300',
      currency: 'USD',
      destination: 'IBAN-1',
      provider: 'whish',
    });
    await txService.approve(requested.id, '00000000-0000-0000-0000-000000000001');

    // Force the debit to fail at the exact point that previously left the row
    // marked 'success' with no ledger entry — money duplicated, unrecoverable.
    const spy = vi.spyOn(wallets, 'post').mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(
      txService.settle(requested.id, '00000000-0000-0000-0000-000000000001', 'ref-1'),
    ).rejects.toThrow('ledger unavailable');
    spy.mockRestore();

    // The whole transaction rolled back: still approved, hold intact, balance untouched.
    const [row] = await ctx.db.select().from(transactions).where(eq(transactions.id, requested.id));
    expect(row.state, 'state must not advance when the debit failed').toBe('approved');

    const [wallet] = await wallets.listWallets(userId);
    expect(wallet.balance).toBe('1000.00000000');
    expect(wallet.onHold, 'the hold must survive so the settlement can be retried').toBe(
      '300.00000000',
    );

    // And the operation is retryable — the previous design blocked retry forever.
    const settled = await txService.settle(
      requested.id,
      '00000000-0000-0000-0000-000000000001',
      'ref-1',
    );
    expect(settled.state).toBe('success');

    const [after] = await wallets.listWallets(userId);
    expect(after.balance).toBe('700.00000000');
    expect(after.onHold, 'the hold must be cleared once settled').toBe('0.00000000');
    expect((await wallets.reconcile(after.id)).balanced).toBe(true);
  });

  it('rolls back the hold when the withdrawal row cannot be written', async () => {
    const userId = await makeVerifiedUser('request-fault@test.local');
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '500',
      entryType: 'deposit',
      referenceType: 'seed',
      referenceId: 'rf-1',
    });

    // A destination longer than the column forces the INSERT to fail after the
    // hold — which previously committed separately and froze the funds.
    await expect(
      txService.requestWithdrawal({
        userId,
        amount: '100',
        currency: 'USD',
        destination: 'x'.repeat(300),
        provider: 'whish',
      }),
    ).rejects.toThrow();

    const [wallet] = await wallets.listWallets(userId);
    expect(wallet.onHold, 'no funds may be reserved for a withdrawal that does not exist').toBe(
      '0.00000000',
    );
    expect(wallet.available).toBe('500.00000000');
  });

  it('releases the hold atomically on rejection', async () => {
    const userId = await makeVerifiedUser('reject-fault@test.local');
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '400',
      entryType: 'deposit',
      referenceType: 'seed',
      referenceId: 'rj-1',
    });
    const requested = await txService.requestWithdrawal({
      userId,
      amount: '150',
      currency: 'USD',
      destination: 'IBAN-2',
      provider: 'whish',
    });

    const spy = vi.spyOn(wallets, 'release').mockRejectedValueOnce(new Error('release failed'));
    await expect(
      txService.reject(requested.id, '00000000-0000-0000-0000-000000000001', 'bad details'),
    ).rejects.toThrow('release failed');
    spy.mockRestore();

    const [row] = await ctx.db.select().from(transactions).where(eq(transactions.id, requested.id));
    expect(row.state, 'a rejection that could not release funds must not be recorded').toBe(
      'pending',
    );

    // Retry succeeds and the funds come back.
    await txService.reject(requested.id, '00000000-0000-0000-0000-000000000001', 'bad details');
    const [wallet] = await wallets.listWallets(userId);
    expect(wallet.onHold).toBe('0.00000000');
    expect(wallet.available).toBe('400.00000000');
  });
});

describe('confirmMatured() credits before confirming — no silent under-payment', () => {
  it('leaves the accrual claimable when the wallet credit fails', async () => {
    const ibUserId = await makeVerifiedUser('confirm-fault-ib@test.local');
    const clientId = await makeVerifiedUser('confirm-fault-client@test.local');

    const [program] = await ctx.db
      .insert(ibPrograms)
      .values({
        name: 'Atomicity Test Plan',
        mode: 'commission',
        method: 'per_lot',
        commissionValue: '10',
        rebateValue: '0',
        l1Share: '100',
        l2Share: '0',
      })
      .returning();
    const [account] = await ctx.db
      .insert(tradingAccounts)
      .values({ userId: clientId, mt5Login: '900001', environment: 'live' })
      .returning();
    const [deal] = await ctx.db
      .insert(deals)
      .values({
        mt5Ticket: 'ATOM-1',
        tradingAccountId: account.id,
        symbol: 'EURUSD',
        volume: '1',
        spread: '1',
        closedAt: new Date('2026-08-01T00:00:00Z'),
      })
      .returning();
    await ctx.db.insert(commissionAccruals).values({
      dealId: deal.id,
      ibUserId,
      level: 1,
      programId: program.id,
      amount: '25.00000000',
      status: 'accrued',
      availableAt: new Date('2026-08-01T00:00:00Z'),
    });

    // Force the credit to fail. Previously the accrual was marked 'confirmed'
    // FIRST, so this permanently excluded it from the selector: the IB was
    // never paid while the table claimed they were.
    const spy = vi.spyOn(wallets, 'post').mockRejectedValueOnce(new Error('wallet unavailable'));
    const failedRun = await commission.confirmMatured(new Date('2026-08-02T00:00:00Z'));
    spy.mockRestore();

    expect(failedRun.confirmed).toBe(0);
    expect(failedRun.failed).toBe(1);

    const [stillAccrued] = await ctx.db
      .select()
      .from(commissionAccruals)
      .where(
        and(eq(commissionAccruals.dealId, deal.id), eq(commissionAccruals.ibUserId, ibUserId)),
      );
    expect(stillAccrued.status, 'a failed credit must leave the accrual retryable').toBe('accrued');
    expect(stillAccrued.confirmedAt).toBeNull();

    // The next run pays it — no money lost.
    const goodRun = await commission.confirmMatured(new Date('2026-08-02T00:00:00Z'));
    expect(goodRun.confirmed).toBe(1);

    const [wallet] = await wallets.listWallets(ibUserId);
    expect(wallet.balance).toBe('25.00000000');
    expect((await wallets.reconcile(wallet.id)).balanced).toBe(true);
  });

  it('every confirmed accrual has a matching ledger entry (the invariant reconciliation cannot see)', async () => {
    const confirmed = await ctx.db
      .select()
      .from(commissionAccruals)
      .where(eq(commissionAccruals.status, 'confirmed'));

    for (const accrual of confirmed) {
      const entries = await commission.findAccrualLedgerEntry(accrual.id);
      expect(
        entries,
        `accrual ${accrual.id} is marked confirmed but no ledger entry credits it`,
      ).toBeDefined();
      expect(entries?.amount).toBe(accrual.amount);
    }
  });
});
