import { IbStore } from '../src/store/ib.store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emailStubAs } from './email-stub';
import { sql } from 'drizzle-orm';
import { CommissionService } from '../src/modules/ib/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { seedProductTerms, setLadderShares } from './support/commission-terms';
import type { CommissionTypeTerms } from '../src/modules/ib/commission';

/**
 * FR-IB-17 — MULTI-LEVEL DISTRIBUTION — against real Postgres.
 *
 * ## Why this suite exists, and why the unit tests are not enough
 *
 * `commission.spec.ts` proves the arithmetic: given a chain and some
 * programmes, `calculate` pays each earner from their own tier. It constructs
 * both by hand, so it cannot show that the DATABASE produces that chain or
 * accepts those rows — and until migration 0102 it could not have, three
 * separate times over:
 *
 *  - `MAX_CHAIN_DEPTH = 2` truncated the walk before a depth-3 partner existed.
 *  - `loadChain` fetched the introducer and ONE parent, so the third ancestor
 *    was never read.
 *  - `ib_accruals_depth_range` was `depth <= 2`, so a depth-3 row would have
 *    failed its INSERT — taking every legitimate earner on the same trade down
 *    with it, because they are inserted in one statement.
 *
 * Each of those is invisible to a pure test and to every other suite here,
 * which all use one- or two-deep fixtures. So this one builds a real THREE-deep
 * chain and asserts what lands in `ib_accruals`.
 *
 * ## The fixture
 *
 *     client ──introduced by──> ib1 ──parent──> ib2 ──parent──> ib3
 *
 * so on the client's trade ib1 is at depth 1, ib2 at 2, ib3 at 3.
 */

let ctx: MoneyTestContext;
let commissions: CommissionService;

let ib1: number;
let ib2: number;
let ib3: number;
let clientId: number;
/**
 * The product's rate card: $100 a lot to the partners (0140).
 *
 * Every trade here is ONE LOT, so a rung's SHARE of $100 is the same number
 * of dollars — "25%" pays $25 — and every assertion downstream reads as it
 * did when the rung carried "$25 a lot" itself.
 */
let terms: CommissionTypeTerms;

const POSITION_ID = '22222222-2222-4222-8222-222222222222';

async function makeUser(email: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${email.split('@')[0]}, 'Person')
    RETURNING id
  `);
  return rows[0].id;
}

/**
 * Set the whole ladder — one SHARE per rung, level 1 first, as a percentage of
 * the product's $100 a lot (0140). Every rung is reset first: a share left on
 * level 3 by a previous case would pay a partner the current one never
 * configured, and these suites share a database.
 */
async function setLadder(shares: string[]): Promise<void> {
  await setLadderShares(
    ctx.db,
    shares.map((commission) => ({ commission })),
  );
}

/** Move a partner to a rung — what decides their terms. */
async function place(userId: number, level: number): Promise<void> {
  await ctx.db.execute(sql`UPDATE ib_accounts SET level = ${level} WHERE user_id = ${userId}`);
}

/** One closed trade on which the broker kept 100. */
async function accrue(sourceId = POSITION_ID): Promise<number> {
  return commissions.accrueForDeal({
    dealRowId: sourceId,
    ticket: '90211',
    clientUserId: clientId,
    lots: '1.00000000',
    currency: 'USD',
    terms,
  });
}

/** Every accrual, shallowest earner first. */
async function accrualRows() {
  const { rows } = await ctx.db.execute<{
    ib_user_id: number;
    depth: number;
    level_id: string | null;
    rate_value: string;
    amount: string;
  }>(sql`
    SELECT ib_user_id, depth, level_id, rate_value, amount
      FROM ib_accruals ORDER BY depth
  `);
  return rows;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  ib1 = await makeUser('depth1@oxshare-e2e.test');
  ib2 = await makeUser('depth2@oxshare-e2e.test');
  ib3 = await makeUser('depth3@oxshare-e2e.test');
  clientId = await makeUser('deep-client@oxshare-e2e.test');

  /*
   * The chain, built from the TOP down: `parent_ib_user_id` is a self-FK, so a
   * partner cannot reference a parent row that does not exist yet.
   */
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, level)
    VALUES (${ib3}, 'DEEPIB03', true, 1)
  `);
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, active, level)
    VALUES (${ib2}, ${ib3}, 'DEEPIB02', true, 2)
  `);
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, active, level)
    VALUES (${ib1}, ${ib2}, 'DEEPIB01', true, 3)
  `);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${ib1} WHERE id = ${clientId}`,
  );

  /*
   * $25 / $10 / $5 a lot — three DIFFERENT rates, deliberately. Equal rates
   * would let a transposition (paying depth 3 the depth-2 tier) pass every
   * assertion here.
   *
   * ⚠️ They must also SUM to under `ib_max_payout_per_lot` ($50, the shipped
   * default). Under percentages the three rungs were 50/20/10 and summed to 80%
   * of a $100 base — fine, because that ceiling is a PERCENTAGE one. As per-lot
   * amounts the same figures are $80 a lot, which `checkPlausible` refuses
   * outright: a per-lot payout is not bounded by the revenue of the trade, so
   * the unit-error guard is all that stands between a mistyped amount and
   * eighty dollars a lot. Halving them keeps the three rungs distinct and the
   * total ($40) inside the ceiling.
   */
  const seeded = await seedProductTerms(ctx.db, {
    name: 'Deep terms',
    commissionPerLot: '100',
    rebatePerLot: '0',
  });
  terms = {
    id: seeded.typeId,
    name: 'Deep terms',
    enabled: true,
    commissionPerLot: '100.00000000',
    rebatePerLot: '0',
  };
  await setLadder(['25.0000', '10.0000', '5.0000']);
  /* One level: pays its holder on their own clients and nothing beyond. */

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
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);

  /*
   * The RUNGS are restored too, not only the accruals.
   *
   * Several cases move a partner onto an unconfigured rung to prove what
   * happens; without this, that move leaks into the next test and the failure
   * shows up somewhere unrelated. The tree itself never changes — only which
   * rung each partner stands on — so resetting the three is enough.
   */
  await ctx.db.execute(sql`UPDATE ib_accounts SET level = 1, active = true WHERE user_id = ${ib3}`);
  await ctx.db.execute(sql`UPDATE ib_accounts SET level = 2, active = true WHERE user_id = ${ib2}`);
  await ctx.db.execute(sql`UPDATE ib_accounts SET level = 3, active = true WHERE user_id = ${ib1}`);
  /*
   * No cap to raise. The broker's floor was a setting that scaled every leg pro
   * rata to fit under a configured share; it went in 0103, so the 80% this
   * fixture pays across three levels arrives intact.
   *
   * `checkPlausible` still refuses a set exceeding the REVENUE — 80% does not,
   * which is why these amounts are the ones asserted below rather than scaled
   * ones.
   */
});

describe('a trade three levels deep', () => {
  /*
   * THE REGRESSION. Before 0102 this paid two, and the third partner earned
   * nothing on every trade for ever — with the console reporting a three-level
   * payout depth because it counted rungs.
   */
  /*
   * ── EACH PARTNER IS PAID BY THEIR OWN RUNG (0112) ────────────────────────
   *
   * The chain is built top-down: `ib3` deals with the broker directly and is
   * level 1, `ib2` was recruited by them at level 2, `ib1` by `ib2` at level 3.
   * A client of `ib1` therefore reaches them at DEPTH 1 — but `ib1` stands on
   * the THIRD rung, so they take the third rate.
   *
   * That inversion is the change. Under programmes the rate followed the depth,
   * so the partner nearest the trade took the largest share whoever they were.
   * Under levels the partner nearest the BROKER does, which is what "static per
   * lot for the main partner, a percentage for the partner under him" means.
   */
  it('pays every partner in the chain by the rung they stand on', async () => {
    const written = await accrue();
    expect(written).toBe(3);

    const rows = await accrualRows();
    expect(rows.map((r) => [r.ib_user_id, r.depth, r.amount])).toEqual([
      // ib1 is nearest the trade and furthest from the broker: rung 3.
      [ib1, 1, '5.00000000'],
      [ib2, 2, '10.00000000'],
      // ib3 is the main partner, and takes the most however deep the trade was.
      [ib3, 3, '25.00000000'],
    ]);
  });

  /*
   * A row has to explain itself. `program_id` + `depth` + `rate_value` are what
   * settle a disputed payout from the row alone — without the programme, the
   * rate is a number with no stated source, recoverable only from the partner's
   * CURRENT terms, which are the thing most likely to have changed since.
   */
  /*
   * The row has to explain itself. `level_id` says which rung's terms priced it
   * and `rate_value` what that rung paid — together they make the arithmetic
   * reproducible from the row alone, which is the one property this ledger has
   * to keep when somebody asks months later why an amount was what it was.
   */
  it('records the rung and the rate that produced each amount', async () => {
    await accrue();

    for (const row of await accrualRows()) {
      expect(row.level_id).toBeTruthy();
    }
    /* The PER-LOT amount that priced each row, not a percentage (0117). */
    expect((await accrualRows()).map((r) => r.rate_value)).toEqual([
      '5.0000',
      '10.0000',
      '25.0000',
    ]);
  });

  /*
   * Reach is per PROGRAMME, so a partner on a one-level programme stops earning
   * past their own clients — and the partners ABOVE them are unaffected.
   *
   * The wrong version reads reach from the introducer, or from a platform-wide
   * setting, and silently cancels terms two other partners negotiated.
   */
  /*
   * A partner on an unconfigured rung earns nothing, and the partners ABOVE
   * them are untouched.
   *
   * This replaces "pays a deep programme through a shallow one beneath it",
   * which was about one partner's contract not truncating another's. There is
   * one ladder now, so that particular collision cannot arise — but the
   * property it protected still matters: a gap at one rung must not sever the
   * chain above it, or recruiting somebody onto terms nobody has configured
   * would quietly stop the whole upline earning.
   */
  it('pays the partners above a rung that is not configured', async () => {
    await place(ib1, 9);

    expect(await accrue()).toBe(2);
    expect((await accrualRows()).map((r) => [r.depth, r.amount])).toEqual([
      [2, '10.00000000'],
      [3, '25.00000000'],
    ]);
  });

  /*
   * The mirror: a partner whose OWN programme stops short earns nothing at that
   * depth, while everyone whose programme reaches keeps being paid.
   */
  it('stops paying a partner standing past the end of the ladder', async () => {
    await place(ib3, 9);

    expect(await accrue()).toBe(2);
    expect((await accrualRows()).map((r) => [r.ib_user_id, r.depth])).toEqual([
      [ib1, 1],
      [ib2, 2],
    ]);
  });

  /*
   * Suspension is a decision about a partner's whole SUBTREE. Letting ib3 keep
   * collecting through a switched-off ib2 pays somebody for a relationship an
   * operator has just ended.
   */
  it('breaks the chain at a suspended partner, so nobody above them earns', async () => {
    await ctx.db.execute(sql`UPDATE ib_accounts SET active = false WHERE user_id = ${ib2}`);
    try {
      expect(await accrue()).toBe(1);
      expect((await accrualRows()).map((r) => r.ib_user_id)).toEqual([ib1]);
    } finally {
      await ctx.db.execute(sql`UPDATE ib_accounts SET active = true WHERE user_id = ${ib2}`);
    }
  });

  /*
   * §6.3. The feed delivers every deal at least twice by design, so this is the
   * ordinary case rather than an edge one — and with three earners on one trade
   * a partial re-insert would be far worse than none.
   */
  it('pays the same trade once, however many times it is delivered', async () => {
    await accrue();
    expect(await accrue()).toBe(0);
    expect(await accrualRows()).toHaveLength(3);
  });

  /*
   * A CYCLE — which Postgres cannot prevent on a self-referencing key.
   *
   * The walk is a recursive CTE, so an unguarded cycle loops inside the
   * database and hangs the accrual rather than skipping it. Asserted with a
   * timeout, because the failure mode being guarded against is "never returns"
   * rather than "returns the wrong number".
   */
  it('terminates on a cycle in the partner tree instead of hanging', async () => {
    await ctx.db.execute(
      sql`UPDATE ib_accounts SET parent_ib_user_id = ${ib1} WHERE user_id = ${ib3}`,
    );
    try {
      const written = await accrue();
      /* Each partner paid at most once: `ib_accruals_source_earner_uq` is what
         stops a loop paying somebody twice for one trade. */
      expect(written).toBeLessThanOrEqual(3);
      const earners = (await accrualRows()).map((r) => r.ib_user_id);
      expect(new Set(earners).size).toBe(earners.length);
    } finally {
      await ctx.db.execute(
        sql`UPDATE ib_accounts SET parent_ib_user_id = NULL WHERE user_id = ${ib3}`,
      );
    }
  }, 20_000);
});
