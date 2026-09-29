import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailStubAs } from './email-stub';
import { sql } from 'drizzle-orm';
import { CommissionService } from '../src/modules/ib/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { seedProductTerms, setLadderShares, type RungShares } from './support/commission-terms';
import type { CommissionTypeTerms } from '../src/modules/ib/commission';
import { UNRESTRICTED, scopeOf } from '../src/common/security/client-scope';
import { ClientVisibilityService } from '../src/common/security/client-visibility.service';
import { UsersStore } from '../src/store/users.store';

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

let partnerId: number;
let clientId: number;

const DEAL_ROW_ID = '22222222-2222-4222-8222-222222222222';

async function makeUser(email: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${email.split('@')[0]}, 'Person')
    RETURNING id
  `);
  return rows[0].id;
}

/**
 * The product's rate card: $100 a lot to the partners and $100 a lot back to
 * the client (0140). Every trade here is ONE LOT, so a share of either figure
 * is the same number of dollars, and every amount asserted below reads as it
 * did when the rung was a percentage of $100 of revenue.
 */
let terms: CommissionTypeTerms;

/** The ladder: commission shares level 1 first, the rebate share on level 1. */
async function setTerms(ladder: { tiers?: string[]; rebateRate: string }): Promise<void> {
  const shares: RungShares[] = (ladder.tiers ?? [])
    .filter((rate) => Number.parseFloat(rate) > 0)
    .map((commission) => ({ commission }));
  if (shares.length === 0) shares.push({ commission: '0' });
  shares[0] = { ...shares[0], rebate: ladder.rebateRate };
  await setLadderShares(ctx.db, shares);
}

/** One closed trade on which the broker kept 100. */
async function accrue(): Promise<number> {
  return commissions.accrueForDeal({
    dealRowId: DEAL_ROW_ID,
    ticket: '90210',
    clientUserId: clientId,
    lots: '1.00000000',
    currency: 'USD',
    terms,
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

async function walletOf(userId: number, kind: string): Promise<string | null> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM wallets WHERE user_id = ${userId} AND kind = ${kind}::wallet_kind`,
  );
  return rows[0]?.balance ?? null;
}

async function ledgerFor(userId: number) {
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

  partnerId = await makeUser('reversal-partner@oxshare-e2e.test');
  clientId = await makeUser('reversal-client@oxshare-e2e.test');

  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, level)
      VALUES (${partnerId}, 'REVERSE1', true, 1)
  `);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${partnerId} WHERE id = ${clientId}`,
  );

  const seeded = await seedProductTerms(ctx.db, {
    name: 'Reversal terms',
    commissionPerLot: '100',
    rebatePerLot: '100',
  });
  terms = {
    id: seeded.typeId,
    name: 'Reversal terms',
    enabled: true,
    commissionPerLot: '100.00000000',
    rebatePerLot: '100.00000000',
  };

  commissions = new CommissionService(
    ctx.db,
    new WalletService(ctx.db),
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
    /* The territory gate. Stubbed open for the money cases above, which are
       about WHO is debited and by how much; the gate itself is exercised with
       the real service at the end of this file. */
    { assertVisible: () => Promise.resolve() } as never,
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  // Accruals first — `ib_accruals.ledger_entry_id` references the entry that
  // paid it, so clearing the ledger first violates that key.
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  /* Legacy `percent` rows — see the note in ib-end-to-end.spec.ts. The form
     cannot create these since 0117; the engine must still price them. */
  await ctx.db.execute(
    sql`ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_commission_shape`,
  );
  await ctx.db.execute(sql`ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_rebate_shape`);
  /* Batches sit between the accruals and the wallets in FK order (0116). */
  await ctx.db.execute(sql`DELETE FROM ib_accrual_batches`);
  await ctx.db.execute(
    sql`TRUNCATE ledger_entries, ib_accruals CASCADE` /* not DELETE: the ledger is append-only by trigger (§6.4). TRUNCATE resets a fixture table without firing row triggers, and no production path truncates. */,
  );
  await ctx.db.execute(sql`DELETE FROM wallets`);
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
});

describe('reversing a PENDING accrual costs nothing', () => {
  it('changes the status and moves no money', async () => {
    await setTerms({ tiers: ['10'], rebateRate: '0' });
    await accrue();

    const [accrual] = await accrualRows();
    expect(accrual.status).toBe('pending');

    const result = await commissions.reverseAccrual(
      accrual.id,
      'dealer cancelled the trade',
      UNRESTRICTED,
    );

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
    await setTerms({ tiers: ['10'], rebateRate: '0' });
    await accrue();
    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
    await commissions.confirmPending();

    expect(await walletOf(partnerId, 'commission')).toBe('10.00000000');

    const [accrual] = await accrualRows();
    expect(accrual.status).toBe('confirmed');

    const result = await commissions.reverseAccrual(
      accrual.id,
      'dealer cancelled the trade',
      UNRESTRICTED,
    );

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
    await setTerms({ tiers: ['10'], rebateRate: '0' });
    await accrue();
    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
    await commissions.confirmPending();

    const [accrual] = await accrualRows();
    await commissions.reverseAccrual(accrual.id, 'first', UNRESTRICTED);
    const second = await commissions.reverseAccrual(accrual.id, 'double-submitted', UNRESTRICTED);

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
    await setTerms({ tiers: [], rebateRate: '5' });
    await accrue();
    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
    await commissions.confirmPending();

    expect(await walletOf(clientId, 'main')).toBe('5.00000000');

    const [rebate] = await accrualRows();
    expect(rebate.kind).toBe('rebate');

    await commissions.reverseAccrual(rebate.id, 'trade cancelled', UNRESTRICTED);

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
    await setTerms({ tiers: ['10'], rebateRate: '0' });
    await accrue();
    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
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
    await expect(commissions.reverseAccrual(accrual.id, 'cancelled', UNRESTRICTED)).rejects.toThrow(
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

describe('the reversal obeys the reader’s TERRITORY, on the column it actually debits', () => {
  /*
   * This route carried `@NotClientScoped`, and its reason was half right:
   * "the scope predicates in IbStore filter on ib_accruals.ib_user_id, which on
   * a REBATE row is the attributing partner rather than the person debited —
   * scoping on it would be a check that reads the wrong column."
   *
   * True, and an argument against ONE implementation. It was taken as an
   * argument against scoping at all, leaving `ib.commissions.reverse` as the
   * only gate — so any holder of it could take money out of any client's wallet
   * on the platform, in a system whose entire territory model exists to stop
   * exactly that.
   *
   * The column the check needs is the one the DEBIT uses: the client on a
   * rebate, the partner on a commission. These two cases are a matched pair
   * that fail in opposite directions if that expression is ever inverted —
   * which is the mistake worth guarding, because inverting it still balances
   * perfectly and still refuses somebody, so it looks like it works.
   */
  let scopedCommissions: CommissionService;
  let partnerOnlyTagId: string;

  beforeEach(async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO client_tags (slug, label)
      VALUES (${'reversal-territory-' + Date.now()}, 'Reversal Territory')
      RETURNING id
    `);
    partnerOnlyTagId = rows[0].id;
    // ONLY the partner is in this territory. The client is deliberately not.
    await ctx.db.execute(sql`
      INSERT INTO client_tag_assignments (user_id, tag_id) VALUES (${partnerId}, ${partnerOnlyTagId})
    `);

    scopedCommissions = new CommissionService(
      ctx.db,
      new WalletService(ctx.db),
      {
        notify: vi.fn().mockResolvedValue(undefined),
        notifyAdmins: vi.fn().mockResolvedValue(undefined),
      },
      new AppSettingsStore(ctx.db),
      emailStubAs(),
      // The REAL gate, against the real users table — a stub here would only
      // assert that a stub was called.
      new ClientVisibilityService(new UsersStore(ctx.db)),
    );
  });

  it('lets a reader reverse a COMMISSION when the PARTNER is in their territory', async () => {
    await setTerms({ tiers: ['30.0000'], rebateRate: '5.0000' });
    await accrue();
    const commission = (await accrualRows()).find((r) => r.kind === 'commission')!;

    const result = await scopedCommissions.reverseAccrual(
      commission.id,
      'in territory',
      scopeOf([partnerOnlyTagId], false, false),
    );

    expect(result.status).toBe('reversed');
  });

  it('REFUSES a REBATE to that same reader — the beneficiary is the CLIENT, who is not', async () => {
    /*
     * The case the old reasoning was built around, and the one that proves the
     * check reads the debited party rather than `ib_user_id`. The partner IS in
     * this reader's territory and the accrual row names them — so a check on
     * `ib_user_id` would ALLOW this, and take money from a client the reader
     * cannot see.
     */
    await setTerms({ tiers: ['30.0000'], rebateRate: '5.0000' });
    await accrue();
    const rebate = (await accrualRows()).find((r) => r.kind === 'rebate')!;

    await expect(
      scopedCommissions.reverseAccrual(
        rebate.id,
        'out of territory',
        scopeOf([partnerOnlyTagId], false, false),
      ),
      // Exactly a missing accrual's answer — code and message — never "not your client".
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Accrual not found.' });

    // And nothing moved: the row is untouched, not half-reversed.
    const after = (await accrualRows()).find((r) => r.kind === 'rebate')!;
    expect(after.status).not.toBe('reversed');
  });

  it('answers NOT FOUND rather than forbidden, so it is no enumeration oracle', async () => {
    /*
     * The same rule `ClientVisibilityService` exists to keep in one place. A 403
     * would confirm the accrual is real, letting a scoped desk enumerate rows
     * belonging to territories they were specifically denied.
     */
    await setTerms({ tiers: ['30.0000'], rebateRate: '5.0000' });
    await accrue();
    const rebate = (await accrualRows()).find((r) => r.kind === 'rebate')!;

    await expect(
      scopedCommissions.reverseAccrual(
        rebate.id,
        'probe',
        scopeOf([partnerOnlyTagId], false, false),
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('is refused BEFORE the idempotent “already reversed” answer', async () => {
    /*
     * Order matters. The short-circuit that makes a double-submit safe returns
     * "done" for a row already reversed — and returning it to somebody who may
     * not see the beneficiary would confirm the row exists, reopening the oracle
     * the case above closes.
     */
    await setTerms({ tiers: ['30.0000'], rebateRate: '5.0000' });
    await accrue();
    const rebate = (await accrualRows()).find((r) => r.kind === 'rebate')!;

    // Reversed by somebody who may.
    await commissions.reverseAccrual(rebate.id, 'first', UNRESTRICTED);

    // The scoped reader must still be refused, not told "already done".
    await expect(
      scopedCommissions.reverseAccrual(
        rebate.id,
        'probe',
        scopeOf([partnerOnlyTagId], false, false),
      ),
      // Exactly a missing accrual's answer — code and message — never "not your client".
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Accrual not found.' });
  });
});
