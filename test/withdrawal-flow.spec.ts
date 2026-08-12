import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { MoneyLimits } from '../src/config/money-limits';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { SYSTEM_ACTOR } from '../src/common/security/actor';
import { auditStubAs } from './audit-stub';
import { commissionStubAs } from './commission-stub';
import { emailStubAs } from './email-stub';
import { notificationsStubAs } from './notifications-stub';
import { gatewayStubAs } from './gateway-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The withdrawal state machine, and the balance behind it.
 *
 * The half of this that matters most is the DEBIT-ON-REQUEST conversion. The
 * restored service held funds and posted the debit at settlement; this one
 * debits when the client asks and refunds with a compensating entry if it is
 * refused. Several tests here exist purely to pin that the money comes back —
 * a refund that silently does not happen leaves a client short with every state
 * looking correct.
 */
let ctx: MoneyTestContext;
let transactions: TransactionsService;
let wallets: WalletService;

const ADMIN = '00000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    new MoneyLimits(new ConfigService()),
    new PaymentMethodsService(
      ctx.db,
      currencies,
      auditStubAs(),
      gatewayStubAs(),
      new MoneyLimits(new ConfigService()),
    ),
    currencies,
    commissionStubAs(),
    gatewayStubAs(),
    new ConfigService(),
    emailStubAs(),
    notificationsStubAs(),
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

/** A verified client with a funded USD wallet. */
async function makeFundedClient(email: string, balance = '1000'): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  const userId = rows[0].id;
  await wallets.post({
    userId,
    currency: 'USD',
    amount: balance,
    entryType: 'deposit',
    referenceType: 'transaction',
    referenceId: `seed-${userId}`,
  });
  return userId;
}

async function balanceOf(userId: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM wallets WHERE user_id = ${userId} AND currency = 'USD'`,
  );
  return rows[0].balance;
}

async function ledgerCount(userId: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM ledger_entries le
      JOIN wallets w ON w.id = le.wallet_id
     WHERE w.user_id = ${userId}
  `);
  return rows[0].count;
}

function request(userId: string, amount = '100') {
  return transactions.requestWithdrawal({
    userId,
    currency: 'USD',
    amount,
    destination: '+961 3 123 456',
    provider: 'whish',
  });
}

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM transfers`);
  await ctx.db.execute(sql`DELETE FROM transactions`);
  await ctx.db.execute(sql`DELETE FROM ledger_entries`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
});

describe('requesting a withdrawal', () => {
  it('debits the balance immediately', async () => {
    const userId = await makeFundedClient('debit@test.local');

    const row = await request(userId, '250');

    expect(row.state).toBe('pending');
    /*
     * The whole point of the change. The old flow left the balance at 1000 with
     * 250 on hold, so a client could ask for another 1000 and be told yes.
     */
    expect(await balanceOf(userId)).toBe('750.00000000');
  });

  it('refuses a second withdrawal that no longer fits', async () => {
    const userId = await makeFundedClient('twice@test.local', '100');

    await request(userId, '80');

    // 20 left. The refusal happens NOW, while the client is looking at the
    // form — not later, at an admin's desk, against a number they never saw.
    await expect(request(userId, '80')).rejects.toThrow(/insufficient/i);
  });

  it('refuses an unverified client, in the service and not only the guard', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name, verification_level)
      VALUES ('unverified@test.local', 'x', 'Test', 'Client', 0)
      RETURNING id
    `);
    await wallets.post({
      userId: rows[0].id,
      currency: 'USD',
      amount: '500',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'seed',
    });

    /*
     * R-4.3: the guard is the cheap early refusal, this is the load-bearing
     * one. A service is reachable from a job or a callback, neither of which
     * passes through a guard.
     */
    await expect(request(rows[0].id)).rejects.toThrow(/verified/i);
  });

  it('leaves nothing behind when the request is refused', async () => {
    const userId = await makeFundedClient('atomic@test.local', '50');

    await expect(request(userId, '100')).rejects.toThrow();

    // No transaction row, no ledger entry, balance untouched. The insert and
    // the debit share one transaction precisely so a refusal at either step
    // leaves neither.
    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM transactions WHERE user_id = ${userId}`,
    );
    expect(rows[0].count).toBe(0);
    expect(await balanceOf(userId)).toBe('50.00000000');
  });
});

describe('approve and settle', () => {
  it('moves no money — the debit already happened', async () => {
    const userId = await makeFundedClient('settle@test.local');
    const row = await request(userId, '300');
    const afterRequest = await balanceOf(userId);

    await transactions.approve(row.id, ADMIN);
    expect(await balanceOf(userId)).toBe(afterRequest);

    const settled = await transactions.settle(row.id, ADMIN, 'PROVIDER-REF-1');
    expect(settled.state).toBe('success');
    expect(settled.providerRef).toBe('PROVIDER-REF-1');
    // Still one ledger entry for the withdrawal, plus the seeding deposit.
    expect(await balanceOf(userId)).toBe('700.00000000');
    expect(await ledgerCount(userId)).toBe(2);
  });

  it('refuses to settle something that was never approved', async () => {
    const userId = await makeFundedClient('unapproved@test.local');
    const row = await request(userId);

    await expect(transactions.settle(row.id, ADMIN, 'REF')).rejects.toThrow(/approved/i);
  });

  it('refuses to approve twice', async () => {
    const userId = await makeFundedClient('double-approve@test.local');
    const row = await request(userId);
    await transactions.approve(row.id, ADMIN);

    // The conditional UPDATE ... WHERE state = 'pending' is what stops a
    // double-clicked button, not a pre-read.
    await expect(transactions.approve(row.id, ADMIN)).rejects.toThrow(/pending/i);
  });
});

describe('rejection refunds with a compensating entry', () => {
  it('returns the money', async () => {
    const userId = await makeFundedClient('refund@test.local');
    const row = await request(userId, '400');
    expect(await balanceOf(userId)).toBe('600.00000000');

    await transactions.reject(row.id, ADMIN, 'Beneficiary details do not match');

    expect(await balanceOf(userId)).toBe('1000.00000000');
  });

  it('writes a NEW row rather than editing the debit — §6.4', async () => {
    const userId = await makeFundedClient('compensating@test.local');
    const row = await request(userId, '400');

    await transactions.reject(row.id, ADMIN, 'Nope');

    const { rows } = await ctx.db.execute<{
      amount: string;
      entry_type: string;
      reference_id: string;
    }>(sql`
      SELECT le.amount, le.entry_type, le.reference_id FROM ledger_entries le
        JOIN wallets w ON w.id = le.wallet_id
       WHERE w.user_id = ${userId} AND le.entry_type <> 'deposit'
       ORDER BY le.created_at
    `);

    // The debit stands, untouched, with the credit beside it. Both are readable
    // as what happened rather than as a withdrawal that was quietly unwritten.
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe('-400.00000000');
    expect(rows[0].entry_type).toBe('withdrawal');
    expect(rows[1].amount).toBe('400.00000000');
    /*
     * `adjustment`, not `deposit`: no money entered the platform. A report
     * summing deposits would otherwise count every refused withdrawal as one.
     */
    expect(rows[1].entry_type).toBe('adjustment');
    // The suffix is what stops the unique index absorbing the refund as a
    // replay of the debit — without it the client is never paid back and
    // `post()` reports success.
    expect(rows[1].reference_id).toBe(`${row.id}:refund`);
  });

  it('refuses to reject a settled withdrawal', async () => {
    const userId = await makeFundedClient('too-late@test.local');
    const row = await request(userId);
    await transactions.approve(row.id, ADMIN);
    await transactions.settle(row.id, ADMIN, 'REF');

    await expect(transactions.reject(row.id, ADMIN, 'Changed my mind')).rejects.toThrow(/pending/i);
    // And the money did not come back.
    expect(await balanceOf(userId)).toBe('900.00000000');
  });

  it('cannot refund twice', async () => {
    const userId = await makeFundedClient('double-refund@test.local');
    const row = await request(userId, '100');
    await transactions.reject(row.id, ADMIN, 'First');

    await expect(transactions.reject(row.id, ADMIN, 'Second')).rejects.toThrow();
    expect(await balanceOf(userId)).toBe('1000.00000000');
  });

  it('lets the client withdraw again after a refund', async () => {
    const userId = await makeFundedClient('retry@test.local', '100');
    const first = await request(userId, '100');
    await transactions.reject(first.id, ADMIN, 'Try again');

    // The full balance is back and spendable — the refund is a real credit,
    // not a state flag.
    const second = await request(userId, '100');
    expect(second.state).toBe('pending');
    expect(await balanceOf(userId)).toBe('0.00000000');
  });
});

describe('provider failure after approval', () => {
  it('refunds, exactly as a rejection does', async () => {
    const userId = await makeFundedClient('failed@test.local');
    const row = await request(userId, '200');
    await transactions.approve(row.id, ADMIN);

    const failed = await transactions.markFailed(row.id, 'Provider timeout', SYSTEM_ACTOR);

    expect(failed.state).toBe('failure');
    expect(await balanceOf(userId)).toBe('1000.00000000');
  });

  it('refuses to fail a withdrawal that was never approved', async () => {
    const userId = await makeFundedClient('never-approved@test.local');
    const row = await request(userId);

    await expect(transactions.markFailed(row.id, 'x', SYSTEM_ACTOR)).rejects.toThrow(/approved/i);
  });
});

describe('limits', () => {
  it('refuses an amount below the minimum', async () => {
    const userId = await makeFundedClient('tiny@test.local');

    // Below this a withdrawal costs more in provider fees than it moves.
    await expect(request(userId, '1')).rejects.toThrow(/minimum/i);
  });

  it('caps a rolling 24 hours, not just one request', async () => {
    const userId = await makeFundedClient('daycap@test.local', '250000');

    /*
     * A per-request limit alone is trivially defeated by making N requests, so
     * it caps the paperwork rather than the exposure. Counted over everything
     * not rejected — a pending withdrawal is money already on its way out.
     */
    await request(userId, '50000');
    await request(userId, '50000');
    await expect(request(userId, '50000')).rejects.toThrow(/24-hour/i);
  });

  it('does not count a REJECTED withdrawal against the daily cap', async () => {
    const userId = await makeFundedClient('rejected-cap@test.local', '250000');
    const first = await request(userId, '50000');
    await transactions.reject(first.id, ADMIN, 'Not this one');

    // It never left, so it should not consume the client's allowance.
    await request(userId, '50000');
    await request(userId, '50000');
    await expect(request(userId, '10')).rejects.toThrow(/24-hour/i);
  });
});
