import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { DealCommissionService } from '../src/modules/trading/mt5/deal-commission.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * THE BACKLOG DECISION, and the guard that makes it safe to have no UI.
 *
 * ## What this is protecting against
 *
 * `mt5_deals` has been filled by ingestion since long before anything read it,
 * so the first run of the commission engine faces months of historical trades.
 * Left alone it pays partners for every one of them at once — and money paid for
 * a trade nobody meant to pay for comes back by conversation, not by redeploy.
 *
 * `IB_ACCRUAL_START` is the decision:
 *
 *   unset          an AGED backlog (>48h of unprocessed TRADE deals) STOPS the
 *                  run — nothing paid, nothing discarded
 *   `all`          pay the whole backlog, deliberately
 *   an ISO instant pay from there; older deals are marked decided and accrue
 *                  nothing
 *
 * ## Why it is an environment variable again
 *
 * It was a `trading_settings` column for a while, so an operator could see it
 * and the change was audited. That column went in 0104 with the rest of the IB
 * block on the Trading settings form: commission is configured on the Commission
 * Programmes page, and a second screen that also decides partner pay is a second
 * place for two answers to disagree.
 *
 * The decision is still deliberate — by being a deploy rather than by being a
 * dialog. What must NOT change is the guard, which is what this file exists to
 * hold: with nothing set, the engine holds rather than paying history.
 *
 * ## Why these run against a real database, with a real aged backlog
 *
 * The behaviour is only OBSERVABLE when there is something to decide about. With
 * an empty queue, "held" and "released" produce an identical empty run — a test
 * written that way passes either way, which is the worst kind of green.
 *
 * So every case here seeds a trade older than the 48-hour threshold.
 */

let ctx: MoneyTestContext;
let previous: string | undefined;

const LOGIN = '700100';

const commissions = () =>
  ({
    accrueForDeal: vi.fn().mockResolvedValue(0),
    accrueForClosedPosition: vi.fn(),
    accrueForSettledDeposit: vi.fn(),
  }) as never;

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  /*
   * A LINKED account, and it is not decoration.
   *
   * An orphaned TRADE — a login no `trading_accounts` row claims — is excluded
   * by the batch query itself, before the backlog branch is reached. So a
   * fixture without this account can assert that the engine HOLDS (which is
   * computed from a separate count) but never that it marks a predating deal
   * decided, because the deal never enters the loop at all.
   */
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES ('backlog-client@oxshare-e2e.test', 'x', 'Backlog', 'Client')
    RETURNING id
  `);
  await ctx.db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency)
    VALUES (${rows[0].id}, ${LOGIN}, 'USD')
  `);
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

describe('the backlog decision', () => {
  /*
   * ⚠️ THE ONE THAT MATTERS, and the reason removing the settings field was
   * safe. Unset means NOBODY HAS DECIDED, and the engine refuses to guess.
   *
   * If this ever goes green the other way, a deployment pays every partner for
   * every historical trade the moment it starts.
   */
  it('HOLDS an aged backlog when nobody has decided', async () => {
    delete process.env['IB_ACCRUAL_START'];

    const run = await new DealCommissionService(ctx.db, commissions()).accruePending();

    expect(run.awaitingBacklogDecision).toBe(true);
    expect(run.accrued).toBe(0);
  });

  /*
   * The mirror, so the case above cannot pass by the engine simply always
   * holding on an aged backlog.
   */
  it('releases the engine when the whole backlog is chosen deliberately', async () => {
    process.env['IB_ACCRUAL_START'] = 'all';

    const run = await new DealCommissionService(ctx.db, commissions()).accruePending();

    expect(run.awaitingBacklogDecision).toBe(false);
  });

  /*
   * An instant pays from there and marks everything older decided-and-unpaid —
   * the ordinary answer, and the one a broker going live actually wants.
   */
  it('pays from an instant, and decides everything older without paying it', async () => {
    process.env['IB_ACCRUAL_START'] = new Date(Date.now() - 60_000).toISOString();

    const run = await new DealCommissionService(ctx.db, commissions()).accruePending();

    expect(run.awaitingBacklogDecision).toBe(false);
    expect(run.predating).toBe(1);
    expect(run.accrued).toBe(0);
  });

  /*
   * ⚠️ AN UNPARSEABLE VALUE FALLS BACK TO UNSET, never to "nothing is in
   * scope". The second reading would mark every trade decided and discard the
   * commission PERMANENTLY — the one outcome that cannot be undone by fixing
   * the value.
   */
  it('holds rather than discarding when the value is malformed', async () => {
    process.env['IB_ACCRUAL_START'] = 'not-a-date';

    const run = await new DealCommissionService(ctx.db, commissions()).accruePending();

    expect(run.awaitingBacklogDecision).toBe(true);
    expect(run.predating).toBe(0);
  });

  /*
   * Read FRESH on every run. An operator who has just made the decision should
   * see the next run honour it — this job's silence means partners are not
   * being paid, so it is the last place a cached answer belongs.
   */
  it('reads the decision on every run, never caching it', async () => {
    delete process.env['IB_ACCRUAL_START'];
    const service = new DealCommissionService(ctx.db, commissions());

    expect((await service.accruePending()).awaitingBacklogDecision).toBe(true);

    process.env['IB_ACCRUAL_START'] = 'all';

    expect((await service.accruePending()).awaitingBacklogDecision).toBe(false);
  });
});
