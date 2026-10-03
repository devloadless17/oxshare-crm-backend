import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CommissionService } from '../src/modules/ib/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { IbStore } from '../src/store/ib.store';
import { emailStubAs } from './email-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The confirm queue (0182): rows that fail for good must not hold its head,
 * and two runs racing the same rows must credit them once.
 */

let ctx: MoneyTestContext;

/** A wallet service that refuses every credit to one user. */
class RefusingWallets extends WalletService {
  refuse: number | null = null;
  override post(...args: Parameters<WalletService['post']>) {
    if (args[0].userId === this.refuse) return Promise.reject(new Error('wallet refused'));
    return super.post(...args);
  }
}

let wallets: RefusingWallets;

function service(): CommissionService {
  return new CommissionService(
    ctx.db,
    wallets,
    { notify: () => Promise.resolve(), notifyAdmins: () => Promise.resolve() },
    new AppSettingsStore(ctx.db),
    emailStubAs(),
    { assertVisible: () => Promise.resolve() } as never,
    new IbStore(ctx.db),
  );
}

async function makeClient(email: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Partner', 1, true)
    RETURNING id
  `);
  return rows[0].id;
}

let seq = 0;
async function accrue(ibUserId: number, clientUserId: number, hoursAgo: number): Promise<void> {
  seq += 1;
  const sourceId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  await ctx.db.execute(sql`
    INSERT INTO ib_accruals (ib_user_id, client_user_id, source_type, source_id, depth,
                             rate_value, base_amount, amount, currency, created_at)
    VALUES (${ibUserId}, ${clientUserId}, 'deal', ${sourceId}, 1,
            '70.0000', '100.00000000', '7.00000000', 'USD',
            now() - (${hoursAgo} || ' hours')::interval)
  `);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new RefusingWallets(ctx.db);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

afterEach(async () => {
  wallets.refuse = null;
  await ctx.db.execute(sql`TRUNCATE ledger_entries, ib_accruals, ib_accrual_batches CASCADE`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
});

describe('the commission confirm queue', () => {
  it('moves failing rows behind newer ones, so they cannot starve the queue', async () => {
    const stuck = await makeClient('queue-stuck@test.local');
    const healthy = await makeClient('queue-healthy@test.local');
    const client = await makeClient('queue-client@test.local');
    // The OLDEST rows belong to a partner whose credit always fails.
    await accrue(stuck, client, 72);
    await accrue(stuck, client, 71);
    await accrue(healthy, client, 48);
    wallets.refuse = stuck;

    const commissions = service();
    const runStart = new Date();
    // A batch exactly the size of the stuck head: before 0182 every run took
    // the same two failing rows and the healthy partner was never paid.
    const first = await commissions.confirmPending(2);
    expect(first).toMatchObject({ confirmed: 0, failed: 2 });

    const second = await commissions.confirmPending(2);
    expect(second.confirmed).toBe(1);

    // Within one drain run, rows that already failed are skipped, so a queue
    // of failures yields a short batch and the drain stops.
    expect(await commissions.confirmPending(2, runStart)).toMatchObject({
      confirmed: 0,
      failed: 0,
    });

    const { rows } = await ctx.db.execute<{ status: string; attempts: number; ib: number }>(sql`
      SELECT status, confirm_attempts AS attempts, ib_user_id AS ib FROM ib_accruals
    `);
    expect(rows.find((r) => r.ib === healthy)?.status).toBe('confirmed');
    for (const row of rows.filter((r) => r.ib === stuck)) {
      expect(row.status).toBe('pending');
      expect(row.attempts).toBeGreaterThanOrEqual(1);
    }
  });

  it('credits a group once when two runs race the same rows', async () => {
    const partner = await makeClient('queue-race@test.local');
    const client = await makeClient('queue-race-client@test.local');
    for (let i = 0; i < 5; i += 1) await accrue(partner, client, 48);

    const commissions = service();
    const runs = await Promise.all([commissions.confirmPending(), commissions.confirmPending()]);
    expect(runs[0].confirmed + runs[1].confirmed).toBe(5);

    const { rows } = await ctx.db.execute<{ total: string; n: number }>(sql`
      SELECT coalesce(sum(amount), 0)::text AS total, count(*)::int AS n
        FROM ledger_entries WHERE entry_type = 'commission'
    `);
    expect(rows[0].n).toBe(1);
    expect(rows[0].total).toBe('35.00000000');
  });
});
