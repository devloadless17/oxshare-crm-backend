import { Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../database/db';
import { tradingAccounts, transactions, transfers, users } from '../../database/schema';
import { WalletService } from '../wallet/wallet.service';

/**
 * Trading accounts and money movements for `client@oxshare.com`.
 *
 * ## Why this is not in `database/seed.ts`
 *
 * Because it writes MONEY, and money is only ever written through
 * `WalletService.post` (§6.2). `database/` is depended upon by `modules/` and
 * never the reverse — the lint rule that enforces that caught the first draft of
 * this file sitting in the seed and importing upward.
 *
 * The obvious way to satisfy the layering while staying in `seed.ts` would have
 * been to INSERT ledger rows and UPDATE the balance directly. That is worse
 * than a layering violation: it is a second implementation of the ledger write,
 * without the row lock, in a file nobody thinks of as money code. So the seed
 * moved instead.
 *
 * ## This is real data, not mock data
 *
 * Every balance below is the SUM of ledger entries written the way the
 * application writes them — the wallet row is locked, the entry is appended and
 * the balance is updated in one transaction. So the wallet, the ledger and the
 * transaction list agree, and `ReconciliationService` passes over this data
 * exactly as it would over production data.
 *
 * Writing a `balance` straight onto the wallet row is four fewer lines and
 * produces a database that reconciliation flags, a ledger that does not sum to
 * the balance, and a /transactions screen with nothing on it. The repo bans
 * mock data because that shape has cost real time here twice.
 *
 * ## Idempotency comes from the constraints, never from checking first
 *
 * `trading_accounts.mt5_login` is UNIQUE, transactions conflict on
 * (provider, provider_ref), transfers have fixed ids, and every ledger write is
 * keyed on (wallet, referenceType, referenceId). A second run therefore inserts
 * no duplicate account and posts no second credit — which is what lets this
 * live on the ordinary boot path.
 */
const logger = new Logger('DemoTradingSeed');

export async function seedDemoTradingData(): Promise<void> {
  const db = getDb();

  const [client] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'client@oxshare.com'))
    .limit(1);
  if (!client) return;

  /*
   * The demo client is verified, so the money screens are reachable.
   *
   * Without level 1 the seeded wallets, transfers and accounts all exist while
   * every screen that shows them sits behind the KYC gate — which makes this
   * data invisible in the app it was seeded for.
   */
  await db.update(users).set({ verificationLevel: 1 }).where(eq(users.id, client.id));

  // Ten live and ten demo. Two blocks of consecutive logins rather than one
  // interleaved range, so which is which is obvious at a glance in the database
  // as well as on screen.
  const accounts = [
    ...Array.from({ length: 10 }, (_, i) => ({
      mt5Login: `500${1001 + i}`,
      environment: 'live' as const,
      mt5Group: 'real\\Standard',
      tier: i < 5 ? 'Standard' : 'Pro',
      leverage: i < 5 ? 500 : 200,
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      mt5Login: `900${2001 + i}`,
      environment: 'demo' as const,
      mt5Group: 'demo\\Standard',
      tier: 'Standard',
      leverage: 500,
    })),
  ];

  await db
    .insert(tradingAccounts)
    .values(accounts.map((a) => ({ ...a, userId: client.id })))
    .onConflictDoNothing({ target: tradingAccounts.mt5Login });

  const walletService = new WalletService(db);
  const usd = await walletService.getOrCreateWallet(client.id, 'USD');
  const usdt = await walletService.getOrCreateWallet(client.id, 'USDT');

  /*
   * Credits first, then the debits they fund.
   *
   * `post` refuses an overdraft, so a withdrawal seeded before its deposit
   * throws rather than quietly producing a negative balance. The order here is
   * load-bearing, not cosmetic.
   */
  await walletService.post({
    userId: client.id,
    currency: 'USD',
    amount: '25000',
    entryType: 'deposit',
    referenceType: 'seed',
    referenceId: 'seed-deposit-usd-1',
  });
  await walletService.post({
    userId: client.id,
    currency: 'USDT',
    amount: '8000',
    entryType: 'deposit',
    referenceType: 'seed',
    referenceId: 'seed-deposit-usdt-1',
  });
  await walletService.post({
    userId: client.id,
    currency: 'USD',
    amount: '-4500',
    entryType: 'withdrawal',
    referenceType: 'seed',
    referenceId: 'seed-withdrawal-usd-1',
  });

  /*
   * The transaction ROWS behind those movements, so /transactions and the admin
   * withdrawal queue show the same history the ledger does.
   *
   * One settled row per posted entry, plus one PENDING withdrawal genuinely
   * awaiting review — the state the admin queue exists to work through, and one
   * no number of seeded "success" rows would exercise. It places no hold,
   * deliberately: a hold seeded by hand is released by nothing, so it would
   * lock those funds permanently.
   */
  await db
    .insert(transactions)
    .values([
      {
        userId: client.id,
        walletId: usd.id,
        direction: 'deposit' as const,
        amount: '25000.00000000',
        currency: 'USD',
        state: 'success' as const,
        provider: 'manual_bank_transfer',
        providerRef: 'OX-SEED-D1',
        settledAt: new Date(),
      },
      {
        userId: client.id,
        walletId: usdt.id,
        direction: 'deposit' as const,
        amount: '8000.00000000',
        currency: 'USDT',
        state: 'success' as const,
        provider: 'manual_usdt_trc20',
        providerRef: 'OX-SEED-D2',
        settledAt: new Date(),
      },
      {
        userId: client.id,
        walletId: usd.id,
        direction: 'withdrawal' as const,
        amount: '4500.00000000',
        currency: 'USD',
        state: 'success' as const,
        provider: 'whish',
        providerRef: 'OX-SEED-W1',
        destination: 'AE07 0331 2345 6789 0123 456',
        settledAt: new Date(),
      },
      {
        userId: client.id,
        walletId: usd.id,
        direction: 'withdrawal' as const,
        amount: '900.00000000',
        currency: 'USD',
        state: 'pending' as const,
        provider: 'whish',
        providerRef: 'OX-SEED-W2',
        destination: 'AE07 0331 2345 6789 0123 456',
      },
    ])
    // UNIQUE(provider, provider_ref) — the §6.3 idempotency guarantee, reused
    // here rather than a check-then-insert.
    .onConflictDoNothing({ target: [transactions.provider, transactions.providerRef] });

  /*
   * Transfers: one settled, one still pending.
   *
   * The settled one has a matching `transfer` ledger entry, because that is
   * precisely what settling does. The pending one has NO ledger entry and no
   * hold — its direction is `account_to_wallet`, which credits nothing until
   * the counterparty confirms, so "pending with the wallet untouched" is its
   * correct state rather than a shortcut.
   */
  const [liveAccount] = await db
    .select({ id: tradingAccounts.id })
    .from(tradingAccounts)
    .where(and(eq(tradingAccounts.userId, client.id), eq(tradingAccounts.environment, 'live')))
    .orderBy(tradingAccounts.mt5Login)
    .limit(1);

  if (liveAccount) {
    const settledTransferId = '00000000-0000-4000-8000-00000000f001';
    await db
      .insert(transfers)
      .values([
        {
          id: settledTransferId,
          userId: client.id,
          walletId: usd.id,
          tradingAccountId: liveAccount.id,
          direction: 'wallet_to_account' as const,
          amount: '5000.00000000',
          currency: 'USD',
          state: 'settled' as const,
          settledAt: new Date(),
        },
        {
          id: '00000000-0000-4000-8000-00000000f002',
          userId: client.id,
          walletId: usd.id,
          tradingAccountId: liveAccount.id,
          direction: 'account_to_wallet' as const,
          amount: '1200.00000000',
          currency: 'USD',
          state: 'pending' as const,
        },
      ])
      // Fixed ids, so re-running conflicts on the primary key rather than
      // inserting a second pair.
      .onConflictDoNothing({ target: transfers.id });

    // The ledger entry the settled transfer represents. `transfer`, not
    // `withdrawal` — an internal move must not inflate withdrawal totals.
    await walletService.post({
      userId: client.id,
      currency: 'USD',
      amount: '-5000',
      entryType: 'transfer',
      referenceType: 'transfer',
      referenceId: settledTransferId,
    });
  }

  // A Logger rather than console.log: `database/seed.ts` predates the no-console
  // rule and is exempt, this file is not, and a bootstrap line is worth having
  // in the same stream as everything else the app logs at boot.
  logger.log(
    'client@oxshare.com: 10 live + 10 demo trading accounts, wallets funded through the ledger',
  );
}
