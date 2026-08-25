import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { CommissionService } from '../src/modules/ib/commission.service';
import { DealCommissionService } from '../src/modules/trading/mt5/deal-commission.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CommissionRefusedError } from '../src/common/provisioning/commission-accrual.port';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/*
 * The backlog decision now lives in `trading_settings`, with the environment as
 * the fallback for a deployment configured before the column existed. These
 * suites drive the ENGINE, so they hand it a store with no row and keep setting
 * `IB_ACCRUAL_START` — which is exactly the fallback path, and the one every
 * existing deployment is on until an operator saves the form.
 */
const noSettingsRow = () => ({ getTrading: () => Promise.resolve(null) }) as never;

/**
 * The deal → commission seam, against real Postgres.
 *
 * ## Why this suite exists
 *
 * Before it, NO COMMISSION HAD EVER BEEN ACCRUED by any path. `mt5_deals` had
 * one writer and no readers; the engine accrued on `PositionsService.close`,
 * which nothing called. The pipeline reported success at every stage while
 * producing nothing, which is exactly the shape of bug a unit test on either
 * half would have missed — both halves were individually fine.
 *
 * So the assertions here are about the JOIN between them: that an ingested deal
 * becomes an accrual, that re-delivery does not pay twice, and that the cases
 * which must be retried are left in the queue rather than marked done.
 */

let ctx: MoneyTestContext;
let commissions: CommissionService;
let deals: DealCommissionService;

let partnerId: string;
let clientId: string;
/** A client nobody introduced — real trades, nobody earns. */
let unreferredId: string;

const LOGIN = '5000001';
const UNREFERRED_LOGIN = '5000002';
/** Ingested, never linked to a trading account. */
const ORPHAN_LOGIN = '5009999';

async function makeUser(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${email.split('@')[0]}, 'Person')
    RETURNING id
  `);
  return rows[0].id;
}

/** One deal as the bridge would have delivered it. Amounts are MT5-signed. */
async function ingest(deal: {
  ticket: string;
  login: string;
  commission: string;
  swap: string;
  action?: number;
  entry?: number;
  volume?: string;
  /** Ties the legs of one round turn together. */
  positionId?: string;
  /**
   * How far in the past MT5 says this happened.
   *
   * The queue is drained OLDEST FIRST, so anything asserting that a payable
   * deal is reached past a stuck one has to control the order rather than trust
   * the millisecond two inserts happened to land on.
   */
  secondsAgo?: number;
}): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO mt5_deals
      (mt5_deal_id, login, symbol, action, entry, volume, price, profit, commission, swap,
       mt5_position_id, dealt_at)
    VALUES
      (${deal.ticket}, ${deal.login}, 'EURUSD', ${deal.action ?? 0}, ${deal.entry ?? 1},
       ${deal.volume ?? '1.00000000'}, '1.08542000', '0', ${deal.commission}, ${deal.swap},
       ${deal.positionId ?? null},
       now() - ((${deal.secondsAgo ?? 0})::text || ' seconds')::interval)
    RETURNING id
  `);
  return rows[0].id;
}

/**
 * The retry record 0092 added — what a failure wrote on the row.
 *
 * `dueInMs` rather than the raw column, because this path returns a timestamptz
 * as a STRING: typing it `Date` compiles and then fails at the first `getTime`,
 * which is a test that looks written and is not.
 */
async function retryState(dealRowId: string) {
  const { rows } = await ctx.db.execute<{
    commission_attempts: number;
    commission_retry_after: string | null;
    commission_last_error: string | null;
  }>(sql`
    SELECT commission_attempts, commission_retry_after, commission_last_error
      FROM mt5_deals WHERE id = ${dealRowId}
  `);

  const row = rows[0];
  return {
    ...row,
    dueInMs: row.commission_retry_after
      ? new Date(row.commission_retry_after).getTime() - Date.now()
      : null,
  };
}

/**
 * Make a deferred deal due again, as the clock would.
 *
 * The alternative is a test that sleeps for the backoff, which is a minute on
 * the first failure and an hour by the fifth — so the delay is asserted from
 * the row and then stepped over, rather than waited out.
 */
async function makeDue(dealRowId: string): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE mt5_deals SET commission_retry_after = now() - interval '1 second'
         WHERE id = ${dealRowId}`,
  );
}

/** A service whose accrual always refuses — a wrong rate, in one object. */
function refusingService(): DealCommissionService {
  return new DealCommissionService(
    ctx.db,
    {
      accrueForDeal: vi
        .fn()
        .mockRejectedValue(new CommissionRefusedError('total exceeds the revenue')),
      accrueForClosedPosition: vi.fn(),
      accrueForSettledDeposit: vi.fn(),
    },
    noSettingsRow(),
  );
}

/** Has an accrual taken this deal's revenue yet? */
async function isProcessed(dealRowId: string): Promise<boolean> {
  const { rows } = await ctx.db.execute<{ processed: boolean }>(sql`
    SELECT (commission_processed_at IS NOT NULL) AS processed
      FROM mt5_deals WHERE id = ${dealRowId}
  `);
  return rows[0].processed;
}

async function accrualsFor(dealRowId: string) {
  const { rows } = await ctx.db.execute<{
    amount: string;
    ib_user_id: string;
    base_amount: string;
  }>(
    sql`SELECT amount, ib_user_id, base_amount FROM ib_accruals
         WHERE source_type = 'deal' AND source_id = ${dealRowId}`,
  );
  return rows;
}

async function processedAt(dealRowId: string): Promise<Date | null> {
  const { rows } = await ctx.db.execute<{ commission_processed_at: Date | null }>(
    sql`SELECT commission_processed_at FROM mt5_deals WHERE id = ${dealRowId}`,
  );
  return rows[0].commission_processed_at;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  /*
   * A rate WELL UNDER the broker's revenue-share cap, which defaults to 50%.
   *
   * At 70% every figure below would come back scaled down to the ceiling, and
   * the suite would be asserting the cap rather than the seam it is about. What
   * the cap does is covered in `commission.spec.ts`.
   *
   * Upserted because migrations already seed a level 1.
   */
  await ctx.db.execute(sql`
    INSERT INTO ib_levels (level, name, rate_value, enabled)
    VALUES (1, 'Master Partner', 30.0000, true)
    ON CONFLICT (level) DO UPDATE
       SET rate_value = 30.0000, enabled = true, name = 'Master Partner'
  `);

  /*
   * The RATE lives on the programme, not the rung.
   *
   * The ladder row above still has to exist — `ib_accounts.level` references it
   * — but since migration 0084 it decides placement and nothing else. Setting
   * only `ib_levels.rate_value` here left every figure below reading whatever
   * the seeded Default programme happened to carry, which is how this fixture
   * silently stopped controlling the number it exists to control.
   */
  await ctx.db.execute(sql`
    UPDATE ib_programs
       SET mode = 'commission_only',
           level1_rate = 30.0000,
           level2_rate = 0.0000,
           rebate_rate = 0.0000,
           enabled = true
     WHERE id = (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1)
  `);

  partnerId = await makeUser('deal-partner@oxshare-e2e.test');
  clientId = await makeUser('deal-client@oxshare-e2e.test');
  unreferredId = await makeUser('deal-unreferred@oxshare-e2e.test');

  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, level, referral_code, active, program_id) VALUES (${partnerId}, 1, 'DEALPART', true, (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))
  `);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${partnerId} WHERE id = ${clientId}`,
  );

  await ctx.db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency)
    VALUES (${clientId}, ${LOGIN}, 'USD'), (${unreferredId}, ${UNREFERRED_LOGIN}, 'USD')
  `);

  commissions = new CommissionService(
    ctx.db,
    new WalletService(ctx.db),
    // Never reached by ACCRUAL — the bell row is written by `confirmPending`,
    // which this suite does not run. Present because the constructor asks.
    {
      notify: vi.fn().mockResolvedValue(undefined),
      notifyAdminsWithPermission: vi.fn().mockResolvedValue(undefined),
    },
    new ConfigService(),
    new AppSettingsStore(ctx.db),
  );
  deals = new DealCommissionService(ctx.db, commissions, noSettingsRow());
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  await ctx.db.execute(sql`DELETE FROM mt5_deals`);
});

describe('an ingested deal pays the partner behind the client', () => {
  it('accrues on a deal whose commission the broker kept', async () => {
    const id = await ingest({
      ticket: '90210',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    const run = await deals.accruePending();

    expect(run.accrued).toBe(1);
    expect(run.accrualRows).toBe(1);

    const [accrual] = await accrualsFor(id);
    expect(accrual.ib_user_id).toBe(partnerId);
    // 30% of the 10.00 the broker kept. Not of the client's volume or profit.
    expect(accrual.amount).toBe('3.00000000');
    expect(accrual.base_amount).toBe('10.00000000');
  });

  /*
   * ── COMMISSION IS EARNED ON A CLOSED POSITION ──────────────────────────────
   *
   * FR-IB-04: computed "on the closing of a deal — never on its opening".
   *
   * This suite used to assert the opposite, and the reasoning was sound about
   * the MONEY and wrong about the RULE: a round turn is often charged in two
   * halves, so paying only the closing row's own commission underpays by the
   * entry charge. The answer is not to pay at open — it is to pay at close on
   * the WHOLE position, which is what the three cases below pin.
   */
  it('accrues nothing on an opening deal, and leaves it for its close', async () => {
    const opening = await ingest({
      ticket: '90211',
      login: LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      entry: 0, // ENTRY_IN
      positionId: 'P-1',
    });

    const run = await deals.accruePending();

    expect(await accrualsFor(opening)).toHaveLength(0);
    /* Not merely skipped — never QUEUED. See the starvation case below. */
    expect(run.examined).toBe(0);
    /*
     * UNPROCESSED, and that is the load-bearing half. Marking it done would
     * discard the entry commission, so the close would pay on its own row alone
     * — underpaying every partner by the open leg of every trade.
     */
    expect(await isProcessed(opening)).toBe(false);
  });

  /*
   * ── THE STARVATION CASE ────────────────────────────────────────────────────
   *
   * Open legs must stay unprocessed, and the first version of this rule did
   * that by SKIPPING them inside the loop — which left them at the front of an
   * oldest-first queue for as long as their positions ran. A broker holding a
   * batch's worth of positions open filled every batch with rows that could
   * never complete, and no closing deal was ever reached again: commission
   * stopped for everybody, silently.
   *
   * The batch limit is two here so the condition fits in a test; in production
   * it is two hundred, and a real book reaches that easily. The assertion is
   * that a close BEHIND a full batch of open legs still gets paid.
   */
  it('reaches a closing deal queued behind a full batch of open legs', async () => {
    await ingest({
      ticket: '90240',
      login: LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      entry: 0,
      positionId: 'P-OPEN-1',
    });
    await ingest({
      ticket: '90241',
      login: LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      entry: 0,
      positionId: 'P-OPEN-2',
    });
    const closing = await ingest({
      ticket: '90242',
      login: LOGIN,
      commission: '-5.00000000',
      swap: '0.00000000',
      entry: 1,
      positionId: 'P-CLOSED',
    });

    // A batch the two open legs would have filled entirely.
    const run = await deals.accruePending(2);

    expect(run.accrued).toBe(1);
    expect((await accrualsFor(closing))[0].amount).toBe('1.50000000');
  });

  it('pays the whole position when it closes, entry charge included', async () => {
    await ingest({
      ticket: '90220',
      login: LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      entry: 0, // ENTRY_IN
      positionId: 'P-2',
    });
    const closing = await ingest({
      ticket: '90221',
      login: LOGIN,
      commission: '-6.00000000',
      swap: '0.00000000',
      entry: 1, // ENTRY_OUT
      positionId: 'P-2',
    });

    await deals.accruePending();

    const [accrual] = await accrualsFor(closing);
    // 30% of the 10.00 the broker kept across BOTH legs — not of the 6.00 on
    // the closing row alone.
    expect(accrual.amount).toBe('3.00000000');
    expect(accrual.base_amount).toBe('10.00000000');
  });

  /*
   * THE double-payment case. The first close consumes the opener; the second
   * must not consume it again — summing the whole position both times would pay
   * the entry charge twice on every partially closed trade.
   */
  it('does not pay the entry charge twice across a partial close', async () => {
    await ingest({
      ticket: '90230',
      login: LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      entry: 0, // ENTRY_IN
      positionId: 'P-3',
    });
    const firstClose = await ingest({
      ticket: '90231',
      login: LOGIN,
      commission: '-3.00000000',
      swap: '0.00000000',
      entry: 1,
      positionId: 'P-3',
    });

    await deals.accruePending();
    expect((await accrualsFor(firstClose))[0].base_amount).toBe('7.00000000');

    const secondClose = await ingest({
      ticket: '90232',
      login: LOGIN,
      commission: '-3.00000000',
      swap: '0.00000000',
      entry: 1,
      positionId: 'P-3',
    });

    await deals.accruePending();

    // Its own 3.00 only. The opener was already paid for by the first close.
    expect((await accrualsFor(secondClose))[0].base_amount).toBe('3.00000000');
  });

  it('counts a swap the client was charged, and not one they were paid', async () => {
    const charged = await ingest({
      ticket: '90212',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '-5.00000000',
    });
    const credited = await ingest({
      ticket: '90213',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '5.00000000',
    });

    await deals.accruePending();

    // 30% of 15.00 — the broker kept both.
    expect((await accrualsFor(charged))[0].amount).toBe('4.50000000');
    // 30% of 10.00 — the broker PAID the swap out, so it is not revenue.
    expect((await accrualsFor(credited))[0].amount).toBe('3.00000000');
  });
});

describe('re-delivery cannot pay twice', () => {
  it('creates no second accrual when the whole run repeats', async () => {
    const id = await ingest({
      ticket: '90220',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    await deals.accruePending();
    // The deal is marked, so a second drain does not even see it.
    const second = await deals.accruePending();

    expect(second.examined).toBe(0);
    expect(await accrualsFor(id)).toHaveLength(1);
  });

  it('creates no second accrual even if the deal is re-queued', async () => {
    /*
     * The marker is a queue, not the guarantee. Clearing it simulates a crash
     * between the accrual and the mark — the real protection is
     * `ib_accruals_source_earner_uq`, and this is what proves it holds.
     */
    const id = await ingest({
      ticket: '90221',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    await deals.accruePending();
    await ctx.db.execute(sql`UPDATE mt5_deals SET commission_processed_at = NULL WHERE id = ${id}`);
    const rerun = await deals.accruePending();

    expect(await accrualsFor(id)).toHaveLength(1);
    // It ran and found nothing new to create — not an error, and not a payment.
    expect(rerun.accrualRows).toBe(0);
  });
});

describe('what is finished, and what waits', () => {
  it('leaves an unlinked login queued so it accrues once the account exists', async () => {
    const id = await ingest({
      ticket: '90230',
      login: ORPHAN_LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    const first = await deals.accruePending();
    expect(first.orphaned).toBe(1);
    expect(await processedAt(id)).toBeNull();
    expect(await accrualsFor(id)).toHaveLength(0);
    expect(await deals.orphanBacklog()).toBe(1);

    // The account is linked, which is the ordinary onboarding sequence.
    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, login, currency)
      VALUES (${clientId}, ${ORPHAN_LOGIN}, 'USD')
    `);

    const second = await deals.accruePending();

    expect(second.accrued).toBe(1);
    expect(await accrualsFor(id)).toHaveLength(1);

    await ctx.db.execute(sql`DELETE FROM trading_accounts WHERE login = ${ORPHAN_LOGIN}`);
  });

  it('finishes a balance operation without accruing on it', async () => {
    // action 2 is DEAL_BALANCE — the client's own deposit, not revenue.
    const id = await ingest({
      ticket: '90231',
      login: LOGIN,
      commission: '0.00000000',
      swap: '0.00000000',
      action: 2,
    });

    const run = await deals.accruePending();

    expect(run.nothingOwed).toBe(1);
    expect(await accrualsFor(id)).toHaveLength(0);
    // Marked, so it never comes back — a queue that kept returning these would
    // grow forever while looking like it was draining.
    expect(await processedAt(id)).not.toBeNull();
  });

  it('finishes a trade the broker earned nothing on', async () => {
    const id = await ingest({
      ticket: '90232',
      login: LOGIN,
      commission: '0.00000000',
      swap: '0.00000000',
    });

    const run = await deals.accruePending();

    expect(run.nothingOwed).toBe(1);
    expect(await processedAt(id)).not.toBeNull();
  });

  it('finishes a deal for a client nobody introduced', async () => {
    const id = await ingest({
      ticket: '90233',
      login: UNREFERRED_LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    const run = await deals.accruePending();

    expect(run.nothingOwed).toBe(1);
    expect(await accrualsFor(id)).toHaveLength(0);
    // Zero is the CORRECT answer here, not a failure, so the deal is done.
    expect(await processedAt(id)).not.toBeNull();
  });

  it('leaves a deal queued when the engine refuses it', async () => {
    /*
     * A refusal means "something was owed and the amount did not survive the
     * §12.4 check" — a settings mistake. The deal must stay queued so it pays
     * once a human fixes the rate, which is the behaviour ALERT_THRESHOLDS
     * already described and nothing implemented.
     */
    const id = await ingest({
      ticket: '90240',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    const run = await refusingService().accruePending();

    expect(run.failed).toBe(1);
    expect(await processedAt(id)).toBeNull();

    /*
     * Queued but NOT due. Retrying a refusal immediately is what let a wrong
     * rate stop commission for everybody — see the starvation test below — so
     * the deal comes back on a delay rather than on the very next run.
     */
    const deferred = await retryState(id);
    expect(deferred.commission_attempts).toBe(1);
    expect(deferred.dueInMs!).toBeGreaterThan(0);
    expect(deferred.commission_last_error).toContain('exceeds the revenue');

    // Still owed, and still counted, so nothing about it is quiet.
    expect(await deals.backlog()).toBe(1);
    expect((await deals.accruePending()).deferred).toBe(1);

    // And the real engine pays it in full once the delay is up — which is what
    // makes the backoff a delay rather than a write-off.
    await makeDue(id);
    expect((await deals.accruePending()).accrued).toBe(1);
    expect((await accrualsFor(id))[0].amount).toBe('3.00000000');
  });

  it('backs a repeatedly refused deal off further each time', async () => {
    const id = await ingest({
      ticket: '90241',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    const refusing = refusingService();

    await refusing.accruePending();
    const first = await retryState(id);

    await makeDue(id);
    await refusing.accruePending();
    const second = await retryState(id);

    /*
     * The count is what the delay is computed from, and it is read from the ROW
     * rather than from anything this process remembers — two instances may each
     * have failed the same deal, and the backoff should reflect how often it
     * actually failed.
     */
    expect(first.commission_attempts).toBe(1);
    expect(second.commission_attempts).toBe(2);

    // Doubling: ~1 minute, then ~2. Asserted as "longer", not as an exact
    // instant, because the two runs are seconds apart on a real clock.
    expect(second.dueInMs!).toBeGreaterThan(first.dueInMs!);
  });
});

/**
 * ── THE QUEUE CANNOT BE STARVED BY WORK IT CANNOT DO ──────────────────────
 *
 * The batch is bounded and drained oldest-first, so any deal left unmarked sits
 * at the FRONT of it until something changes. Open legs were taken out of the
 * queue in SQL for exactly that reason, and two other kinds of row were still
 * skipped inside the loop:
 *
 *   * a deal whose login no trading account claims — which for a manager's own
 *     login or a broker-side test account is never linked at all;
 *   * a deal the engine REFUSED — a settings mistake, which by definition fails
 *     identically on every run until a human changes a rate.
 *
 * A batch's worth of either and no payable deal is ever reached again:
 * commission stops for everybody, silently, and it gets worse the busier the
 * platform is.
 *
 * The batch limit is two here so the condition fits in a test; in production it
 * is two hundred and a real book reaches that easily. Every assertion below is
 * the same one: a payable deal BEHIND a full batch of stuck ones still gets
 * paid.
 */
describe('a stuck deal does not block the ones behind it', () => {
  it('reaches a payable deal queued behind a full batch of unlinked logins', async () => {
    await ingest({
      ticket: '90260',
      login: ORPHAN_LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      secondsAgo: 300,
    });
    await ingest({
      ticket: '90261',
      login: ORPHAN_LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      secondsAgo: 240,
    });
    const payable = await ingest({
      ticket: '90262',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    // A batch the two orphans would have filled entirely.
    const run = await deals.accruePending(2);

    expect(run.accrued).toBe(1);
    expect((await accrualsFor(payable))[0].amount).toBe('3.00000000');

    // Held out of the batch, not lost: still queued, still counted, and still
    // the number that reaches an operator.
    expect(run.orphaned).toBe(2);
    expect(await deals.orphanBacklog()).toBe(2);
  });

  it('reaches a payable deal queued behind a full batch of refused ones', async () => {
    await ingest({
      ticket: '90263',
      login: LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      secondsAgo: 300,
    });
    await ingest({
      ticket: '90264',
      login: LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      secondsAgo: 240,
    });

    // The wrong rate is in place, and both deals fail against it.
    expect((await refusingService().accruePending(2)).failed).toBe(2);

    const payable = await ingest({
      ticket: '90265',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    /*
     * The rate is still wrong. Before the backoff, this run would have re-tried
     * the same two oldest deals, failed identically, and never reached the deal
     * behind them — for as long as nobody noticed.
     */
    const run = await deals.accruePending(2);

    expect(run.accrued).toBe(1);
    expect((await accrualsFor(payable))[0].amount).toBe('3.00000000');
    expect(run.deferred).toBe(2);
  });

  it('finishes a balance operation on an unlinked login rather than stranding it', async () => {
    /*
     * The orphan filter must not swallow these. A deposit reaches MT5 as a
     * balance deal and earns nobody anything, so it is DONE — and holding it
     * back on the "no account claims this login" rule would strand it in
     * exactly the way that rule exists to prevent.
     */
    const id = await ingest({
      ticket: '90266',
      login: ORPHAN_LOGIN,
      commission: '0.00000000',
      swap: '0.00000000',
      action: 2,
    });

    const run = await deals.accruePending();

    expect(run.nothingOwed).toBe(1);
    expect(await processedAt(id)).not.toBeNull();
    expect(await deals.backlog()).toBe(0);
  });
});

describe('the backlog is countable', () => {
  it('reports what is queued and how much of it is waiting on a human', async () => {
    await ingest({
      ticket: '90250',
      login: LOGIN,
      commission: '-1.00000000',
      swap: '0.00000000',
    });
    await ingest({
      ticket: '90251',
      login: ORPHAN_LOGIN,
      commission: '-1.00000000',
      swap: '0.00000000',
    });

    expect(await deals.backlog()).toBe(2);
    expect(await deals.orphanBacklog()).toBe(1);

    await deals.accruePending();

    // The linked one drained; the orphan is still there and still needs someone.
    expect(await deals.backlog()).toBe(1);
    expect(await deals.orphanBacklog()).toBe(1);
  });
});

describe('only one feed pays for a trade', () => {
  /*
   * ── THE DOUBLE-PAY THAT THE UNIQUENESS CONSTRAINT CANNOT SEE ─────────────
   *
   * `accrueForClosedPosition` and `accrueForDeal` cover the same event from
   * two id spaces, so their accruals are two different (source_type, source_id)
   * pairs and `ib_accruals_source_earner_uq` holds both without complaint. Run
   * both feeds and every round turn pays its partner twice.
   *
   * What prevented that was `positions` having no writer — a fact about today,
   * not a rule, and this repo's own notes ask a future implementer to change
   * it. `revenue-feed.ts` makes it a rule; this proves the rule is enforced
   * where the money is written rather than only asserted about a constant.
   */
  it('writes nothing when a position closes, because the deal feed is live', async () => {
    const positionId = randomUUID();

    const rows = await commissions.accrueForClosedPosition({
      positionId,
      // The SAME client whose deals pay a partner throughout this suite, so a
      // zero here is the refusal and not an unreferred client.
      clientUserId: clientId,
      brokerRevenue: '10.00000000',
      lots: '1.00000000',
      currency: 'USD',
    });

    expect(rows).toBe(0);

    const { rows: accruals } = await ctx.db.execute(
      sql`SELECT id FROM ib_accruals WHERE source_type = 'position' AND source_id = ${positionId}`,
    );
    expect(accruals).toHaveLength(0);
  });

  it('still pays that client’s partner through the deal feed', async () => {
    /*
     * The other half, and the reason the case above is not simply proof that
     * the fixture is broken: the refusal is about the FEED, not about this
     * client, this partner, or this rate.
     */
    const id = await ingest({
      ticket: '90777',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
      positionId: 'P-ONE-FEED',
    });

    await deals.accruePending();

    const [accrual] = await accrualsFor(id);
    expect(accrual.ib_user_id).toBe(partnerId);
    expect(accrual.amount).toBe('3.00000000');
  });
});

/**
 * ── A DEPOSIT IS NOT REVENUE, AND RE-WIRING IT MUST SAY SO ────────────────
 *
 * `accrueForDeposit` paid a share of the client's OWN money: on a $1,000
 * deposit at 70% the partner took $700 of the broker's funds while the client
 * kept the right to withdraw all $1,000. Unbounded, and it scaled with deposit
 * volume.
 *
 * It was abandoned correctly, but the only thing keeping it abandoned was that
 * nothing called it — and the percentage implementation was still sitting there
 * for whoever wired it up next. The implementation is gone and the entry point
 * refuses by name, so the failure mode is a loud error rather than a silent
 * zero somebody would "fix" by deleting the guard inside `calculate`.
 */
describe('a deposit cannot accrue a revenue share', () => {
  it('refuses, and names the model somebody actually wants', async () => {
    await expect(
      commissions.accrueForDeposit({
        transactionId: randomUUID(),
        clientUserId: clientId,
        amount: '1000.00000000',
        currency: 'USD',
      }),
    ).rejects.toThrow(CommissionRefusedError);
  });

  it('writes no accrual row for a referred client with a working ladder', async () => {
    /*
     * The client below IS referred and the programme DOES pay 30% — the exact
     * fixture every other test in this file uses to prove commission lands. So
     * a zero here is the refusal and not an unreferred client or a dead rate.
     */
    const transactionId = randomUUID();

    await expect(
      commissions.accrueForDeposit({
        transactionId,
        clientUserId: clientId,
        amount: '1000.00000000',
        currency: 'USD',
      }),
    ).rejects.toThrow(/not earned on a deposit/i);

    const { rows } = await ctx.db.execute<{ n: number }>(
      sql`SELECT count(*)::int n FROM ib_accruals WHERE source_id = ${transactionId}`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('keeps the deposit itself whole — the port swallows the refusal', async () => {
    /*
     * The no-throw contract, and it is load-bearing: by the time this runs the
     * client's deposit has already credited their wallet. A commission refusal
     * must not roll that back or report the deposit as failed.
     */
    await expect(
      commissions.accrueForSettledDeposit({
        transactionId: randomUUID(),
        clientUserId: clientId,
        amount: '1000.00000000',
        currency: 'USD',
      }),
    ).resolves.toBe(0);
  });
});

/**
 * ── THE BACKLOG IS A DECISION, NOT A CONSEQUENCE OF DEPLOYING ─────────────
 *
 * `mt5_deals` was filled by ingestion long before anything read it, so the
 * first run of this engine faces months of historical trades. Draining them
 * pays partners for every one at once — real money, from a job whose whole
 * design is that it is safe to run.
 *
 * That is a commercial decision and no deployment had ever been asked to make
 * it. `IB_ACCRUAL_START` is where the answer goes; absent it, an aged backlog
 * stops the run rather than being paid or silently discarded.
 */
describe('what the engine is allowed to pay for', () => {
  const ENV = process.env['IB_ACCRUAL_START'];

  afterEach(() => {
    if (ENV === undefined) delete process.env['IB_ACCRUAL_START'];
    else process.env['IB_ACCRUAL_START'] = ENV;
  });

  /** A deal MT5 says happened `days` ago. */
  async function aged(ticket: string, days: number): Promise<string> {
    return ingest({
      ticket,
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
      secondsAgo: days * 86_400,
    });
  }

  it('refuses to drain an aged backlog nobody has decided about', async () => {
    delete process.env['IB_ACCRUAL_START'];
    const old = await aged('90300', 30);

    const run = await deals.accruePending();

    expect(run.awaitingBacklogDecision).toBe(true);
    expect(run.accrued).toBe(0);
    // Neither paid NOR discarded — the deal is exactly as it was.
    expect(await processedAt(old)).toBeNull();
    expect(await accrualsFor(old)).toHaveLength(0);
  });

  it('runs normally when the only queued work is recent', async () => {
    /*
     * A deal arriving late is not history. The sweep runs 24 hours behind the
     * push feed, so the grace period has to clear that or every ordinary
     * catch-up would read as a backlog and hold the engine shut.
     */
    delete process.env['IB_ACCRUAL_START'];
    const fresh = await ingest({
      ticket: '90301',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    const run = await deals.accruePending();

    expect(run.awaitingBacklogDecision).toBe(false);
    expect(run.accrued).toBe(1);
    expect((await accrualsFor(fresh))[0].amount).toBe('3.00000000');
  });

  it('pays the whole backlog when somebody says so out loud', async () => {
    process.env['IB_ACCRUAL_START'] = 'all';
    const old = await aged('90302', 30);

    const run = await deals.accruePending();

    expect(run.awaitingBacklogDecision).toBe(false);
    expect(run.accrued).toBe(1);
    expect((await accrualsFor(old))[0].amount).toBe('3.00000000');
  });

  it('pays from the chosen instant and FINISHES what predates it', async () => {
    process.env['IB_ACCRUAL_START'] = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const before = await aged('90303', 30);
    const after = await aged('90304', 3);

    const run = await deals.accruePending();

    expect(run.accrued).toBe(1);
    expect((await accrualsFor(after))[0].amount).toBe('3.00000000');

    // Out of scope, and DONE — not left to be re-examined on every run forever
    // while inflating a backlog nobody intends to pay.
    expect(run.predating).toBe(1);
    expect(await accrualsFor(before)).toHaveLength(0);
    expect(await processedAt(before)).not.toBeNull();
  });

  it('treats an unparseable value as unset rather than as "pay nothing"', async () => {
    /*
     * Validation refuses this at boot, so reaching it means something bypassed
     * that. Falling back to "no deal is ever in scope" would mark every trade
     * decided and discard commission permanently, which is the one outcome that
     * cannot be undone by fixing the value.
     */
    process.env['IB_ACCRUAL_START'] = 'not-a-date';
    await aged('90305', 30);

    expect((await deals.accruePending()).awaitingBacklogDecision).toBe(true);
  });
});

/**
 * WHICH of the broker's earnings the accrual is a share of — FR-IB-04, FR-IB-16.
 *
 * The unit suite proves the arithmetic. This proves the SEAM: that the setting
 * an operator saves reaches the query, that the query finds the product behind
 * the trading account, and that the number written to `ib_accruals.base_amount`
 * is the one the basis names.
 *
 * The first case is the one that matters most on the day this shipped — under
 * the default, nothing moved. A settings migration that re-prices a live book by
 * existing is the failure every comment in this feature is written against.
 */
describe('what the accrual is a share of', () => {
  const PRODUCT_LOGIN = '5000003';
  let productClientId: string;

  /** A settings row, as an operator who has saved the form would have left it. */
  function settingsWith(basis: string) {
    return {
      getTrading: () =>
        Promise.resolve({
          maxLiveAccounts: 5,
          maxDemoAccounts: 5,
          maxDemoDeposit: '1000000',
          ibMaxRevenueSharePct: '50',
          ibCommissionHoldHours: 24,
          /* A row is the answer, so the environment is not consulted at all. */
          ibAccrualStart: 'all',
          ibRevenueBasis: basis,
          updatedBy: null,
          updatedAt: new Date(),
        }),
    } as never;
  }

  const engineOn = (basis: string) =>
    new DealCommissionService(ctx.db, commissions, settingsWith(basis));

  beforeAll(async () => {
    productClientId = await makeUser('deal-product-client@oxshare-e2e.test');
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${partnerId} WHERE id = ${productClientId}`,
    );

    /*
     * 7.50 per standard lot — the DESK's figure for this product, which under a
     * spread basis is the entire revenue a partner is paid from.
     */
    await ctx.db.execute(sql`
      INSERT INTO trading_products (name, enabled, type, sort_order, spread_markup_per_lot)
      VALUES ('E2E Spread Product', true, 'real', 900, 7.50000000)
      ON CONFLICT (name) DO UPDATE SET spread_markup_per_lot = 7.50000000
    `);

    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, login, currency, product_id)
      VALUES (${productClientId}, ${PRODUCT_LOGIN}, 'USD',
              (SELECT id FROM trading_products WHERE name = 'E2E Spread Product'))
    `);
  });

  it('ignores the markup entirely under the default, however large it is', async () => {
    /*
     * The compatibility guarantee, at the seam. The account below is linked to a
     * product carrying a 7.50 markup and trades 2 lots — 15.00 of spread sitting
     * right there in the join — and the accrual is still 30% of the 10.00 of
     * charges, exactly as it was before the basis existed.
     */
    const id = await ingest({
      ticket: '90300',
      login: PRODUCT_LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
      volume: '2.00000000',
    });

    await engineOn('commission_swap').accruePending();

    const [accrual] = await accrualsFor(id);
    expect(accrual.base_amount).toBe('10.00000000');
    expect(accrual.amount).toBe('3.00000000');
  });

  it('pays on lots x the product markup when that is the agreed method', async () => {
    const id = await ingest({
      ticket: '90301',
      login: PRODUCT_LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
      volume: '2.00000000',
    });

    await engineOn('spread').accruePending();

    const [accrual] = await accrualsFor(id);
    // 2 lots x 7.50. The 10.00 of charges is deliberately NOT in the base.
    expect(accrual.base_amount).toBe('15.00000000');
    expect(accrual.amount).toBe('4.50000000');
  });

  it('sums both halves under the hybrid basis', async () => {
    const id = await ingest({
      ticket: '90302',
      login: PRODUCT_LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
      volume: '2.00000000',
    });

    await engineOn('commission_swap_spread').accruePending();

    const [accrual] = await accrualsFor(id);
    expect(accrual.base_amount).toBe('25.00000000');
    expect(accrual.amount).toBe('7.50000000');
  });

  it('REFUSES a deal on an account with no product, and keeps it queued', async () => {
    /*
     * `LOGIN` is linked to no product. Under a spread basis nothing in the system
     * knows what that account is sold on, so there is no honest number — and the
     * money is still owed. The deal is deferred on the existing backoff with the
     * reason on the row, exactly as a wrong rate would be, rather than marked
     * decided-and-unpaid.
     */
    const id = await ingest({
      ticket: '90303',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
      volume: '2.00000000',
    });

    const run = await engineOn('spread').accruePending();

    expect(run.failed).toBe(1);
    expect(await accrualsFor(id)).toHaveLength(0);
    expect(await isProcessed(id)).toBe(false);

    const state = await retryState(id);
    expect(state.commission_attempts).toBe(1);
    expect(state.commission_last_error).toContain('linked to no product');
    expect(state.dueInMs).toBeGreaterThan(0);
  });

  it('pays that same deal the moment the basis is put back', async () => {
    /*
     * The other half of the refusal, and the reason it must not mark the row
     * done: a deferred deal is RECOVERABLE. Correcting the setting — or linking
     * the product — pays it on the next run, with nothing lost.
     */
    const id = await ingest({
      ticket: '90304',
      login: LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
      volume: '2.00000000',
    });

    await engineOn('spread').accruePending();
    expect(await accrualsFor(id)).toHaveLength(0);

    await makeDue(id);
    await engineOn('commission_swap').accruePending();

    const [accrual] = await accrualsFor(id);
    expect(accrual.base_amount).toBe('10.00000000');
  });

  it('charges one round turn ONE markup, across both its legs', async () => {
    /*
     * The double-billing this shape exists to prevent. Both legs of a round turn
     * carry the full 2 lots, and the close consumes both — so a spread term
     * summed per leg would bill 30.00 for one trade that earned 15.00.
     */
    await ingest({
      ticket: '90305',
      login: PRODUCT_LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      entry: 0,
      volume: '2.00000000',
      positionId: 'P-SPREAD',
      secondsAgo: 10,
    });
    const closing = await ingest({
      ticket: '90306',
      login: PRODUCT_LOGIN,
      commission: '-6.00000000',
      swap: '0.00000000',
      entry: 1,
      volume: '2.00000000',
      positionId: 'P-SPREAD',
    });

    await engineOn('spread').accruePending();

    const [accrual] = await accrualsFor(closing);
    expect(accrual.base_amount).toBe('15.00000000');
  });
});
