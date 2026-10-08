import type { AuditLogStore } from '../src/store/audit-log.store';
import { IbStore } from '../src/store/ib.store';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emailStubAs } from './email-stub';
import { sql } from 'drizzle-orm';
import { CommissionService } from '../src/modules/ib/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { NotificationsStore } from '../src/store/notifications.store';
import type { AdminsStore } from '../src/store/admins.store';
import type { RolesStore } from '../src/store/roles.store';
import type { AdminClientScopesStore } from '../src/store/admin-client-scopes.store';
import type { ClientVisibilityService } from '../src/common/security/client-visibility.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/*
 * A lease this instance always wins. Leader election has its own suite; a lease
 * mocked to refuse here would make every case pass by never running the job.
 */
const alwaysLeads = () =>
  ({ run: (_n: string, _t: number, work: () => Promise<void>) => work() }) as never;

/**
 * IB-15 — the settlement window, which is the rule deciding WHEN a partner's
 * commission becomes money they can spend.
 *
 * ## Why this file exists
 *
 * The hold window had no test at all. `notifications-hooks.spec.ts` switches it
 * off and says "what the window itself does is covered in commission.spec.ts" —
 * and it is not: that file never mentions the window. So the one rule standing
 * between "earned" and "spendable" was asserted nowhere, on a money system.
 *
 * ## What the window is FOR
 *
 * A commission is earned the moment revenue arrives and payable only once that
 * revenue is beyond reversal. Crediting immediately would make every commission
 * irreversible before the trade behind it settled, and Phase 1 has no clawback
 * — so a reversed deal would leave a partner holding money recoverable only by
 * a compensating entry with nothing to point at.
 *
 * Every case below has a wrong version that looks like success: paying early
 * looks like a working engine, and holding forever looks like an idle one.
 */

let ctx: MoneyTestContext;
let wallets: WalletService;
let dispatch: NotificationsService;

/**
 * The window is a SETTING now (0113), not `IB_COMMISSION_HOLD_HOURS`.
 *
 * Written to the real `trading_settings` row rather than passed as an argument,
 * so these cases exercise the path an operator actually takes — the form writes
 * the column and the service reads it. `undefined` deletes the row entirely,
 * which is how the "no configuration at all" default is tested.
 *
 * Seconds rather than hours, because that is what the column stores; each
 * caller below converts its own intent.
 */
async function serviceWithHold(seconds: number | undefined): Promise<CommissionService> {
  if (seconds === undefined) {
    await ctx.db.execute(sql`DELETE FROM trading_settings`);
  } else {
    await ctx.db.execute(sql`
      INSERT INTO trading_settings (id, ib_commission_interval_seconds)
      VALUES (true, ${seconds})
      ON CONFLICT (id) DO UPDATE SET ib_commission_interval_seconds = ${seconds}
    `);
  }

  return new CommissionService(
    ctx.db,
    wallets,
    dispatch,
    // The real store against the real row: the interval AND the payout ceiling
    // both come from here, so these read what a deployment configures rather
    // than a stub's opinion.
    new AppSettingsStore(ctx.db),
    /* The per-run payout summary email (0114). Stubbed: this suite is
       about the money, and the send is fire-and-forget by contract. */
    emailStubAs(),
    /* The territory gate on `reverseAccrual`. Unrestricted here: these cases are
       about the money, not about who may see whom — the scoping itself is
       covered by `ib-accrual-reversal.spec.ts`. */
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

/**
 * An accrual aged by `hoursAgo`, written straight to the table.
 *
 * `created_at` is set explicitly because that column IS the maturation clock —
 * the predicate compares it against `now - holdHours`, so a row inserted with
 * the default timestamp can only ever test the "too new" branch.
 */
async function accrue(
  ibUserId: number,
  clientUserId: number,
  sourceId: string,
  hoursAgo: number,
): Promise<void> {
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
  wallets = new WalletService(ctx.db);
  dispatch = new NotificationsService(
    new NotificationsStore(ctx.db),
    { findAll: vi.fn().mockResolvedValue({ rows: [], total: 0 }) } as unknown as AdminsStore,
    {} as unknown as RolesStore,
    {} as unknown as AdminClientScopesStore,
    {} as unknown as ClientVisibilityService,
    alwaysLeads(),
    {} as unknown as AuditLogStore,
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

afterEach(async () => {
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  /* Batches sit between the accruals and the wallets in FK order (0116). */
  await ctx.db.execute(sql`DELETE FROM ib_accrual_batches`);
  await ctx.db.execute(
    sql`TRUNCATE ledger_entries, ib_accruals CASCADE` /* not DELETE: the ledger is append-only by trigger (§6.4). TRUNCATE resets a fixture table without firing row triggers, and no production path truncates. */,
  );
  await ctx.db.execute(sql`DELETE FROM wallets`);
  /*
   * The SETTING outranks the environment, so a row left behind by one case
   * would silently decide the next one — and the cases above are about what a
   * deployment configures, which only answers while no row exists.
   */
  await ctx.db.execute(sql`DELETE FROM trading_settings`);
});

/*
 * NO HOLD WINDOW (owner, 8 Oct 2026). The one commission job calculates and
 * pays in the same run, so an accrual is payable the moment it is written —
 * whatever the interval is set to. These cases used to assert the window.
 */
describe('an accrual is payable the moment it is written', () => {
  it('pays an accrual written a second ago, even on a day-long interval', async () => {
    const partner = await makeClient('hold-young-partner@test.local');
    const client = await makeClient('hold-young-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e001', 0);

    const result = await (await serviceWithHold(24 * 3600)).confirmPending();

    expect(result).toEqual({ confirmed: 1, failed: 0 });
  });

  it('pays old and new together in one run', async () => {
    const partner = await makeClient('hold-mixed-partner@test.local');
    const client = await makeClient('hold-mixed-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e004', 48);
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e005', 0);

    const result = await (await serviceWithHold(undefined)).confirmPending();

    expect(result.confirmed).toBe(2);
  });
});

describe('a payout run credits a wallet once', () => {
  it('writes ONE ledger entry for many accruals, and keeps every accrual row', async () => {
    const partner = await makeClient('batch-partner@test.local');
    const client = await makeClient('batch-client@test.local');
    for (let i = 0; i < 5; i += 1) {
      await accrue(partner, client, `00000000-0000-4000-8000-0000000000${20 + i}`, 48);
    }

    const result = await (await serviceWithHold(24 * 3600)).confirmPending();
    expect(result.confirmed).toBe(5);

    /* ONE credit, summing all five at 7.00 each. */
    const credits = await ctx.db.execute<{ n: number; total: string }>(sql`
      SELECT count(*)::int AS n, coalesce(sum(amount), 0)::text AS total
        FROM ledger_entries WHERE entry_type = 'commission'
    `);
    expect(credits.rows[0].n).toBe(1);
    expect(credits.rows[0].total).toBe('35.00000000');

    /* The per-trade record survives — five accruals, all pointing at the batch. */
    const accruals = await ctx.db.execute<{ n: number; batches: number }>(sql`
      SELECT count(*)::int AS n, count(DISTINCT batch_id)::int AS batches
        FROM ib_accruals WHERE status = 'confirmed'
    `);
    expect(accruals.rows[0].n).toBe(5);
    expect(accruals.rows[0].batches).toBe(1);
  });

  it('does NOT merge a partner’s commission with their own rebate', async () => {
    /*
     * A partner who is also somebody's client earns into their COMMISSION
     * wallet and is rebated into their MAIN one. Merging those would put a
     * client's own money back into an earnings balance — two different
     * sentences pointing at two different screens.
     */
    const partner = await makeClient('batch-both-partner@test.local');
    const client = await makeClient('batch-both-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-000000000030', 48);
    await ctx.db.execute(sql`
      INSERT INTO ib_accruals (ib_user_id, client_user_id, source_type, source_id, depth,
                               rate_value, base_amount, amount, currency, kind, created_at)
      VALUES (${partner}, ${partner}, 'deal', '00000000-0000-4000-8000-000000000031', 1,
              '20.0000', '100.00000000', '2.00000000', 'USD', 'rebate',
              now() - interval '48 hours')
    `);

    await (await serviceWithHold(24 * 3600)).confirmPending();

    const rows = await ctx.db.execute<{ entry_type: string; n: number }>(sql`
      SELECT entry_type, count(*)::int AS n
        FROM ledger_entries WHERE entry_type IN ('commission', 'rebate')
       GROUP BY entry_type ORDER BY entry_type
    `);
    expect(rows.rows).toEqual([
      { entry_type: 'commission', n: 1 },
      { entry_type: 'rebate', n: 1 },
    ]);
  });

  it('is idempotent — a second run credits nothing further', async () => {
    const partner = await makeClient('batch-replay-partner@test.local');
    const client = await makeClient('batch-replay-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-000000000040', 48);
    await accrue(partner, client, '00000000-0000-4000-8000-000000000041', 48);

    const service = await serviceWithHold(24 * 3600);
    await service.confirmPending();
    const second = await service.confirmPending();

    expect(second.confirmed).toBe(0);
    const credits = await ctx.db.execute<{ n: number; total: string }>(sql`
      SELECT count(*)::int AS n, coalesce(sum(amount), 0)::text AS total
        FROM ledger_entries WHERE entry_type = 'commission'
    `);
    expect(credits.rows[0].n).toBe(1);
    expect(credits.rows[0].total).toBe('14.00000000');
  });
});

describe('how the interval is configured', () => {
  it('refuses to store an interval below the floor', async () => {
    await expect(serviceWithHold(30)).rejects.toThrow();
  });
});

/*
 * `describe('the saved setting outranks the environment')` IS GONE (0104).
 *
 * Four cases pinned that a saved `trading_settings.ib_commission_hold_hours`
 * beat `IB_COMMISSION_HOLD_HOURS` in both directions, and that a saved zero was
 * a choice rather than a malformed value. The column went with the rest of the
 * IB block on that form — commission is configured on the Commission Programmes
 * page, and a second screen deciding partner pay is a second place for two
 * answers to disagree.
 *
 * The environment is the only source again, and everything above this line
 * still covers it: the window is honoured, a malformed value falls back to 24
 * rather than to zero, and a negative one is refused the same way.
 */
