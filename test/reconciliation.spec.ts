import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, getDb, resetDb } from '../src/database/db';
import { users, wallets } from '../src/database/schema';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { ReconciliationService } from '../src/modules/wallet/reconciliation.service';

/**
 * PLATFORM-CONVENTIONS §12.2 — reconciliation as a production control.
 *
 * ARCHITECTURE §11's reconciliation test replays a fixture through the pipeline
 * and asserts everything balances. It proves the CODE was right at commit time,
 * and it would stay green through every one of the ways a live ledger actually
 * drifts: a manual UPDATE during an incident, a partially-applied migration, a
 * restore that landed between two writes.
 *
 * These tests therefore do the one thing that suite cannot: they BREAK the
 * ledger on purpose and assert the checker notices. A reconciliation job that
 * has never been shown to fail is not evidence of anything.
 */

let ctx: MoneyTestContext;
let wallets_: WalletService;
let reconciliation: ReconciliationService;

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  wallets_ = new WalletService(getDb());
  reconciliation = new ReconciliationService(ctx.db);
}, 180_000);

afterAll(async () => {
  await closeDb();
  await stopMoneyTestDb(ctx);
});

let seq = 0;
async function makeFundedUser(amount: string) {
  seq += 1;
  const [user] = await ctx.db
    .insert(users)
    .values({
      email: `recon-${seq}@test.local`,
      passwordHash: 'x',
      firstName: 'R',
      lastName: 'C',
    })
    .returning();

  await wallets_.post({
    userId: user.id,
    currency: 'USD',
    amount,
    entryType: 'deposit',
    referenceType: 'test',
    referenceId: `recon-seed-${seq}`,
  });

  const [wallet] = await wallets_.listWallets(user.id);
  return { userId: user.id, walletId: wallet.id };
}

describe('§12.2 reconciliation against live data', () => {
  it('reports balanced when every wallet agrees with its ledger', async () => {
    await makeFundedUser('500');
    const report = await reconciliation.run();

    expect(report.balanced).toBe(true);
    expect(report.walletDiscrepancies).toEqual([]);
    expect(report.walletsChecked).toBeGreaterThan(0);
  });

  it('DETECTS a balance edited behind the ledger', async () => {
    /*
     * The scenario this exists for: someone "fixes" a balance directly during an
     * incident. It is the single most likely way a live ledger diverges, it
     * leaves no trace in the append-only entries, and the §11 fixture test would
     * never see it because the code path was never wrong.
     *
     * The append-only TRIGGER protects ledger_entries, not wallets — the balance
     * is a cached projection and is deliberately updatable, which is exactly why
     * it has to be checked against its source.
     */
    const { walletId } = await makeFundedUser('100');

    await ctx.db
      .update(wallets)
      .set({ balance: sql`${wallets.balance} + 250` })
      .where(eq(wallets.id, walletId));

    const report = await reconciliation.run();

    expect(report.balanced).toBe(false);
    const found = report.walletDiscrepancies.find((d) => d.walletId === walletId);
    expect(found).toBeDefined();
    // Signed, so the report says which way the error goes — a balance that is
    // too HIGH is money the system thinks it owes and cannot back.
    expect(found?.difference).toBe('250.00000000');
    expect(found?.balance).toBe('350.00000000');
    expect(found?.ledgerSum).toBe('100.00000000');

    // Put it back so the remaining tests start from a balanced world.
    await ctx.db
      .update(wallets)
      .set({ balance: sql`${wallets.balance} - 250` })
      .where(eq(wallets.id, walletId));
    await expect(reconciliation.run()).resolves.toMatchObject({ balanced: true });
  });

  it('detects a shortfall as readily as a surplus', async () => {
    // A balance that is too LOW is a client's money the system has forgotten.
    // Equally wrong, and easy to miss if a check only looks for one direction.
    const { walletId } = await makeFundedUser('75');

    await ctx.db
      .update(wallets)
      .set({ balance: sql`${wallets.balance} - 25` })
      .where(eq(wallets.id, walletId));

    const report = await reconciliation.run();
    const found = report.walletDiscrepancies.find((d) => d.walletId === walletId);
    expect(found?.difference).toBe('-25.00000000');

    await ctx.db
      .update(wallets)
      .set({ balance: sql`${wallets.balance} + 25` })
      .where(eq(wallets.id, walletId));
  });

  it('checks every wallet, not just the first that disagrees', async () => {
    // A report that stops at the first mismatch turns one incident into several,
    // each discovered an hour apart.
    const a = await makeFundedUser('10');
    const b = await makeFundedUser('20');

    for (const walletId of [a.walletId, b.walletId]) {
      await ctx.db
        .update(wallets)
        .set({ balance: sql`${wallets.balance} + 1` })
        .where(eq(wallets.id, walletId));
    }

    const report = await reconciliation.run();
    const ids = report.walletDiscrepancies.map((d) => d.walletId);
    expect(ids).toContain(a.walletId);
    expect(ids).toContain(b.walletId);

    for (const walletId of [a.walletId, b.walletId]) {
      await ctx.db
        .update(wallets)
        .set({ balance: sql`${wallets.balance} - 1` })
        .where(eq(wallets.id, walletId));
    }
  });

  it('counts a wallet with no entries as balanced at zero, not as missing', async () => {
    // A freshly opened wallet has no ledger rows. SUM() over nothing is NULL,
    // and treating NULL as anything but zero would report every new wallet as a
    // discrepancy — the fastest way to make people ignore this report.
    seq += 1;
    const [user] = await ctx.db
      .insert(users)
      .values({
        email: `recon-empty-${seq}@test.local`,
        passwordHash: 'x',
        firstName: 'E',
        lastName: 'W',
      })
      .returning();
    const [wallet] = await ctx.db
      .insert(wallets)
      .values({ userId: user.id, currency: 'USD' })
      .returning();

    const report = await reconciliation.run();
    expect(report.walletDiscrepancies.map((d) => d.walletId)).not.toContain(wallet.id);
  });

  it('agrees with the single-wallet check', async () => {
    const { walletId } = await makeFundedUser('42');
    await expect(reconciliation.reconcileWallet(walletId)).resolves.toMatchObject({
      balanced: true,
      balance: '42.00000000',
      ledgerSum: '42.00000000',
    });
  });
});
