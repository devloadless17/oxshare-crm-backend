import { IbStore } from '../src/store/ib.store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { emailStubAs } from './email-stub';
import { sql } from 'drizzle-orm';
import { CommissionService } from '../src/modules/ib/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { seedProductTerms, setLadderShares } from './support/commission-terms';
import type { CommissionTypeTerms } from '../src/modules/ib/commission';

/**
 * The REBATE leg against real Postgres — PARTNER money since 0209.
 *
 * ## The rule (owner, 7 Oct 2026)
 *
 * A commission type's `rebate_per_lot` × lots is a POOL, and it is split down
 * the partner chain exactly like commission: a sub-partner (level 2) takes
 * their own rebate share (override ?? their rung's), the level 1 partner takes
 * the rest of 100%. Each earner gets one `rebate` row and is paid it into their
 * COMMISSION wallet. The trading client gets nothing.
 *
 * Until 0209 the rebate went back to the trading client, into their MAIN
 * wallet. Rebates already paid that way carry `paid_to_client = true` and are
 * still reversed against the client — the last describe pins that.
 *
 * ## Why this suite exists
 *
 * `rebate` sat in `ledgerEntryTypeEnum` for months with nothing writing one,
 * and every layer was individually fine. So the assertions here are about the
 * JOIN: that one trade produces a commission row AND a rebate row per earning
 * partner, that confirmation pays both kinds to the PARTNER's commission wallet
 * in separate batches, that the client's wallet receives nothing, and that
 * re-running pays nobody twice.
 *
 * Every one of these has a wrong version that balances perfectly and pays the
 * wrong party.
 */

let ctx: MoneyTestContext;
let commissions: CommissionService;
let notify: Mock<(input: unknown) => Promise<void>>;

/** The level 1 partner, who deals with the broker directly. */
let mainId: number;
/** The level 2 partner `mainId` recruited. */
let subId: number;
/** A client the SUB-partner introduced — the trade reaches both partners. */
let clientId: number;
/** A client the MAIN partner introduced themselves. */
let directClientId: number;

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
 * The product's rate card: $10 a lot of commission and $10 a lot of rebate
 * (0140). Every trade here is ONE LOT, so each puts a $10 commission pool and a
 * $10 rebate pool on the table — $20 in all, under the shipped per-lot ceiling.
 */
let terms: CommissionTypeTerms;

/** One closed one-lot trade. */
async function accrue(
  client = clientId,
  sourceId = POSITION_ID,
  rateCard: CommissionTypeTerms = terms,
): Promise<number> {
  return commissions.accrueForDeal({
    dealRowId: sourceId,
    ticket: '90210',
    clientUserId: client,
    lots: '1.00000000',
    currency: 'USD',
    terms: rateCard,
  });
}

async function accrualRows() {
  const { rows } = await ctx.db.execute<{
    id: string;
    kind: string;
    ib_user_id: number;
    client_user_id: number;
    depth: number;
    amount: string;
    status: string;
    paid_to_client: boolean;
  }>(sql`
    SELECT id, kind, ib_user_id, client_user_id, depth, amount, status, paid_to_client
      FROM ib_accruals ORDER BY kind, depth
  `);
  return rows;
}

/** Rows as `kind:who@depth=amount` — readable in a failure message. */
async function legs(): Promise<string[]> {
  const name = (id: number) =>
    id === mainId ? 'main' : id === subId ? 'sub' : id === clientId ? 'client' : String(id);
  return (await accrualRows()).map((r) => `${r.kind}:${name(r.ib_user_id)}@${r.depth}=${r.amount}`);
}

async function walletsOf(userId: number) {
  const { rows } = await ctx.db.execute<{ kind: string; currency: string; balance: string }>(sql`
    SELECT kind, currency, balance FROM wallets WHERE user_id = ${userId} ORDER BY kind
  `);
  return rows;
}

/** Past the 60s maturation window — see the note in the setup below. */
async function matureAndConfirm() {
  await ctx.db.execute(sql`UPDATE ib_accruals SET created_at = now() - interval '10 minutes'`);
  return commissions.confirmPending();
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  mainId = await makeUser('rebate-main@oxshare-e2e.test');
  subId = await makeUser('rebate-sub@oxshare-e2e.test');
  clientId = await makeUser('rebate-client@oxshare-e2e.test');
  directClientId = await makeUser('rebate-direct-client@oxshare-e2e.test');

  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, level)
      VALUES (${mainId}, 'REBATE01', true, 1)
  `);
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, active, level)
      VALUES (${subId}, ${mainId}, 'REBATE02', true, 2)
  `);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${subId} WHERE id = ${clientId}`,
  );
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${mainId} WHERE id = ${directClientId}`,
  );

  const seeded = await seedProductTerms(ctx.db, {
    name: 'Rebate terms',
    commissionPerLot: '10',
    rebatePerLot: '10',
  });
  terms = {
    id: seeded.typeId,
    name: 'Rebate terms',
    enabled: true,
    commissionPerLot: '10.00000000',
    rebatePerLot: '10.00000000',
  };

  notify = vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
  commissions = new CommissionService(
    ctx.db,
    new WalletService(ctx.db),
    {
      notify,
      notifyAdmins: vi.fn().mockResolvedValue(undefined),
    },
    // The payout ceiling (0106) — the real store against the real row, so
    // this reads the shipped default rather than a stub's opinion.
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
  notify.mockClear();
  /*
   * ACCRUALS FIRST. `ib_accruals.ledger_entry_id` references the entry that
   * paid it, so clearing the ledger first violates that key the moment a
   * previous case has confirmed anything — which made every test AFTER a
   * confirming one fail in its setup rather than its assertion.
   */
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  /* The two partners back in their tree on the ladder's terms — cases move them. */
  await ctx.db.execute(sql`
    UPDATE ib_accounts
       SET level = 1, parent_ib_user_id = NULL,
           commission_share_override = NULL, rebate_share_override = NULL
     WHERE user_id = ${mainId}
  `);
  await ctx.db.execute(sql`
    UPDATE ib_accounts
       SET level = 2, parent_ib_user_id = ${mainId},
           commission_share_override = NULL, rebate_share_override = NULL
     WHERE user_id = ${subId}
  `);
  /* Legacy `percent` rows — see the note in ib-end-to-end.spec.ts. The form
     cannot create these since 0117; the engine must still price them. */
  await ctx.db.execute(
    sql`ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_commission_shape`,
  );
  await ctx.db.execute(sql`ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_rebate_shape`);
  /*
   * The ladder: rung 2 takes 30% of the commission and 40% of the rebate.
   * Level 1's own shares (30% and 50%) are set to figures that would show in an
   * amount if they decided anything — they do not: level 1 takes the rest.
   */
  await setLadderShares(ctx.db, [
    { commission: '30', rebate: '50' },
    { commission: '30', rebate: '40' },
  ]);
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

describe('the rebate pool is split down the partner chain like commission', () => {
  it('writes a commission row and a rebate row for each earning partner', async () => {
    const created = await accrue();

    expect(created).toBe(4);
    /*
     * The sub-partner introduced the client (depth 1) and takes rung 2's 30% of
     * the $10 commission and 40% of the $10 rebate; the main partner, one hop
     * up, takes the rest of each.
     */
    expect(await legs()).toEqual([
      'commission:sub@1=3.00000000',
      'commission:main@2=7.00000000',
      'rebate:sub@1=4.00000000',
      'rebate:main@2=6.00000000',
    ]);
  });

  /* Nobody beneath them on the trade, so the main partner takes BOTH whole pools. */
  it('pays a main partner the whole rebate on their own client', async () => {
    expect(await accrue(directClientId)).toBe(2);

    expect(await legs()).toEqual(['commission:main@1=10.00000000', 'rebate:main@1=10.00000000']);
  });

  /* `rebate_share_override` beats the rung's share, and level 1's rest follows it. */
  it('splits by the sub-partner’s own rebate share when one is set', async () => {
    await ctx.db.execute(
      sql`UPDATE ib_accounts SET rebate_share_override = '25' WHERE user_id = ${subId}`,
    );

    await accrue();

    expect((await legs()).filter((leg) => leg.startsWith('rebate:'))).toEqual([
      'rebate:sub@1=2.50000000',
      'rebate:main@2=7.50000000',
    ]);
  });

  /*
   * THE attribution rule, at the row level. On a rebate written since 0209
   * `ib_user_id` is the partner who EARNS it and is paid it; `client_user_id`
   * only names whose trade it was. `paid_to_client` is false on every new row —
   * reading the client as the beneficiary is the pre-0209 rule.
   */
  it('names the partner as the earner and never marks a new rebate as the client’s', async () => {
    await accrue();

    const rebates = (await accrualRows()).filter((r) => r.kind === 'rebate');
    expect(rebates.map((r) => [r.ib_user_id, r.depth, r.paid_to_client])).toEqual([
      [subId, 1, false],
      [mainId, 2, false],
    ]);
    expect(rebates.every((r) => r.client_user_id === clientId)).toBe(true);
  });

  /*
   * One deal, one partner, two rows — which collide on
   * (source_type, source_id, ib_user_id) unless `kind` is part of the key. The
   * failure without it is silent: the ON CONFLICT drops the second row, and a
   * configured rebate simply never pays.
   */
  it('does not let the rows collide, and writes none twice on re-delivery', async () => {
    await accrue();
    const second = await accrue();

    expect(second).toBe(0);
    expect(await accrualRows()).toHaveLength(4);
  });
});

describe('confirmation pays both kinds to the partners’ commission wallets', () => {
  it('credits each partner’s commission wallet and nothing to the client', async () => {
    await accrue();

    const result = await matureAndConfirm();
    expect(result.confirmed).toBe(4);

    /* Commission + rebate: 7 + 6 for the main partner, 3 + 4 for the sub-partner. */
    expect(await walletsOf(mainId)).toEqual([
      { kind: 'commission', currency: 'USD', balance: '13.00000000' },
    ]);
    expect(await walletsOf(subId)).toEqual([
      { kind: 'commission', currency: 'USD', balance: '7.00000000' },
    ]);
    /* No main wallet opened, no credit: the client gets no rebate since 0209. */
    expect(await walletsOf(clientId)).toEqual([]);
  });

  /*
   * Commission and rebate now share a wallet, so the KIND has to stay in the
   * batch key — one batch and one ledger entry per kind, the rebate posted as
   * `rebate` so every report summing by entry type still tells them apart.
   */
  it('posts each kind as its own batch and ledger entry', async () => {
    await accrue();
    await matureAndConfirm();

    const { rows: entries } = await ctx.db.execute<{
      wallet_kind: string;
      entry_type: string;
      amount: string;
    }>(sql`
      SELECT w.kind AS wallet_kind, e.entry_type, e.amount
        FROM ledger_entries e
        JOIN wallets w ON w.id = e.wallet_id
       WHERE w.user_id = ${mainId}
       ORDER BY e.entry_type
    `);
    expect(entries).toEqual([
      { wallet_kind: 'commission', entry_type: 'commission', amount: '7.00000000' },
      { wallet_kind: 'commission', entry_type: 'rebate', amount: '6.00000000' },
    ]);

    const { rows: batches } = await ctx.db.execute<{
      kind: string;
      amount: string;
      accrual_count: number;
    }>(sql`
      SELECT b.kind, b.amount, b.accrual_count
        FROM ib_accrual_batches b
        JOIN wallets w ON w.id = b.wallet_id
       WHERE w.user_id = ${mainId}
       ORDER BY b.kind
    `);
    expect(batches).toEqual([
      { kind: 'commission', amount: '7.00000000', accrual_count: 1 },
      { kind: 'rebate', amount: '6.00000000', accrual_count: 1 },
    ]);
  });

  it('pays nobody twice when the loop runs again', async () => {
    await accrue();

    await matureAndConfirm();
    const second = await matureAndConfirm();

    expect(second.confirmed).toBe(0);
    expect(await walletsOf(mainId)).toEqual([
      { kind: 'commission', currency: 'USD', balance: '13.00000000' },
    ]);
    expect(await walletsOf(subId)).toEqual([
      { kind: 'commission', currency: 'USD', balance: '7.00000000' },
    ]);
    expect(await walletsOf(clientId)).toEqual([]);
  });

  /* The bell follows the money: whoever's wallet was paid is who is told. */
  it('tells the partners, not the client, that a rebate was credited', async () => {
    await accrue();
    await matureAndConfirm();

    const rebateRecipients = notify.mock.calls
      .map(([event]) => event as { kind: string; recipient: { id: number } })
      .filter((event) => event.kind === 'rebate.credited')
      .map((event) => event.recipient.id)
      .sort((a, b) => a - b);
    expect(rebateRecipients).toEqual([mainId, subId].sort((a, b) => a - b));
  });
});

describe('which legs exist at all', () => {
  /*
   * "Commission only" is a commission type with no rebate on it. A rung's
   * rebate share cannot switch it off for a level 1 partner — they take the
   * rest of the pool whatever their own share says — so the type is where it
   * is decided.
   */
  it('pays no rebate when the commission type carries none', async () => {
    expect(await accrue(clientId, POSITION_ID, { ...terms, rebatePerLot: '0.00000000' })).toBe(2);
    expect((await accrualRows()).map((r) => r.kind)).toEqual(['commission', 'commission']);
  });

  /*
   * Since 0197 a level 1 partner takes the whole commission whatever level 1's
   * share says, so "commission at zero" is a SUB-PARTNER whose own share is 0
   * — here a lone one, with nobody above to take the rest. Their own rebate
   * share still pays THEM, into their commission wallet; the client still gets
   * nothing.
   */
  it('pays a lone sub-partner only their rebate share when their commission share is zero', async () => {
    await ctx.db.execute(sql`
      UPDATE ib_accounts
         SET parent_ib_user_id = NULL, commission_share_override = '0', rebate_share_override = '5'
       WHERE user_id = ${subId}
    `);

    expect(await accrue()).toBe(1);
    expect(await legs()).toEqual(['rebate:sub@1=0.50000000']);

    await matureAndConfirm();
    expect(await walletsOf(subId)).toEqual([
      { kind: 'commission', currency: 'USD', balance: '0.50000000' },
    ]);
    expect(await walletsOf(clientId)).toEqual([]);
  });
});

/*
 * ── A REBATE PAID TO A CLIENT BEFORE 0209 ──────────────────────────────────
 *
 * 0209 stamped `paid_to_client = true` on every rebate whose money had already
 * reached a client. Those are still the client's: a reversal must take the
 * money back from the client's MAIN wallet it went to, not from the partner
 * named in `ib_user_id`, who was never paid it.
 *
 * The fixture flags a pending row and confirms it, which is the shortest way to
 * a client-paid rebate with a real ledger entry behind it — and pins that the
 * confirm path still honours the flag too.
 */
describe('a legacy rebate paid to the client', () => {
  it('is confirmed into and reversed out of the client’s main wallet', async () => {
    await accrue(directClientId);
    await ctx.db.execute(sql`UPDATE ib_accruals SET paid_to_client = true WHERE kind = 'rebate'`);

    await matureAndConfirm();
    expect(await walletsOf(directClientId)).toEqual([
      { kind: 'main', currency: 'USD', balance: '10.00000000' },
    ]);
    /* Only the commission reached the partner. */
    expect(await walletsOf(mainId)).toEqual([
      { kind: 'commission', currency: 'USD', balance: '10.00000000' },
    ]);
    const told = notify.mock.calls
      .map(([event]) => event as { kind: string; recipient: { id: number } })
      .filter((event) => event.kind === 'rebate.credited')
      .map((event) => event.recipient.id);
    expect(told).toEqual([directClientId]);

    const rebate = (await accrualRows()).find((r) => r.kind === 'rebate');
    const reversed = await commissions.reverseAccrual(rebate!.id, 'legacy clawback', UNRESTRICTED);
    expect(reversed.movedMoney).toBe(true);

    expect(await walletsOf(directClientId)).toEqual([
      { kind: 'main', currency: 'USD', balance: '0.00000000' },
    ]);
    expect(await walletsOf(mainId)).toEqual([
      { kind: 'commission', currency: 'USD', balance: '10.00000000' },
    ]);
  });
});
