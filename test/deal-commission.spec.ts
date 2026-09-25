import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailStubAs } from './email-stub';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { CommissionService } from '../src/modules/ib/commission.service';
import { DealCommissionService } from '../src/modules/trading/mt5/deal-commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CommissionRefusedError } from '../src/common/provisioning/commission-accrual.port';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { seedProductTerms, setLadderShares } from './support/commission-terms';
import type { CommissionTypeTerms } from '../src/modules/ib/commission';

/*
 * The backlog decision now lives in `trading_settings`, with the environment as
 * the fallback for a deployment configured before the column existed. These
 * suites drive the ENGINE, so they hand it a store with no row and keep setting
 * `IB_ACCRUAL_START` — which is exactly the fallback path, and the one every
 * existing deployment is on until an operator saves the form.
 */

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
/* The referred client's DEMO account. Same client, same partner, practice money.
   Past the block-scoped logins below, which run to 5000006. */
const DEMO_LOGIN = '5000007';

/**
 * The product every fixture account here is sold on: $10 a lot to the
 * partners, nothing back to the client (0140). With level 1 at 30% a one-lot
 * trade pays $3.00 on a $10.00 pool — the same two figures the suite asserted
 * when the base was "the 10.00 the broker kept", which is why most
 * expectations below did not have to move. What the broker earned on a trade
 * no longer enters the arithmetic at all.
 */
let terms: CommissionTypeTerms;
let productId: string;

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
  return new DealCommissionService(ctx.db, {
    accrueForDeal: vi
      .fn()
      .mockRejectedValue(new CommissionRefusedError('total exceeds the revenue')),
    accrueForClosedPosition: vi.fn(),
    accrueForSettledDeposit: vi.fn(),
  });
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
   * ## The rate is a TIER now, and there is only one place to set it
   *
   * This fixture used to write `ib_levels.rate_value` AND `ib_programs`, because
   * the schema carried two catalogues and only one of them paid. It set the
   * ladder alone for a while, which left every figure below reading whatever the
   * seeded Default programme happened to carry — the fixture silently stopped
   * controlling the number it exists to control.
   *
   * 0102 removed the ladder, so that class of drift has nowhere left to live.
   */
  await setLadderShares(ctx.db, [{ commission: '30' }]);

  partnerId = await makeUser('deal-partner@oxshare-e2e.test');
  clientId = await makeUser('deal-client@oxshare-e2e.test');
  unreferredId = await makeUser('deal-unreferred@oxshare-e2e.test');

  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, level)
      VALUES (${partnerId}, 'DEALPART', true, 1)
  `);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${partnerId} WHERE id = ${clientId}`,
  );

  await ctx.db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency)
    VALUES (${clientId}, ${LOGIN}, 'USD'), (${unreferredId}, ${UNREFERRED_LOGIN}, 'USD')
  `);

  /*
   * A DEMO account belonging to the SAME referred client, stated explicitly
   * rather than left to the column default.
   *
   * Every other fixture here omits `environment` and relies on it defaulting to
   * 'live', which is what makes the demo case invisible unless a row asks for
   * it by name.
   */
  await ctx.db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency, environment)
    VALUES (${clientId}, ${DEMO_LOGIN}, 'USD', 'demo')
  `);

  /* Every account above onto the product, and the product onto its type. */
  const seeded = await seedProductTerms(ctx.db, {
    name: 'Deal terms',
    commissionPerLot: '10',
    rebatePerLot: '0',
    logins: [LOGIN, UNREFERRED_LOGIN, DEMO_LOGIN],
  });
  productId = seeded.productId;
  terms = {
    id: seeded.typeId,
    name: 'Deal terms',
    enabled: true,
    commissionPerLot: '10.00000000',
    rebatePerLot: '0',
  };

  commissions = new CommissionService(
    ctx.db,
    new WalletService(ctx.db),
    // Never reached by ACCRUAL — the bell row is written by `confirmPending`,
    // which this suite does not run. Present because the constructor asks.
    {
      notify: vi.fn().mockResolvedValue(undefined),
      notifyAdmins: vi.fn().mockResolvedValue(undefined),
    },

    // The payout ceiling (0106) — the real store against the real row, so
    // this reads the shipped default of 100 rather than a stub's opinion.
    new AppSettingsStore(ctx.db),
    /* The per-run payout summary email (0114). Stubbed: this suite is
       about the money, and the send is fire-and-forget by contract. */
    emailStubAs(),
    /* The territory gate on `reverseAccrual`. Unrestricted here: these cases are
       about the money, not about who may see whom — the scoping itself is
       covered by `ib-accrual-reversal.spec.ts`. */
    { assertVisible: () => Promise.resolve() } as never,
  );
  deals = new DealCommissionService(ctx.db, commissions);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  /* Legacy `percent` rows — see the note in ib-end-to-end.spec.ts. The form
     cannot create these since 0117; the engine must still price them. */
  await ctx.db.execute(
    sql`ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_commission_shape`,
  );
  await ctx.db.execute(sql`ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_rebate_shape`);
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
   * ── PRACTICE MONEY PAYS NOBODY ────────────────────────────────────────────
   *
   * This was a live bug: nothing in the pipeline read
   * `trading_accounts.environment`, so a demo account's closing deals accrued
   * commission and rebate into REAL wallets. The house earns nothing on a demo
   * trade, so every cent of it was minted out of nothing — and a demo account
   * exists to be traded freely, which makes the exposure self-serve and
   * unbounded.
   *
   * The account below belongs to the SAME client whose live deals pay the same
   * partner in the case above, so nothing about the chain explains the
   * difference. Only the environment does.
   */
  it('accrues NOTHING on a demo account, and marks the deal done', async () => {
    const id = await ingest({
      ticket: '90299',
      login: DEMO_LOGIN,
      // Identical to the paying case above — the money is not what differs.
      commission: '-10.00000000',
      swap: '0.00000000',
    });

    const run = await deals.accruePending();

    expect(await accrualsFor(id)).toHaveLength(0);
    expect(run.accrued).toBe(0);
    expect(run.accrualRows).toBe(0);
    /*
     * Its OWN tally, not `nothingOwed`. "We declined to pay a practice trade"
     * and "a real trade owed nobody" are different facts, and an operator
     * watching this number climb while live accruals sit flat is looking at a
     * bridge mislabelling live accounts as demo.
     */
    expect(run.demo).toBe(1);
    expect(run.nothingOwed).toBe(0);

    /*
     * MARKED DONE, not left queued. A demo deal is worth nothing now and always
     * will be, so leaving it unprocessed would re-examine it on every run
     * forever and build a backlog nobody intends to pay — and, being oldest
     * first, would eventually starve the payable deals behind it.
     */
    const rerun = await deals.accruePending();
    expect(rerun.examined).toBe(0);
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
    expect((await accrualsFor(closing))[0].amount).toBe('3.00000000');
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
    // 30% of the $10 pool ONE closing lot puts on the table. The charges on
    // either leg are not what pays (0140) — but both legs are consumed by the
    // close, so the opener never comes back as an unpaid deal.
    expect(accrual.amount).toBe('3.00000000');
    expect(accrual.base_amount).toBe('10.00000000');
    expect(await isProcessed(closing)).toBe(true);
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
    /* Each close is priced on ITS OWN volume: one lot, a $10 pool (0140). */
    expect((await accrualsFor(firstClose))[0].base_amount).toBe('10.00000000');

    const secondClose = await ingest({
      ticket: '90232',
      login: LOGIN,
      commission: '-3.00000000',
      swap: '0.00000000',
      entry: 1,
      positionId: 'P-3',
    });

    await deals.accruePending();

    // Its own lot, its own $10 pool. The opener was consumed by the first
    // close and is neither counted again nor re-queued by the second.
    expect((await accrualsFor(secondClose))[0].base_amount).toBe('10.00000000');
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

    // The SAME on both. A partner is owed the product's per-lot terms on
    // volume (0140); what MT5 charged or credited does not move the number.
    expect((await accrualsFor(charged))[0].amount).toBe('3.00000000');
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

    // The account is linked, which is the ordinary onboarding sequence — and
    // onto a product, because an account on none cannot be priced (0140).
    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, login, currency, product_id)
      VALUES (${clientId}, ${ORPHAN_LOGIN}, 'USD', ${productId})
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

  it('pays a trade the broker earned nothing on, because the terms are per lot', async () => {
    /*
     * A raw-spread round turn: MT5 charged nothing at all. This used to be
     * marked done having paid nobody — a live bug on an ordinary setup. The
     * product's terms are per lot (0140), so the partner is owed on volume.
     */
    const id = await ingest({
      ticket: '90232',
      login: LOGIN,
      commission: '0.00000000',
      swap: '0.00000000',
    });
    const run = await deals.accruePending();
    expect(run.accrued).toBe(1);
    expect((await accrualsFor(id))[0].amount).toBe('3.00000000');
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
      terms,
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
 * ── WHAT THE ACCRUAL IS A SHARE OF: the product's commission TYPE (0140) ────
 *
 * A trade is priced on the rate card of the product the account is sold on,
 * and on nothing else — not on the charges MT5 reported, and not on a markup.
 * Three shapes of product reach this queue and each has to end differently:
 * a product on a type PAYS; a product with no type is DONE, having paid
 * nobody, because that is a configured state; and an account linked to no
 * product at all is REFUSED and retried, because nothing says what its trades
 * are worth and marking it done would discard the commission permanently.
 */
describe('what the accrual is a share of', () => {
  const RICH_LOGIN = '5000003';
  const NO_PRODUCT_LOGIN = '5000004';
  const UNTYPED_LOGIN = '5000005';
  let richTypeId: string;

  beforeAll(async () => {
    const richClientId = await makeUser('deal-rich-client@oxshare-e2e.test');
    const noProductClientId = await makeUser('deal-noproduct-client@oxshare-e2e.test');
    const untypedClientId = await makeUser('deal-untyped-client@oxshare-e2e.test');
    await ctx.db.execute(sql`
      UPDATE users SET referred_by_ib_user_id = ${partnerId}
      WHERE id IN (${richClientId}, ${noProductClientId}, ${untypedClientId})
    `);

    /* A SECOND product on a richer card: $25 a lot, against the suite's $10. */
    const rich = await seedProductTerms(ctx.db, {
      name: 'Rich terms',
      commissionPerLot: '25',
      rebatePerLot: '4',
    });
    richTypeId = rich.typeId;
    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, login, currency, product_id)
      VALUES (${richClientId}, ${RICH_LOGIN}, 'USD', ${rich.productId})
    `);

    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, login, currency)
      VALUES (${noProductClientId}, ${NO_PRODUCT_LOGIN}, 'USD')
    `);

    /* A product configured to pay no partner commission: real, enabled, no type. */
    await ctx.db.execute(sql`
      INSERT INTO trading_products (name, enabled, type, sort_order)
      VALUES ('Untyped product', true, 'real', 901)
      ON CONFLICT (name) DO NOTHING
    `);
    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, login, currency, product_id)
      VALUES (${untypedClientId}, ${UNTYPED_LOGIN}, 'USD',
              (SELECT id FROM trading_products WHERE name = 'Untyped product'))
    `);
  });

  it('prices the trade on the product’s own type, not on the charges beside it', async () => {
    const opening = await ingest({
      ticket: '90310',
      login: RICH_LOGIN,
      commission: '-4.00000000',
      swap: '0.00000000',
      entry: 0,
      volume: '2.00000000',
      positionId: 'P-RICH',
    });
    const closing = await ingest({
      ticket: '90311',
      login: RICH_LOGIN,
      commission: '-6.00000000',
      swap: '0.00000000',
      entry: 1,
      volume: '2.00000000',
      positionId: 'P-RICH',
    });
    await deals.accruePending();

    /* 30% of a $50 pool: two lots at $25. The $10 of charges is not in it. */
    const [accrual] = await accrualsFor(closing);
    expect(accrual.amount).toBe('15.00000000');
    expect(accrual.base_amount).toBe('50.00000000');
    expect(await isProcessed(opening)).toBe(true);

    /* The card that priced it is on the row, beside the rung. */
    const { rows } = await ctx.db.execute<{ commission_type_id: string | null }>(
      sql`SELECT commission_type_id FROM ib_accruals WHERE source_id = ${closing}`,
    );
    expect(rows[0].commission_type_id).toBe(richTypeId);
  });

  it('refuses a trade on an account linked to no product, and keeps it queued', async () => {
    const closing = await ingest({
      ticket: '90312',
      login: NO_PRODUCT_LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
      entry: 1,
      volume: '2.00000000',
      positionId: 'P-NOPRODUCT',
    });
    const run = await deals.accruePending();

    expect(run.failed).toBe(1);
    expect(await accrualsFor(closing)).toEqual([]);
    expect(await isProcessed(closing)).toBe(false);
    /* Deferred on the backoff with the reason on the row, like any refusal. */
    expect((await retryState(closing)).commission_last_error).toMatch(/no product/);
    expect(await deals.backlog()).toBe(1);
  });

  it('finishes a trade on a product with no commission type, paying nobody', async () => {
    const closing = await ingest({
      ticket: '90313',
      login: UNTYPED_LOGIN,
      commission: '-10.00000000',
      swap: '0.00000000',
      entry: 1,
      volume: '2.00000000',
      positionId: 'P-UNTYPED',
    });
    const run = await deals.accruePending();

    expect(run.nothingOwed).toBe(1);
    expect(run.failed).toBe(0);
    expect(await accrualsFor(closing)).toEqual([]);
    expect(await isProcessed(closing)).toBe(true);
  });
});

/**
 * ── A TRADE THE BROKER EARNED NOTHING ON ─────────────────────────────────────
 *
 * A raw-spread group — no commission, no swap — is an ordinary setup, and it
 * is the one on which every closed trade was once marked processed having
 * paid nobody. The terms are per lot (0140), so volume is what pays.
 */
describe('a trade the broker earned nothing on', () => {
  const ZERO_LOGIN = '5000006';
  let zeroPartnerId: string;

  beforeAll(async () => {
    zeroPartnerId = await makeUser('deal-zero-partner@oxshare-e2e.test');
    const zeroClientId = await makeUser('deal-zero-client@oxshare-e2e.test');
    await ctx.db.execute(sql`
      INSERT INTO ib_accounts (user_id, referral_code, active, level)
      VALUES (${zeroPartnerId}, 'DEALZERO', true, 1)
    `);
    await ctx.db.execute(sql`
      UPDATE users SET referred_by_ib_user_id = ${zeroPartnerId} WHERE id = ${zeroClientId}
    `);
    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, login, currency, product_id)
      VALUES (${zeroClientId}, ${ZERO_LOGIN}, 'USD', ${productId})
    `);
  });

  it('pays the partner on volume when MT5 charged nothing at all', async () => {
    const opening = await ingest({
      ticket: '90400',
      login: ZERO_LOGIN,
      commission: '0.00000000',
      swap: '0.00000000',
      entry: 0,
      volume: '2.00000000',
      positionId: 'P-ZERO',
    });
    const closing = await ingest({
      ticket: '90401',
      login: ZERO_LOGIN,
      commission: '0.00000000',
      swap: '0.00000000',
      entry: 1,
      volume: '2.00000000',
      positionId: 'P-ZERO',
    });
    await deals.accruePending();

    /* 30% of a $20 pool: two lots at $10. */
    const [accrual] = await accrualsFor(closing);
    expect(accrual?.amount).toBe('6.00000000');
    expect(accrual?.ib_user_id).toBe(zeroPartnerId);
    expect(await isProcessed(opening)).toBe(true);
  });
});
