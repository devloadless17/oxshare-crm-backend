import { IbStore } from '../src/store/ib.store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailStubAs } from './email-stub';
import { sql } from 'drizzle-orm';
import { CommissionService } from '../src/modules/ib/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { seedProductTerms, setLadderShares, type RungShares } from './support/commission-terms';
import type { CommissionTypeTerms } from '../src/modules/ib/commission';

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

let partnerId: number;
let clientId: number;

const POSITION_ID = '11111111-1111-4111-8111-111111111111';

async function makeUser(email: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${email.split('@')[0]}, 'Person')
    RETURNING id
  `);
  return rows[0].id;
}

/**
 * The product's rate card: $10 a lot to the partners and $100 a lot back to
 * the client (0140). Every trade here is ONE LOT. The partner is a level 1
 * partner introducing their own client, so since 0197 they take the WHOLE
 * commission pool — $10 — whatever level 1's share on the ladder says. The
 * rebate is still a share of its own pool: a 5% rebate share returns $5.
 */
let terms: CommissionTypeTerms;

/**
 * Set the ladder: one commission share per rung, level 1 first, and the
 * rebate share on level 1 — the INTRODUCER's rung, the partner the client is
 * actually in a relationship with. Every rung is reset first. (Level 1's
 * commission share is ignored by the engine since 0197.)
 */
async function setTerms(ladder: { tiers?: string[]; rebateRate: string }): Promise<void> {
  const shares: RungShares[] = (ladder.tiers ?? []).map((commission) => ({ commission }));
  if (shares.length === 0) shares.push({ commission: '0' });
  shares[0] = { ...shares[0], rebate: ladder.rebateRate };
  await setLadderShares(ctx.db, shares);
}

/** One closed trade on which the broker kept 100. */
async function accrue(sourceId = POSITION_ID): Promise<number> {
  return commissions.accrueForDeal({
    dealRowId: sourceId,
    ticket: '90210',
    clientUserId: clientId,
    lots: '1.00000000',
    currency: 'USD',
    terms,
  });
}

async function accrualRows() {
  const { rows } = await ctx.db.execute<{
    kind: string;
    ib_user_id: number;
    client_user_id: number;
    amount: string;
    status: string;
  }>(sql`
    SELECT kind, ib_user_id, client_user_id, amount, status
      FROM ib_accruals ORDER BY kind
  `);
  return rows;
}

async function walletsOf(userId: number) {
  const { rows } = await ctx.db.execute<{ kind: string; currency: string; balance: string }>(sql`
    SELECT kind, currency, balance FROM wallets WHERE user_id = ${userId} ORDER BY kind
  `);
  return rows;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  partnerId = await makeUser('rebate-partner@oxshare-e2e.test');
  clientId = await makeUser('rebate-client@oxshare-e2e.test');

  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, level)
      VALUES (${partnerId}, 'REBATE01', true, 1)
  `);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${partnerId} WHERE id = ${clientId}`,
  );

  /*
   * $10 of commission, not $100: a level 1 partner now takes the whole pool on
   * their own client, and $100 + the rebate would breach the shipped $50-a-lot
   * ceiling and be refused.
   */
  const seeded = await seedProductTerms(ctx.db, {
    name: 'Rebate terms',
    commissionPerLot: '10',
    rebatePerLot: '100',
  });
  terms = {
    id: seeded.typeId,
    name: 'Rebate terms',
    enabled: true,
    commissionPerLot: '10.00000000',
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
    /* The territory gate on `reverseAccrual`. Unrestricted here: these cases are
       about the money, not about who may see whom — the scoping itself is
       covered by `ib-accrual-reversal.spec.ts`. */
    { assertVisible: () => Promise.resolve() } as never,
    new IbStore(ctx.db),
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
  /* The partner back on level 1 on the ladder's terms — one case moves them. */
  await ctx.db.execute(sql`
    UPDATE ib_accounts
       SET level = 1, commission_share_override = NULL, rebate_share_override = NULL
     WHERE user_id = ${partnerId}
  `);
  /* Legacy `percent` rows — see the note in ib-end-to-end.spec.ts. The form
     cannot create these since 0117; the engine must still price them. */
  await ctx.db.execute(
    sql`ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_commission_shape`,
  );
  await ctx.db.execute(sql`ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_rebate_shape`);
  /*
   * BATCHES between the accruals and the wallets (0116). A batch is
   * referenced BY an accrual and references a wallet, so it sits exactly
   * here in the FK order — clearing wallets first fails on
   * `ib_accrual_batches_wallet_id_fkey`.
   */
  await ctx.db.execute(sql`DELETE FROM ib_accrual_batches`);
  await ctx.db.execute(
    sql`TRUNCATE ledger_entries, ib_accruals CASCADE` /* not DELETE: the ledger is append-only by trigger (§6.4). TRUNCATE resets a fixture table without firing row triggers, and no production path truncates. */,
  );
  await ctx.db.execute(sql`DELETE FROM wallets`);
  /* The window is what stands between "earned" and "spendable"; these cases are
     about WHO is paid, so it is set to zero and confirmation runs immediately.
     The window itself is pinned in `ib-settlement.spec.ts`. */
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

describe('a hybrid programme produces two legs from one trade', () => {
  it('writes a commission row and a rebate row', async () => {
    await setTerms({ tiers: ['30'], rebateRate: '5' });

    const created = await accrue();

    expect(created).toBe(2);
    /* The whole $10 pool to the level 1 partner — not level 1's 30% — and 5% of $100 back. */
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
    await setTerms({ tiers: ['30'], rebateRate: '5' });
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
    await setTerms({ tiers: ['30'], rebateRate: '5' });

    await accrue();
    const second = await accrue();

    expect(second).toBe(0);
    expect(await accrualRows()).toHaveLength(2);
  });
});

describe('confirmation pays each leg to the right person', () => {
  it('credits the partner’s commission wallet and the client’s main wallet', async () => {
    await setTerms({ tiers: ['30'], rebateRate: '5' });
    await accrue();

    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
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
    await setTerms({ tiers: ['30'], rebateRate: '5' });
    await accrue();
    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
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
    await setTerms({ tiers: ['30'], rebateRate: '5' });
    await accrue();

    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
    await commissions.confirmPending();
    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
    const second = await commissions.confirmPending();

    expect(second.confirmed).toBe(0);
    expect(await walletsOf(clientId)).toEqual([
      { kind: 'main', currency: 'USD', balance: '5.00000000' },
    ]);
  });
});

describe('the mode decides which legs exist at all', () => {
  /*
   * "Commission only" is a SHAPE now, not a declared mode: a rung paying the
   * partner and returning nothing to the client. `mode` went with the programme
   * catalogue, and with it the way a programme could claim to be commission-only
   * while carrying a rebate rate nobody could see on the screen.
   */
  it('pays only the partner when the rung returns nothing to the client', async () => {
    await setTerms({ tiers: ['30'], rebateRate: '0' });

    expect(await accrue()).toBe(1);
    expect((await accrualRows()).map((r) => r.kind)).toEqual(['commission']);
  });

  /*
   * A real arrangement — the broker buys volume by handing the spread back —
   * and the partner earning nothing on it is the point, not a misconfiguration.
   *
   * Since 0197 a level 1 partner takes the whole commission on their own client
   * whatever level 1's share says, so "commission at zero" is a SUB-PARTNER
   * whose own share is set to 0 — here a lone one, with nobody above to take
   * the rest. Both of their PER-PARTNER overrides are exercised: the level 2
   * rung pays 30% commission and no rebate, and this partner is set to 0% and
   * 5% instead.
   */
  it('pays only the client when the sub-partner’s share is set to zero', async () => {
    await setLadderShares(ctx.db, [{ commission: '0' }, { commission: '30', rebate: '0' }]);
    await ctx.db.execute(sql`
      UPDATE ib_accounts
         SET level = 2, commission_share_override = '0', rebate_share_override = '5'
       WHERE user_id = ${partnerId}
    `);

    expect(await accrue()).toBe(1);
    expect((await accrualRows()).map((r) => r.kind)).toEqual(['rebate']);

    /* Past the 60s window — see the note in the setup above. */
    await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
    await commissions.confirmPending();
    expect(await walletsOf(partnerId)).toEqual([]);
    expect(await walletsOf(clientId)).toEqual([
      { kind: 'main', currency: 'USD', balance: '5.00000000' },
    ]);
  });
});
