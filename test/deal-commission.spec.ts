import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { CommissionService } from '../src/modules/ib/commission.service';
import { DealCommissionService } from '../src/modules/trading/mt5/deal-commission.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CommissionRefusedError } from '../src/common/provisioning/commission-accrual.port';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

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
}): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO mt5_deals
      (mt5_deal_id, login, symbol, action, entry, volume, price, profit, commission, swap,
       mt5_position_id, dealt_at)
    VALUES
      (${deal.ticket}, ${deal.login}, 'EURUSD', ${deal.action ?? 0}, ${deal.entry ?? 1},
       ${deal.volume ?? '1.00000000'}, '1.08542000', '0', ${deal.commission}, ${deal.swap},
       ${deal.positionId ?? null}, now())
    RETURNING id
  `);
  return rows[0].id;
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
  deals = new DealCommissionService(ctx.db, commissions);
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

    const refusing = new DealCommissionService(ctx.db, {
      accrueForDeal: vi
        .fn()
        .mockRejectedValue(new CommissionRefusedError('total exceeds the revenue')),
      accrueForClosedPosition: vi.fn(),
      accrueForSettledDeposit: vi.fn(),
    });

    const run = await refusing.accruePending();

    expect(run.failed).toBe(1);
    expect(await processedAt(id)).toBeNull();

    // And the real engine picks it up on the next run.
    expect((await deals.accruePending()).accrued).toBe(1);
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
