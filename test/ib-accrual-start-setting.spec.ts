import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { DealCommissionService } from '../src/modules/trading/mt5/deal-commission.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The backlog decision comes from the SETTINGS; the environment is the fallback.
 *
 * ## Why it moved out of `IB_ACCRUAL_START`
 *
 * It decides how much trading history partners are paid for — a commercial
 * decision that lived where only a deploy could reach it. That is the same
 * objection that moved `ibCommissionHoldHours` onto `trading_settings`, where an
 * operator can both SEE it and change it.
 *
 * The stronger reason is the audit. This decision is IRREVERSIBLE: money paid
 * for a trade nobody meant to pay for comes back by conversation, not by
 * redeploy. An environment variable records no actor, no timestamp and no
 * reason — so the setting that most needs "who decided this, and when" was the
 * only one that could never answer it.
 *
 * ## Why these run against a real database, with a real aged backlog
 *
 * The resolution order is only OBSERVABLE when the two sources disagree AND
 * there is something to decide about. With an empty queue, "the setting won" and
 * "the environment won" produce an identical empty run — a test written that way
 * passes whichever source wins, which is the worst kind of green.
 *
 * So every case here seeds a trade older than the 48-hour backlog threshold. The
 * engine then either HOLDS (undecided) or proceeds (`all`), and those are
 * different answers.
 */

let ctx: MoneyTestContext;
let previous: string | undefined;

const LOGIN = '700100';

/** A settings row holding whatever this case is about. */
const settingsWith = (ibAccrualStart: string | null) =>
  ({ getTrading: () => Promise.resolve({ ibAccrualStart }) }) as never;

/** No row at all — a deployment that has never saved the form. */
const noRow = () => ({ getTrading: () => Promise.resolve(null) }) as never;

const commissions = () =>
  ({
    accrueForDeal: vi.fn().mockResolvedValue(0),
    accrueForClosedPosition: vi.fn(),
    accrueForSettledDeposit: vi.fn(),
  }) as never;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  previous = process.env['IB_ACCRUAL_START'];

  await ctx.db.execute(sql`DELETE FROM mt5_deals`);
  // A closed TRADE, three days old and never accrued — an aged backlog by the
  // engine's own 48-hour definition, which is the only state where the backlog
  // decision changes what a run does.
  await ctx.db.execute(sql`
    INSERT INTO mt5_deals
      (mt5_deal_id, login, symbol, action, entry, volume, price, profit, commission, swap,
       mt5_position_id, dealt_at)
    VALUES
      ('700001', ${LOGIN}, 'EURUSD', 0, 1, '1.00000000', '1.08542000', '0', '-10.00000000', '0',
       '900900', now() - interval '3 days')
  `);
});

afterEach(() => {
  if (previous === undefined) delete process.env['IB_ACCRUAL_START'];
  else process.env['IB_ACCRUAL_START'] = previous;
});

describe('where the backlog decision comes from', () => {
  it('the SETTING wins over the environment', async () => {
    /*
     * The case the move exists for. A stale variable on the box must not quietly
     * beat what an operator saved — the form would show one decision while the
     * engine acted on another, and nothing would report the disagreement.
     *
     * Undecided in the settings, `all` in the environment. The engine must HOLD.
     */
    process.env['IB_ACCRUAL_START'] = 'all';

    const service = new DealCommissionService(ctx.db, commissions(), settingsWith(null));
    const run = await service.accruePending();

    expect(run.awaitingBacklogDecision).toBe(true);
    expect(run.accrued).toBe(0);
  });

  it('an operator DECIDING releases the engine, whatever the environment says', async () => {
    // The mirror image, so neither case can pass by the engine simply always
    // holding on an aged backlog.
    delete process.env['IB_ACCRUAL_START'];

    const service = new DealCommissionService(ctx.db, commissions(), settingsWith('all'));
    const run = await service.accruePending();

    expect(run.awaitingBacklogDecision).toBe(false);
  });

  it('falls back to the ENVIRONMENT when no settings row exists', async () => {
    /*
     * A deployment configured before the column existed keeps behaving as it did
     * yesterday, rather than silently reverting to "undecided" and holding the
     * engine on the next deploy. The same fallback `holdHours` keeps.
     */
    process.env['IB_ACCRUAL_START'] = 'all';

    const service = new DealCommissionService(ctx.db, commissions(), noRow());
    const run = await service.accruePending();

    expect(run.awaitingBacklogDecision).toBe(false);
  });

  it('reads the setting FRESH on every run', async () => {
    /*
     * Never cached. An operator who has just made the decision should see the
     * NEXT run honour it, not wait out a TTL on the one job whose silence means
     * partners are not being paid.
     */
    const getTrading = vi.fn().mockResolvedValue({ ibAccrualStart: 'all' });
    const service = new DealCommissionService(ctx.db, commissions(), { getTrading } as never);

    await service.accruePending();
    await service.accruePending();

    expect(getTrading).toHaveBeenCalledTimes(2);
  });
});
