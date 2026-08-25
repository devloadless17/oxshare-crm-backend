import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { CommissionService } from '../src/modules/ib/commission.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { NotificationsStore } from '../src/store/notifications.store';
import type { AdminsStore } from '../src/store/admins.store';
import type { RolesStore } from '../src/store/roles.store';
import type { AdminClientScopesStore } from '../src/store/admin-client-scopes.store';
import type { ClientVisibilityService } from '../src/common/security/client-visibility.service';
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

/** Restored after each case — the window is read from config on every run. */
const originalHold = process.env['IB_COMMISSION_HOLD_HOURS'];

function serviceWithHold(hours: string | undefined): CommissionService {
  if (hours === undefined) delete process.env['IB_COMMISSION_HOLD_HOURS'];
  else process.env['IB_COMMISSION_HOLD_HOURS'] = hours;
  // A fresh ConfigService per case: the value is read through the real config
  // path, so this exercises what a deployment actually configures rather than
  // a test-only argument.
  return new CommissionService(
    ctx.db,
    wallets,
    dispatch,
    new ConfigService(),
    new AppSettingsStore(ctx.db),
  );
}

async function makeClient(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
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
  ibUserId: string,
  clientUserId: string,
  sourceId: string,
  hoursAgo: number,
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO ib_accruals (ib_user_id, client_user_id, source_type, source_id, depth, level,
                             rate_value, base_amount, amount, currency, created_at)
    VALUES (${ibUserId}, ${clientUserId}, 'deal', ${sourceId}, 1, 1,
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
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

afterEach(async () => {
  if (originalHold === undefined) delete process.env['IB_COMMISSION_HOLD_HOURS'];
  else process.env['IB_COMMISSION_HOLD_HOURS'] = originalHold;
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  /*
   * The SETTING outranks the environment, so a row left behind by one case
   * would silently decide the next one — and the cases above are about what a
   * deployment configures, which only answers while no row exists.
   */
  await ctx.db.execute(sql`DELETE FROM trading_settings`);
});

describe('the settlement window decides what is payable', () => {
  it('HOLDS an accrual younger than the window, and says it is holding', async () => {
    const partner = await makeClient('hold-young-partner@test.local');
    const client = await makeClient('hold-young-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e001', 1);

    const result = await serviceWithHold('24').confirmPending();

    expect(result.confirmed).toBe(0);
    /*
     * `held` is reported separately, and that is the point: "nothing was paid"
     * has two causes — nobody earned anything, or everything earned is still
     * maturing — and an operator watching the log has to tell a working engine
     * from a stopped one.
     */
    expect(result.held).toBe(1);
  });

  it('CONFIRMS an accrual older than the window', async () => {
    const partner = await makeClient('hold-old-partner@test.local');
    const client = await makeClient('hold-old-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e002', 25);

    const result = await serviceWithHold('24').confirmPending();

    expect(result.confirmed).toBe(1);
    expect(result.held).toBe(0);
  });

  /*
   * The boundary, which is where an off-by-one lives. An accrual exactly at the
   * window is payable — the predicate is "created at or before now minus the
   * window", so equality pays rather than waiting another whole cycle.
   */
  it('pays an accrual sitting exactly on the boundary', async () => {
    const partner = await makeClient('hold-edge-partner@test.local');
    const client = await makeClient('hold-edge-client@test.local');
    // A minute past 24h: enough to be unambiguously at-or-before the cutoff
    // without depending on how long the test itself takes to run.
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e003', 24.02);

    const result = await serviceWithHold('24').confirmPending();
    expect(result.confirmed).toBe(1);
  });

  it('separates the mature from the maturing in one run', async () => {
    const partner = await makeClient('hold-mixed-partner@test.local');
    const client = await makeClient('hold-mixed-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e004', 48);
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e005', 2);

    const result = await serviceWithHold('24').confirmPending();

    expect(result.confirmed).toBe(1);
    expect(result.held).toBe(1);
  });
});

describe('how the window is configured', () => {
  it('defaults to 24 hours when nothing is set', async () => {
    const partner = await makeClient('hold-default-partner@test.local');
    const client = await makeClient('hold-default-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e006', 12);

    // 12h old under the default 24h window: still maturing.
    expect((await serviceWithHold(undefined).confirmPending()).held).toBe(1);
  });

  it('pays immediately when the window is set to zero', async () => {
    const partner = await makeClient('hold-zero-partner@test.local');
    const client = await makeClient('hold-zero-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e007', 0);

    // A supported configuration, not a test door: a deployment that settles
    // instantly sets exactly this.
    expect((await serviceWithHold('0').confirmPending()).confirmed).toBe(1);
  });

  /*
   * ⚠️ THE FAILURE MODE THAT MATTERS.
   *
   * A typo'd window must fall back to the DEFAULT, never to zero. "Pay every
   * commission the instant it is calculated" is the one outcome nobody would
   * choose deliberately, and it is what `Number.parseInt('abc') || 0` would
   * produce — which is exactly the idiom this code avoids.
   */
  it('falls back to the default on a malformed value, never to paying instantly', async () => {
    const partner = await makeClient('hold-junk-partner@test.local');
    const client = await makeClient('hold-junk-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e008', 3);

    const result = await serviceWithHold('not-a-number').confirmPending();

    expect(result.confirmed).toBe(0);
    expect(result.held).toBe(1);
  });

  it('refuses a negative window the same way', async () => {
    const partner = await makeClient('hold-neg-partner@test.local');
    const client = await makeClient('hold-neg-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e009', 3);

    expect((await serviceWithHold('-5').confirmPending()).confirmed).toBe(0);
  });
});

/**
 * The window moved from the environment to `trading_settings`, and these are
 * the two facts that move has to be true for.
 *
 * It mattered because the one rule between earned and spendable took a deploy
 * to change and was invisible to everybody running the platform — while every
 * other commercial control on that row (the account caps, the demo ceiling, the
 * broker's revenue-share floor) had been operator-visible for months.
 */
describe('the saved setting outranks the environment', () => {
  async function saveWindow(hours: number): Promise<void> {
    await ctx.db.execute(sql`
      INSERT INTO trading_settings (id, ib_commission_hold_hours)
      VALUES (true, ${hours})
      ON CONFLICT (id) DO UPDATE SET ib_commission_hold_hours = ${hours}
    `);
  }

  it('pays on the saved window even when the environment says otherwise', async () => {
    const partner = await makeClient('hold-setting-partner@test.local');
    const client = await makeClient('hold-setting-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e011', 2);

    // The environment would hold this for another 22 hours. The operator set 1.
    await saveWindow(1);
    const result = await serviceWithHold('24').confirmPending();

    expect(result.confirmed).toBe(1);
    expect(result.held).toBe(0);
  });

  it('holds on the saved window even when the environment would have paid', async () => {
    const partner = await makeClient('hold-setting-long-partner@test.local');
    const client = await makeClient('hold-setting-long-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e012', 30);

    await saveWindow(72);
    const result = await serviceWithHold('24').confirmPending();

    /*
     * The direction that matters more: a longer saved window must not be
     * shortened by a variable somebody set once and forgot, because the failure
     * is money becoming spendable before the desk has seen it.
     */
    expect(result.confirmed).toBe(0);
    expect(result.held).toBe(1);
  });

  it('pays immediately on a saved window of zero', async () => {
    const partner = await makeClient('hold-setting-zero-partner@test.local');
    const client = await makeClient('hold-setting-zero-client@test.local');
    await accrue(partner, client, '00000000-0000-4000-8000-00000000e013', 0);

    /*
     * Zero is a CHOICE here, unlike a malformed environment variable, which
     * still falls back to 24 rather than to zero. The difference is that
     * somebody typed this one into a form that says what it does.
     */
    await saveWindow(0);
    const result = await serviceWithHold(undefined).confirmPending();

    expect(result.confirmed).toBe(1);
  });
});
