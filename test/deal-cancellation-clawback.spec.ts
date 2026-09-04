import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { CommissionService } from '../src/modules/ib/commission.service';
import { DealCommissionService } from '../src/modules/trading/mt5/deal-commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { ALERT_KINDS } from '../src/common/logging/alerts';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/*
 * The backlog decision now lives in `trading_settings`, with the environment as
 * the fallback for a deployment configured before the column existed. These
 * suites drive the ENGINE, so they hand it a store with no row and keep setting
 * `IB_ACCRUAL_START` — which is exactly the fallback path, and the one every
 * existing deployment is on until an operator saves the form.
 */

/**
 * A dealer cancelled a trade that had already paid somebody. Who finds out?
 *
 * ## Why this suite exists
 *
 * The engine has always excluded a cancellation from accruing — `isTradeAction`
 * does not count DEAL_BUY_CANCELED — and excluding it says nothing whatever
 * about the accrual already written against the trade it cancels. The
 * cancellation was marked done like any other non-trade row and the money
 * stayed where it was, with a partner holding earnings from a trade the dealer
 * struck out and NOTHING anywhere saying so.
 *
 * There is deliberately still no automatic clawback: a reversal takes money out
 * of a wallet, which needs a person. So this alert is the entire mechanism by
 * which that person ever learns there is a decision to make, which is what
 * makes it worth a suite of its own.
 *
 * ## The case that matters most is the SILENT one
 *
 * A cancellation on a position that never accrued — cancelled before the close,
 * or on an account with no introducer — is completely ordinary. If that raised
 * an alert, the alarm would fire constantly, get muted, and take the real cases
 * with it. `stays silent` is not a nice-to-have here; it is what keeps the
 * loud case audible.
 */

let ctx: MoneyTestContext;
let commissions: CommissionService;
let deals: DealCommissionService;

let partnerId: string;
let clientId: string;
let programId: string;

const LOGIN = '500123';
const POSITION = '778899';

async function makeUser(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${email.split('@')[0]}, 'Person')
    RETURNING id
  `);
  return rows[0].id;
}

async function insertDeal(deal: {
  ticket: string;
  action: number;
  entry?: number;
  positionId?: string | null;
  login?: string;
}): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO mt5_deals
      (mt5_deal_id, login, symbol, action, entry, volume, price, profit, commission, swap,
       mt5_position_id, dealt_at)
    VALUES
      (${deal.ticket}, ${deal.login ?? LOGIN}, 'EURUSD', ${deal.action}, ${deal.entry ?? 1},
       '1.00000000', '1.08542000', '0', '-10.00000000', '0', ${deal.positionId ?? null}, now())
    RETURNING id
  `);
  return rows[0].id;
}

/** Everything `raiseAlert` emitted — it logs the payload object as-is. */
function clawbackAlerts(errors: unknown[]) {
  return errors.filter(
    (arg): arg is { kind: string; severity: string; context: Record<string, number | string> } =>
      typeof arg === 'object' &&
      arg !== null &&
      'alert' in arg &&
      'kind' in arg &&
      arg.kind === ALERT_KINDS.COMMISSION_CLAWBACK_REQUIRED,
  );
}

let errors: unknown[];

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  const { rows } = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1`,
  );
  programId = rows[0].id;

  /* One level at 10%, replacing the level1/level2 pair those columns held. */
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE ib_programs
         SET mode = 'commission_only'::ib_program_mode, rebate_rate = 0, enabled = true
       WHERE id = ${programId}
    `);

    await tx.execute(
      sql`UPDATE ib_levels SET commission_mode = 'percent', commission_amount_per_lot = NULL, commission_rate = 10 WHERE level = 1`,
    );
  });

  partnerId = await makeUser('clawback-partner@oxshare-e2e.test');
  clientId = await makeUser('clawback-client@oxshare-e2e.test');

  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, level)
      VALUES (${partnerId}, 'CLAWBCK1', true, 1)
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
    // The payout ceiling (0106) — the real store against the real row, so
    // this reads the shipped default of 100 rather than a stub's opinion.
    new AppSettingsStore(ctx.db),
  );
  deals = new DealCommissionService(ctx.db, commissions);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  await ctx.db.execute(sql`DELETE FROM ledger_entries`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`DELETE FROM mt5_deals`);
  // Everything here is in scope; the backlog decision is pinned elsewhere.
  process.env['IB_ACCRUAL_START'] = 'all';

  errors = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((arg: unknown) => {
    errors.push(arg);
  });
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A closed trade that paid the partner, then the dealer's cancellation of it. */
async function tradeThenCancellation(): Promise<void> {
  const closing = await insertDeal({ ticket: '4001', action: 0, positionId: POSITION });
  await commissions.accrueForDeal({
    dealRowId: closing,
    ticket: '4001',
    clientUserId: clientId,
    brokerRevenue: '100.00000000',
    lots: '1.00000000',
    currency: 'USD',
  });
  // The close itself is settled business; this suite is about what the
  // cancellation does next.
  await ctx.db.execute(sql`UPDATE mt5_deals SET commission_processed_at = now()`);

  // DEAL_BUY_CANCELED, on the same position and the same login.
  await insertDeal({ ticket: '4002', action: 13, positionId: POSITION });
}

describe('a cancellation against a trade that already paid', () => {
  it('raises the clawback alarm and still marks the cancellation done', async () => {
    await tradeThenCancellation();

    const run = await deals.accruePending();

    const raised = clawbackAlerts(errors);
    expect(raised).toHaveLength(1);
    expect(raised[0].severity).toBe('notify');
    expect(raised[0].context.accruals).toBe(1);
    expect(raised[0].context.positionId).toBe(POSITION);

    /*
     * DONE, not stuck. The cancellation accrues nothing whatever happens here,
     * and leaving it unprocessed would put it at the front of an oldest-first
     * queue forever — the exact stall three separate doors in the service exist
     * to prevent.
     */
    expect(run.nothingOwed).toBe(1);
    const { rows } = await ctx.db.execute<{ pending: string }>(sql`
      SELECT count(*)::text AS pending FROM mt5_deals WHERE commission_processed_at IS NULL
    `);
    expect(rows[0].pending).toBe('0');
  });

  it('reports how many of them have already been CREDITED', async () => {
    await tradeThenCancellation();
    // The settlement window elapsed and the partner was paid, which is the
    // difference between a free reversal and one that debits a wallet.
    /*
     * The maturation window cannot be switched OFF any more (0113): it is a
     * setting with a 60-second floor, not `IB_COMMISSION_HOLD_HOURS=0`.
     *
     * So these cases BACKDATE their accruals past the window instead of removing
     * it. That is the better fixture anyway — it exercises the real predicate
     * (`created_at <= now() - interval`) rather than collapsing it to a
     * comparison against zero, and the window's own behaviour stays pinned in
     * `commission-hold-window.spec.ts`.
     */
    await ctx.db.execute(sql`
        INSERT INTO trading_settings (id, ib_commission_interval_seconds) VALUES (true, 60)
        ON CONFLICT (id) DO UPDATE SET ib_commission_interval_seconds = 60
      `);
    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
    await commissions.confirmPending();

    await deals.accruePending();

    const raised = clawbackAlerts(errors);
    expect(raised).toHaveLength(1);
    expect(raised[0].context.credited).toBe(1);
  });
});

describe('a cancellation that owes nobody anything', () => {
  it('stays silent when the position never accrued', async () => {
    // No accrual was ever written against this position.
    await insertDeal({ ticket: '4003', action: 13, positionId: '999000' });

    await deals.accruePending();

    /*
     * The case that keeps the alarm believable. Most cancellations are
     * ordinary, and an alert on every one of them is an alert that gets muted —
     * taking the loud case with it.
     */
    expect(clawbackAlerts(errors)).toHaveLength(0);
  });

  it('does not match another account holding the same position id', async () => {
    await tradeThenCancellation();
    await ctx.db.execute(sql`DELETE FROM mt5_deals WHERE mt5_deal_id = '4002'`);

    // Same position number, DIFFERENT login. Position ids are unique per
    // SERVER, not per account, so a match on the number alone would report one
    // client's partner over another client's cancelled trade.
    await insertDeal({ ticket: '4004', action: 14, positionId: POSITION, login: '500999' });

    await deals.accruePending();

    expect(clawbackAlerts(errors)).toHaveLength(0);
  });
});
