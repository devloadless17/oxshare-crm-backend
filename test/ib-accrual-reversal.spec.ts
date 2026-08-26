import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { CommissionService } from '../src/modules/ib/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Taking an accrual back — against real Postgres, because every guarantee here
 * is one the database enforces.
 *
 * ## Why this suite exists
 *
 * `ib_accrual_status` has carried `reversed` since the table existed, and the
 * admin API published it, and NOTHING SET IT. A dealer-cancelled trade left a
 * partner holding money for a trade that did not happen, and the only remedy
 * was hand-written SQL against a ledger whose whole design is that it cannot be
 * edited. That is the same shape as the rebate gap `ib-rebate.spec.ts` was
 * written for: every layer individually fine, the operation itself absent.
 *
 * ## What has a wrong version that balances perfectly
 *
 * Three of these, and they are the reason the assertions are about WHO and
 * WHICH ROW rather than about totals:
 *
 *   - a rebate reversal that debits `ib_user_id` balances exactly, and takes
 *     the money from the introducer instead of the client who was paid;
 *   - a reversal reusing the credit's reference type is absorbed by
 *     `ledger_entries_wallet_reference_uq` as a replay — the desk sees success
 *     and the partner keeps the money;
 *   - a second reversal that debits twice turns a clawback into theft.
 *
 * The fourth case is the one with no code path around it: a partner who has
 * already spent the money cannot be debited, because `wallets_balance_non_negative`
 * is a CHECK constraint. The reversal must refuse and the row must stay
 * `confirmed`, because it IS confirmed — the money was paid and has not come back.
 */

let ctx: MoneyTestContext;
let commissions: CommissionService;

let partnerId: string;
let clientId: string;
let programId: string;

const DEAL_ROW_ID = '22222222-2222-4222-8222-222222222222';

async function makeUser(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${email.split('@')[0]}, 'Person')
    RETURNING id
  `);
  return rows[0].id;
}

/**
 * Set the programme, LADDER AND ALL.
 *
 * The ladder is rewritten wholesale rather than patched, because its LENGTH is
 * how far the programme pays. The share-ceiling trigger is DEFERRABLE, so the
 * delete-then-insert is checked once at COMMIT rather than against a
 * half-written ladder.
 */
async function setTerms(terms: {
  mode: 'commission_only' | 'rebate_only' | 'hybrid';
  /** Rates by depth, 1 first. Omit or pass [] for a programme paying no partner. */
  tiers?: string[];
  rebateRate: string;
}): Promise<void> {
  /*
   * ONE TRANSACTION, and that is not tidiness.
   *
   * The share ceiling is a DEFERRED constraint trigger: it asks "what does this
   * programme pay in total" at COMMIT. Run as separate statements, raising the
   * rebate commits while the PREVIOUS ladder is still in place, so setting a 5%
   * rebate on a programme already paying 70 + 30 is refused at 105% — for a
   * state the caller never asked for and is one statement away from leaving.
   *
   * Inside a transaction the question is asked once, about the terms as they
   * end up. This is the same shape `IbProgramsService.update` uses, for the
   * same reason.
   */
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE ib_programs
         SET mode = ${terms.mode}::ib_program_mode,
             rebate_rate = ${terms.rebateRate},
             enabled = true
       WHERE id = ${programId}
    `);
    await tx.execute(sql`DELETE FROM ib_program_tiers WHERE program_id = ${programId}`);

    const tiers = (terms.tiers ?? []).filter((rate) => Number.parseFloat(rate) > 0);
    for (const [index, rate] of tiers.entries()) {
      await tx.execute(sql`
        INSERT INTO ib_program_tiers (program_id, depth, rate)
        VALUES (${programId}, ${index + 1}, ${rate})
      `);
    }
  });
}

/** One closed trade on which the broker kept 100. */
async function accrue(): Promise<number> {
  return commissions.accrueForDeal({
    dealRowId: DEAL_ROW_ID,
    ticket: '90210',
    clientUserId: clientId,
    brokerRevenue: '100.00000000',
    lots: '1.00000000',
    currency: 'USD',
  });
}

async function accrualRows() {
  const { rows } = await ctx.db.execute<{
    id: string;
    kind: string;
    amount: string;
    status: string;
  }>(sql`SELECT id, kind, amount, status FROM ib_accruals ORDER BY kind`);
  return rows;
}

async function walletOf(userId: string, kind: string): Promise<string | null> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM wallets WHERE user_id = ${userId} AND kind = ${kind}::wallet_kind`,
  );
  return rows[0]?.balance ?? null;
}

async function ledgerFor(userId: string) {
  const { rows } = await ctx.db.execute<{
    entry_type: string;
    amount: string;
    reference_type: string;
  }>(sql`
    SELECT e.entry_type, e.amount, e.reference_type
      FROM ledger_entries e
      JOIN wallets w ON w.id = e.wallet_id
     WHERE w.user_id = ${userId}
     ORDER BY e.created_at, e.amount DESC
  `);
  return rows;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  const { rows } = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1`,
  );
  programId = rows[0].id;

  partnerId = await makeUser('reversal-partner@oxshare-e2e.test');
  clientId = await makeUser('reversal-client@oxshare-e2e.test');

  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, program_id)
      VALUES (${partnerId}, 'REVERSE1', true, ${programId})
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
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  // Accruals first — `ib_accruals.ledger_entry_id` references the entry that
  // paid it, so clearing the ledger first violates that key.
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  await ctx.db.execute(sql`DELETE FROM ledger_entries`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  process.env['IB_COMMISSION_HOLD_HOURS'] = '0';
});

describe('reversing a PENDING accrual costs nothing', () => {
  it('changes the status and moves no money', async () => {
    await setTerms({ mode: 'commission_only', tiers: ['10'], rebateRate: '0' });
    await accrue();

    const [accrual] = await accrualRows();
    expect(accrual.status).toBe('pending');

    const result = await commissions.reverseAccrual(accrual.id, 'dealer cancelled the trade');

    /*
     * THE asymmetry the settlement window exists to buy. Inside the window an
     * accrual is still just a row, so undoing it is a status change; outside it
     * the same undo is a debit against money a partner may already have spent.
     */
    expect(result.movedMoney).toBe(false);
    expect((await accrualRows())[0].status).toBe('reversed');

    // No wallet was even opened — nothing was ever credited to take back.
    expect(await walletOf(partnerId, 'commission')).toBeNull();
    expect(await ledgerFor(partnerId)).toHaveLength(0);
  });
});

describe('reversing a CONFIRMED accrual posts a compensating entry', () => {
  it('debits the wallet that was credited and never edits the credit', async () => {
    await setTerms({ mode: 'commission_only', tiers: ['10'], rebateRate: '0' });
    await accrue();
    await commissions.confirmPending();

    expect(await walletOf(partnerId, 'commission')).toBe('10.00000000');

    const [accrual] = await accrualRows();
    expect(accrual.status).toBe('confirmed');

    const result = await commissions.reverseAccrual(accrual.id, 'dealer cancelled the trade');

    expect(result.movedMoney).toBe(true);
    expect(await walletOf(partnerId, 'commission')).toBe('0.00000000');
    expect((await accrualRows())[0].status).toBe('reversed');

    /*
     * TWO rows, not one amended row. `ledger_entries` is append-only — a
     * trigger rejects UPDATE and DELETE — so a clawback is a new entry and the
     * credit stands as the historical fact it is.
     *
     * The debit is an `adjustment` rather than a negative `commission`: entry
     * types are what reports sum by, and a negative commission row would net
     * against real earnings, shrinking a partner's lifetime figure with no line
     * explaining why.
     */
    const ledger = await ledgerFor(partnerId);
    expect(ledger).toHaveLength(2);
    expect(ledger.map((e) => [e.entry_type, e.amount])).toEqual([
      ['commission', '10.00000000'],
      ['adjustment', '-10.00000000'],
    ]);
    // A DIFFERENT reference type from the credit — reusing `accrual` would make
    // the debit look like a replay and be dropped by the unique constraint.
    expect(ledger[1].reference_type).toBe('accrual_reversal');
  });

  it('is idempotent: a second reversal does not debit twice', async () => {
    await setTerms({ mode: 'commission_only', tiers: ['10'], rebateRate: '0' });
    await accrue();
    await commissions.confirmPending();

    const [accrual] = await accrualRows();
    await commissions.reverseAccrual(accrual.id, 'first');
    const second = await commissions.reverseAccrual(accrual.id, 'double-submitted');

    /*
     * A desk that double-clicks is asking for a state the row is already in.
     * Answering "done" is both true and what stops them trying again — and the
     * wrong version here does not error, it quietly debits a partner twice.
     */
    expect(second.movedMoney).toBe(false);
    expect(await walletOf(partnerId, 'commission')).toBe('0.00000000');
    expect(await ledgerFor(partnerId)).toHaveLength(2);
  });
});

describe('a REBATE is taken back from the client, not the partner', () => {
  it('debits the client main wallet the rebate was paid into', async () => {
    await setTerms({ mode: 'rebate_only', tiers: [], rebateRate: '5' });
    await accrue();
    await commissions.confirmPending();

    expect(await walletOf(clientId, 'main')).toBe('5.00000000');

    const [rebate] = await accrualRows();
    expect(rebate.kind).toBe('rebate');

    await commissions.reverseAccrual(rebate.id, 'trade cancelled');

    /*
     * `ib_user_id` on a rebate row is the partner whose programme PRODUCED it —
     * attribution, not entitlement. Reading it as the beneficiary balances
     * perfectly and takes the money from the introducer, who was never paid it.
     */
    expect(await walletOf(clientId, 'main')).toBe('0.00000000');
    expect(await walletOf(partnerId, 'commission')).toBeNull();
  });
});

describe('a reversal REFUSES when the money is already gone', () => {
  it('leaves the accrual confirmed rather than telling a lie', async () => {
    await setTerms({ mode: 'commission_only', tiers: ['10'], rebateRate: '0' });
    await accrue();
    await commissions.confirmPending();

    // The partner moved their earnings out — the ordinary thing to do with them.
    await ctx.db.execute(sql`
      UPDATE wallets SET balance = '2.00000000'
       WHERE user_id = ${partnerId} AND kind = 'commission'
    `);

    const [accrual] = await accrualRows();

    /*
     * There is no `allowOverdraft` that rescues this: `wallets_balance_non_negative`
     * is a CHECK constraint, so the database would reject the row anyway. A
     * wallet driven negative is a debt the CRM has no concept of, cannot collect
     * and cannot show a partner.
     */
    await expect(commissions.reverseAccrual(accrual.id, 'cancelled')).rejects.toThrow(
      /insufficient/i,
    );

    /*
     * And the status must NOT move. It is still `confirmed`, because it IS —
     * money was paid and has not come back. Marking it `reversed` on a failed
     * debit is the one lie this table must never tell: the desk would believe
     * it was recovered and stop chasing it.
     */
    expect((await accrualRows())[0].status).toBe('confirmed');
    expect(await walletOf(partnerId, 'commission')).toBe('2.00000000');
  });
});
