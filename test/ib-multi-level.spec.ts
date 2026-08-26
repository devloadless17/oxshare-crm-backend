import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { CommissionService } from '../src/modules/ib/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

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

let ib1: string;
let ib2: string;
let ib3: string;
let clientId: string;
let deepProgram: string;
let shallowProgram: string;

const POSITION_ID = '22222222-2222-4222-8222-222222222222';

async function makeUser(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${email.split('@')[0]}, 'Person')
    RETURNING id
  `);
  return rows[0].id;
}

/**
 * A programme and its ladder, in ONE transaction.
 *
 * The share ceiling is a DEFERRED constraint trigger, so it is asked once at
 * COMMIT. Inserting the tiers as separate statements would ask it against a
 * half-written ladder.
 */
async function makeProgram(name: string, rates: string[]): Promise<string> {
  return ctx.db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO ib_programs (name, mode, sort_order)
      VALUES (${name}, 'commission_only', 50) RETURNING id
    `);
    const id = rows[0].id;
    for (const [index, rate] of rates.entries()) {
      await tx.execute(sql`
        INSERT INTO ib_program_tiers (program_id, depth, rate)
        VALUES (${id}, ${index + 1}, ${rate})
      `);
    }
    return id;
  });
}

/** Put a partner on a set of terms. */
async function place(userId: string, programId: string): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE ib_accounts SET program_id = ${programId} WHERE user_id = ${userId}`,
  );
}

/** One closed trade on which the broker kept 100. */
async function accrue(sourceId = POSITION_ID): Promise<number> {
  return commissions.accrueForDeal({
    dealRowId: sourceId,
    ticket: '90211',
    clientUserId: clientId,
    brokerRevenue: '100.00000000',
    lots: '1.00000000',
    currency: 'USD',
  });
}

/** Every accrual, shallowest earner first. */
async function accrualRows() {
  const { rows } = await ctx.db.execute<{
    ib_user_id: string;
    depth: number;
    program_id: string | null;
    rate_value: string;
    amount: string;
  }>(sql`
    SELECT ib_user_id, depth, program_id, rate_value, amount
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

  const { rows } = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1`,
  );
  const seeded = rows[0].id;

  /*
   * The chain, built from the TOP down: `parent_ib_user_id` is a self-FK, so a
   * partner cannot reference a parent row that does not exist yet.
   */
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, program_id)
    VALUES (${ib3}, 'DEEPIB03', true, ${seeded})
  `);
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, active, program_id)
    VALUES (${ib2}, ${ib3}, 'DEEPIB02', true, ${seeded})
  `);
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, active, program_id)
    VALUES (${ib1}, ${ib2}, 'DEEPIB01', true, ${seeded})
  `);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${ib1} WHERE id = ${clientId}`,
  );

  /*
   * 50 / 20 / 10 — three DIFFERENT rates, deliberately. Equal rates would let a
   * transposition (paying depth 3 the depth-2 tier) pass every assertion here.
   */
  deepProgram = await makeProgram('Deep', ['50.0000', '20.0000', '10.0000']);
  /* One level: pays its holder on their own clients and nothing beyond. */
  shallowProgram = await makeProgram('Shallow', ['30.0000']);

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
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  /*
   * No cap to raise. The broker's floor was a setting that scaled every leg pro
   * rata to fit under a configured share; it went in 0103, so the 80% this
   * fixture pays across three levels arrives intact.
   *
   * `checkPlausible` still refuses a set exceeding the REVENUE — 80% does not,
   * which is why these amounts are the ones asserted below rather than scaled
   * ones.
   */
  await place(ib1, deepProgram);
  await place(ib2, deepProgram);
  await place(ib3, deepProgram);
});

describe('a trade three levels deep', () => {
  /*
   * THE REGRESSION. Before 0102 this paid two, and the third partner earned
   * nothing on every trade for ever — with the console reporting a three-level
   * payout depth because it counted rungs.
   */
  it('pays every partner in the chain, at their own depth', async () => {
    const written = await accrue();
    expect(written).toBe(3);

    const rows = await accrualRows();
    expect(rows.map((r) => [r.ib_user_id, r.depth, r.amount])).toEqual([
      [ib1, 1, '50.00000000'],
      [ib2, 2, '20.00000000'],
      [ib3, 3, '10.00000000'],
    ]);
  });

  /*
   * A row has to explain itself. `program_id` + `depth` + `rate_value` are what
   * settle a disputed payout from the row alone — without the programme, the
   * rate is a number with no stated source, recoverable only from the partner's
   * CURRENT terms, which are the thing most likely to have changed since.
   */
  it('records the programme and the rate that produced each amount', async () => {
    await accrue();

    for (const row of await accrualRows()) {
      expect(row.program_id).toBe(deepProgram);
    }
    expect((await accrualRows()).map((r) => r.rate_value)).toEqual([
      '50.0000',
      '20.0000',
      '10.0000',
    ]);
  });

  /*
   * Reach is per PROGRAMME, so a partner on a one-level programme stops earning
   * past their own clients — and the partners ABOVE them are unaffected.
   *
   * The wrong version reads reach from the introducer, or from a platform-wide
   * setting, and silently cancels terms two other partners negotiated.
   */
  it('pays a deep programme through a shallow one beneath it', async () => {
    await place(ib1, shallowProgram);

    expect(await accrue()).toBe(3);
    expect((await accrualRows()).map((r) => [r.depth, r.amount])).toEqual([
      [1, '30.00000000'],
      [2, '20.00000000'],
      [3, '10.00000000'],
    ]);
  });

  /*
   * The mirror: a partner whose OWN programme stops short earns nothing at that
   * depth, while everyone whose programme reaches keeps being paid.
   */
  it('stops paying a partner past the end of their own ladder', async () => {
    await place(ib3, shallowProgram);

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
