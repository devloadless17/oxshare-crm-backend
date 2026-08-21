import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { CommissionService } from '../src/modules/ib/commission.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The CLIENT's leg — FR-IB-05's rebate — against real Postgres.
 *
 * ## Why this suite exists
 *
 * `rebate` sat in `ledgerEntryTypeEnum` for months with nothing writing one.
 * Every layer was individually fine: the enum had the value, the wallet service
 * accepted it, and the commission engine paid partners correctly. What did not
 * exist was the leg itself, and no unit test on either half could have shown
 * that — which is exactly the shape of the deal-feed gap that preceded it.
 *
 * So the assertions here are about the JOIN: that a hybrid programme produces
 * two rows from one trade, that confirmation pays them to two DIFFERENT people,
 * that the client's money lands in their MAIN wallet rather than a commission
 * one, and that re-running pays neither of them twice.
 *
 * Every one of these has a wrong version that balances perfectly and pays the
 * wrong party.
 */

let ctx: MoneyTestContext;
let commissions: CommissionService;

let partnerId: string;
let clientId: string;
let programId: string;

const POSITION_ID = '11111111-1111-4111-8111-111111111111';

async function makeUser(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${email.split('@')[0]}, 'Person')
    RETURNING id
  `);
  return rows[0].id;
}

/** Set the one programme both partners are on. */
async function setTerms(terms: {
  mode: 'commission_only' | 'rebate_only' | 'hybrid';
  level1Rate: string;
  rebateRate: string;
}): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE ib_programs
       SET mode = ${terms.mode}::ib_program_mode,
           level1_rate = ${terms.level1Rate},
           level2_rate = 0,
           rebate_rate = ${terms.rebateRate},
           enabled = true
     WHERE id = ${programId}
  `);
}

/** One closed trade on which the broker kept 100. */
async function accrue(sourceId = POSITION_ID): Promise<number> {
  return commissions.accrueForDeal({
    dealRowId: sourceId,
    ticket: '90210',
    clientUserId: clientId,
    brokerRevenue: '100.00000000',
    lots: '1.00000000',
    currency: 'USD',
  });
}

async function accrualRows() {
  const { rows } = await ctx.db.execute<{
    kind: string;
    ib_user_id: string;
    client_user_id: string;
    amount: string;
    status: string;
  }>(sql`
    SELECT kind, ib_user_id, client_user_id, amount, status
      FROM ib_accruals ORDER BY kind
  `);
  return rows;
}

async function walletsOf(userId: string) {
  const { rows } = await ctx.db.execute<{ kind: string; currency: string; balance: string }>(sql`
    SELECT kind, currency, balance FROM wallets WHERE user_id = ${userId} ORDER BY kind
  `);
  return rows;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  await ctx.db.execute(sql`
    INSERT INTO ib_levels (level, name, rate_value, enabled)
    VALUES (1, 'Master Partner', 0.0000, true)
    ON CONFLICT (level) DO UPDATE SET enabled = true
  `);

  const { rows } = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1`,
  );
  programId = rows[0].id;

  partnerId = await makeUser('rebate-partner@oxshare-e2e.test');
  clientId = await makeUser('rebate-client@oxshare-e2e.test');

  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, level, referral_code, active, program_id)
    VALUES (${partnerId}, 1, 'REBATE01', true, ${programId})
  `);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${partnerId} WHERE id = ${clientId}`,
  );

  commissions = new CommissionService(
    ctx.db,
    new WalletService(ctx.db),
    {
      notify: vi.fn().mockResolvedValue(undefined),
      notifyAdminsWithPermission: vi.fn().mockResolvedValue(undefined),
    },
    new ConfigService(),
    new AppSettingsStore(ctx.db),
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  /*
   * ACCRUALS FIRST. `ib_accruals.ledger_entry_id` references the entry that
   * paid it, so clearing the ledger first violates that key the moment a
   * previous case has confirmed anything — which made every test AFTER a
   * confirming one fail in its setup rather than its assertion.
   */
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  await ctx.db.execute(sql`DELETE FROM ledger_entries`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  /* The window is what stands between "earned" and "spendable"; these cases are
     about WHO is paid, so it is set to zero and confirmation runs immediately.
     The window itself is pinned in `ib-settlement.spec.ts`. */
  process.env['IB_COMMISSION_HOLD_HOURS'] = '0';
});

describe('a hybrid programme produces two legs from one trade', () => {
  it('writes a commission row and a rebate row', async () => {
    await setTerms({ mode: 'hybrid', level1Rate: '10', rebateRate: '5' });

    const created = await accrue();

    expect(created).toBe(2);
    const rows = await accrualRows();
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([
      ['commission', '10.00000000'],
      ['rebate', '5.00000000'],
    ]);
  });

  /*
   * THE attribution rule, at the row level. `ib_user_id` on a rebate names the
   * partner whose programme produced it; `client_user_id` names who is owed it.
   * Reading the first as the beneficiary pays the introducer their own client's
   * rebate — which balances, and is wrong about whose money it is.
   */
  it('attributes the rebate to the partner and owes it to the client', async () => {
    await setTerms({ mode: 'hybrid', level1Rate: '10', rebateRate: '5' });
    await accrue();

    const rebate = (await accrualRows()).find((r) => r.kind === 'rebate');
    expect(rebate?.ib_user_id).toBe(partnerId);
    expect(rebate?.client_user_id).toBe(clientId);
  });

  /*
   * One deal, one partner, two rows — which collide on
   * (source_type, source_id, ib_user_id) unless `kind` is part of the key. The
   * failure without it is silent: the ON CONFLICT drops the second row, and a
   * configured rebate simply never pays.
   */
  it('does not let the two rows collide on re-delivery', async () => {
    await setTerms({ mode: 'hybrid', level1Rate: '10', rebateRate: '5' });

    await accrue();
    const second = await accrue();

    expect(second).toBe(0);
    expect(await accrualRows()).toHaveLength(2);
  });
});

describe('confirmation pays each leg to the right person', () => {
  it('credits the partner’s commission wallet and the client’s main wallet', async () => {
    await setTerms({ mode: 'hybrid', level1Rate: '10', rebateRate: '5' });
    await accrue();

    const result = await commissions.confirmPending();
    expect(result.confirmed).toBe(2);

    expect(await walletsOf(partnerId)).toEqual([
      { kind: 'commission', currency: 'USD', balance: '10.00000000' },
    ]);
    /*
     * MAIN, not commission. A rebate is the client's own money coming back, not
     * an earning — putting it in a commission wallet would both mislabel it and
     * strand it behind a transfer the client has no reason to make.
     */
    expect(await walletsOf(clientId)).toEqual([
      { kind: 'main', currency: 'USD', balance: '5.00000000' },
    ]);
  });

  it('records the client’s leg as a rebate in the ledger', async () => {
    await setTerms({ mode: 'hybrid', level1Rate: '10', rebateRate: '5' });
    await accrue();
    await commissions.confirmPending();

    const { rows } = await ctx.db.execute<{ entry_type: string; amount: string }>(sql`
      SELECT e.entry_type, e.amount
        FROM ledger_entries e
        JOIN wallets w ON w.id = e.wallet_id
       WHERE w.user_id = ${clientId}
    `);

    expect(rows).toEqual([{ entry_type: 'rebate', amount: '5.00000000' }]);
  });

  it('pays neither leg twice when the loop runs again', async () => {
    await setTerms({ mode: 'hybrid', level1Rate: '10', rebateRate: '5' });
    await accrue();

    await commissions.confirmPending();
    const second = await commissions.confirmPending();

    expect(second.confirmed).toBe(0);
    expect(await walletsOf(clientId)).toEqual([
      { kind: 'main', currency: 'USD', balance: '5.00000000' },
    ]);
  });
});

describe('the mode decides which legs exist at all', () => {
  it('pays only the partner under commission_only', async () => {
    await setTerms({ mode: 'commission_only', level1Rate: '10', rebateRate: '5' });

    expect(await accrue()).toBe(1);
    expect((await accrualRows()).map((r) => r.kind)).toEqual(['commission']);
  });

  /*
   * A real arrangement — the broker buys volume by handing the spread back —
   * and the partner earning nothing on it is the point, not a misconfiguration.
   */
  it('pays only the client under rebate_only', async () => {
    await setTerms({ mode: 'rebate_only', level1Rate: '10', rebateRate: '5' });

    expect(await accrue()).toBe(1);
    expect((await accrualRows()).map((r) => r.kind)).toEqual(['rebate']);

    await commissions.confirmPending();
    expect(await walletsOf(partnerId)).toEqual([]);
    expect(await walletsOf(clientId)).toEqual([
      { kind: 'main', currency: 'USD', balance: '5.00000000' },
    ]);
  });
});
