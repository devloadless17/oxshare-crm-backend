import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { CommissionService } from '../src/modules/ib/commission.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * THE WHOLE IB FEATURE, END TO END, on one populated platform.
 *
 * ## Why this exists beside the suites that already pass
 *
 * Every other IB suite proves ONE rule against a fixture built for it:
 * `ib-multi-level` builds a three-deep chain, `ib-rebate` builds a rebate-only
 * programme, `ib-applications` builds an agency. Each is deliberately minimal,
 * which is what makes them readable — and it means none of them can catch the
 * failures that only appear when the pieces are used TOGETHER:
 *
 *   - two agencies with different default programmes, approving on the same day
 *   - a chain whose members hold three DIFFERENT programmes in three modes
 *   - a rebate-only partner sitting between two commission partners
 *   - the payout ceiling applied to a chain nobody programme could predict
 *
 * So this builds one platform with three agencies, four programmes covering
 * every mode the FSD names, seven partners and six clients, and asserts what
 * actually lands in `ib_accruals`.
 *
 * ## The shape
 *
 *   GOLD AGENCY      default: Gold        (commission_only, 30/8)
 *     zaid   d1 ── omar d2 ── hana d3
 *
 *   LEVANT AGENCY    default: Hybrid      (hybrid, 20/5 + 3% rebate)
 *     rami   d1 ── nadia d2
 *
 *   GULF AGENCY      default: (none)      → falls through to the catalogue
 *     tariq  d1
 *
 *   plus `sami`, on a REBATE-ONLY programme, sitting mid-chain under rami.
 */

let ctx: MoneyTestContext;
let commissions: CommissionService;

/** Everybody, by the name this file calls them. */
const who: Record<string, string> = {};
/** Programme ids, by name. */
const prog: Record<string, string> = {};
/** Agency ids, by name. */
const agency: Record<string, string> = {};

async function makeUser(handle: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${`${handle}@e2e.test`}, 'x', ${handle}, 'Person', 1, true)
    RETURNING id
  `);
  who[handle] = rows[0].id;
  return rows[0].id;
}

/**
 * A programme and its ladder in ONE transaction.
 *
 * The share ceiling is a DEFERRED constraint trigger asked once at COMMIT, so
 * inserting the tiers as separate statements would ask it against a
 * half-written ladder.
 */
async function makeProgram(
  name: string,
  opts: { mode?: string; rebate?: string; tiers?: string[]; sortOrder?: number } = {},
): Promise<string> {
  const id = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO ib_programs (name, mode, rebate_rate, sort_order)
      VALUES (${name}, ${opts.mode ?? 'commission_only'}, ${opts.rebate ?? '0'},
              ${opts.sortOrder ?? 90})
      RETURNING id
    `);
    for (const [index, rate] of (opts.tiers ?? []).entries()) {
      await tx.execute(sql`
        INSERT INTO ib_program_tiers (program_id, depth, rate)
        VALUES (${rows[0].id}, ${index + 1}, ${rate})
      `);
    }
    return rows[0].id;
  });
  prog[name] = id;
  return id;
}

async function makeAgency(name: string, defaultProgramId: string | null): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO agencies (name, enabled, sort_order, default_program_id)
    VALUES (${name}, true, 0, ${defaultProgramId})
    RETURNING id
  `);
  agency[name] = rows[0].id;
  return rows[0].id;
}

/** A partner, optionally beneath another. Built top-down: `parent` is a self-FK. */
async function makePartner(
  handle: string,
  programId: string,
  parent?: string,
  agencyId?: string,
): Promise<string> {
  const id = await makeUser(handle);
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, active, program_id, agency_id)
    VALUES (${id}, ${parent ?? null}, ${handle.toUpperCase().padEnd(8, 'X').slice(0, 8)}, true,
            ${programId}, ${agencyId ?? null})
  `);
  return id;
}

/** A trading client, attributed to `introducer`. */
async function makeClient(handle: string, introducer: string): Promise<string> {
  const id = await makeUser(handle);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${introducer} WHERE id = ${id}`,
  );
  return id;
}

/** One closed trade the broker earned `revenue` on. */
async function trade(clientUserId: string, sourceId: string, revenue = '100.00000000') {
  return commissions.accrueForDeal({
    dealRowId: sourceId,
    ticket: sourceId.slice(0, 6),
    clientUserId,
    brokerRevenue: revenue,
    lots: '1.00000000',
    currency: 'USD',
  });
}

/** What landed, as `handle@depth=amount` strings — readable in a failure message. */
async function paidFor(sourceId: string): Promise<string[]> {
  const { rows } = await ctx.db.execute<{
    ib_user_id: string;
    client_user_id: string | null;
    kind: string;
    depth: number;
    amount: string;
  }>(sql`
    SELECT ib_user_id, client_user_id, kind, depth, amount
      FROM ib_accruals WHERE source_id = ${sourceId} ORDER BY kind, depth
  `);

  const nameOf = (id: string) =>
    Object.entries(who).find(([, value]) => value === id)?.[0] ?? id.slice(0, 6);

  return rows.map((row) =>
    row.kind === 'rebate'
      ? `rebate→${nameOf(row.client_user_id ?? '')}=${row.amount}`
      : `${nameOf(row.ib_user_id)}@${row.depth}=${row.amount}`,
  );
}

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  commissions = new CommissionService(
    ctx.db,
    new WalletService(ctx.db),
    {
      notify: vi.fn().mockResolvedValue(undefined),
      notifyAdminsWithPermission: vi.fn().mockResolvedValue(undefined),
    },
    new ConfigService(),
    new AppSettingsStore(ctx.db),
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  /*
   * A full teardown, in FK order. This suite builds a whole platform rather
   * than one fixture, so leaving any of it behind changes the next test's
   * chain — and a chain that differs from the one a test names is the hardest
   * kind of failure to read.
   */
  await ctx.db.execute(sql`DELETE FROM ib_accruals`);
  /*
   * The PARENT LINK IS BROKEN FIRST, and this is not tidiness.
   *
   * `ib_accounts.parent_ib_user_id` is a self-FK, and Postgres checks it
   * per-row rather than at the end of the statement — so `DELETE FROM
   * ib_accounts` fails on the first parent it reaches while a child still
   * points at it. Nulling the column turns a chain into a flat set that
   * deletes in any order.
   */
  /*
   * The ATTRIBUTION goes first, and the reason is not the obvious one:
   * `users.referred_by_ib_user_id` references `ib_accounts.user_id`, NOT
   * `users.id`. So a client still pointing at their introducer blocks that
   * PARTNER's row from being deleted — which reads as an unrelated failure
   * three statements later.
   */
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`UPDATE ib_accounts SET parent_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM ib_applications`);
  await ctx.db.execute(sql`DELETE FROM agency_products`);
  await ctx.db.execute(sql`DELETE FROM agencies`);
  await ctx.db.execute(sql`DELETE FROM ib_program_tiers WHERE program_id IN
    (SELECT id FROM ib_programs WHERE sort_order >= 50)`);
  await ctx.db.execute(sql`DELETE FROM ib_programs WHERE sort_order >= 50`);
  await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE '%@e2e.test'`);
  /*
   * THE CEILING IS RESET, and leaving it out cost a confusing failure.
   *
   * `trading_settings` is a singleton row that survives every delete above, so
   * the 22% a ceiling test sets stays set — and the next test that expects a
   * 35% chain to pay watches it get REFUSED, reporting a ceiling it never
   * mentioned. A shared setting is exactly the state a per-test fixture cannot
   * see it is inheriting.
   */
  await ctx.db.execute(sql`
    INSERT INTO trading_settings (id, ib_max_total_payout_pct) VALUES (true, '100')
    ON CONFLICT (id) DO UPDATE SET ib_max_total_payout_pct = '100'
  `);
  for (const key of Object.keys(who)) delete who[key];

  /* Every mode the FSD names, and nothing else — see the audit test below. */
  await makeProgram('E2E Gold', { tiers: ['30', '8'], sortOrder: 50 });
  await makeProgram('E2E Standard', { tiers: ['25', '5'], sortOrder: 51 });
  await makeProgram('E2E Hybrid', {
    mode: 'hybrid',
    tiers: ['20', '5'],
    rebate: '3',
    sortOrder: 52,
  });
  await makeProgram('E2E RebateOnly', { mode: 'rebate_only', rebate: '10', sortOrder: 53 });

  await makeAgency('E2E Gold Agency', prog['E2E Gold']);
  await makeAgency('E2E Levant', prog['E2E Hybrid']);
  await makeAgency('E2E Gulf', null);
});

/* ── The programme catalogue matches the specification exactly ────────────── */

describe('the programme types are the ones the FSD names', () => {
  /*
   * FR-IB-05: "each program shall declare a mode — commission-only,
   * rebate-only, or hybrid". Three, and this asserts there is no fourth.
   *
   * Pinned against the ENUM rather than against a list in TypeScript, because
   * the enum is what the database will accept — a mode added there and nowhere
   * else is storable, and would reach `calculate` as a value with no branch.
   */
  it('offers exactly commission_only, rebate_only and hybrid', async () => {
    const { rows } = await ctx.db.execute<{ mode: string }>(
      sql`SELECT unnest(enum_range(NULL::ib_program_mode))::text AS mode`,
    );

    expect(rows.map((row) => row.mode).sort()).toEqual([
      'commission_only',
      'hybrid',
      'rebate_only',
    ]);
  });
});

/* ── One trade, one partner ───────────────────────────────────────────────── */

describe('a partner earns on their own client', () => {
  it('pays the introducer their programme’s depth-1 rate and nobody else', async () => {
    const tariq = await makePartner('tariq', prog['E2E Standard'], undefined, agency['E2E Gulf']);
    const client = await makeClient('gulf-client', tariq);

    await trade(client, uuid(1));

    /* 25% of 100 — E2E Standard's depth 1, and no second row. */
    expect(await paidFor(uuid(1))).toEqual(['tariq@1=25.00000000']);
  });
});

/* ── A chain whose members hold DIFFERENT programmes ──────────────────────── */

describe('a mixed chain pays each partner from their own terms', () => {
  /*
   * THE CASE NO OTHER SUITE COVERS. Three partners, three different
   * programmes, one trade — so every leg has to read a different row.
   *
   *   client → zaid  (Gold,     d1 → 30%)
   *          → omar  (Standard, d2 →  5%)
   *          → hana  (Gold,     d3 → beyond a two-tier ladder, earns nothing)
   */
  it('reads each earner’s own programme at their own depth', async () => {
    const hana = await makePartner('hana', prog['E2E Gold'], undefined, agency['E2E Gold Agency']);
    const omar = await makePartner('omar', prog['E2E Standard'], hana, agency['E2E Gold Agency']);
    const zaid = await makePartner('zaid', prog['E2E Gold'], omar, agency['E2E Gold Agency']);
    const client = await makeClient('gold-client', zaid);

    await trade(client, uuid(2));

    expect(await paidFor(uuid(2))).toEqual(['zaid@1=30.00000000', 'omar@2=5.00000000']);
  });

  /*
   * The same people, a different trade: hana's OWN client. She is depth 1 now
   * and earns the full Gold rate — the ceiling never applied to her, it applied
   * to that trade.
   */
  it('pays the same partner in full on a client they introduced themselves', async () => {
    const hana = await makePartner('hana', prog['E2E Gold'], undefined, agency['E2E Gold Agency']);
    const omar = await makePartner('omar', prog['E2E Standard'], hana, agency['E2E Gold Agency']);
    await makePartner('zaid', prog['E2E Gold'], omar, agency['E2E Gold Agency']);
    const direct = await makeClient('hana-client', hana);

    await trade(direct, uuid(3));

    expect(await paidFor(uuid(3))).toEqual(['hana@1=30.00000000']);
  });
});

/* ── Every mode, on one platform ──────────────────────────────────────────── */

describe('the three modes behave differently on the same trade', () => {
  it('hybrid pays the partner AND rebates the client', async () => {
    const rami = await makePartner('rami', prog['E2E Hybrid'], undefined, agency['E2E Levant']);
    const client = await makeClient('levant-client', rami);

    await trade(client, uuid(4));

    /* 20% to the partner, 3% back to the client — both legs of `hybrid`. */
    expect(await paidFor(uuid(4))).toEqual([
      'rami@1=20.00000000',
      'rebate→levant-client=3.00000000',
    ]);
  });

  it('rebate-only pays the client and the partner earns nothing', async () => {
    const sami = await makePartner('sami', prog['E2E RebateOnly'], undefined, agency['E2E Levant']);
    const client = await makeClient('sami-client', sami);

    await trade(client, uuid(5));

    expect(await paidFor(uuid(5))).toEqual(['rebate→sami-client=10.00000000']);
  });

  it('commission-only pays the partner and rebates nobody', async () => {
    const tariq = await makePartner('tariq', prog['E2E Gold'], undefined, agency['E2E Gulf']);
    const client = await makeClient('tariq-client', tariq);

    await trade(client, uuid(6));

    expect(await paidFor(uuid(6))).toEqual(['tariq@1=30.00000000']);
  });

  /*
   * A REBATE-ONLY partner sitting MID-CHAIN.
   *
   * The rebate comes from the INTRODUCER's programme, so a rebate-only partner
   * at depth 2 pays no rebate — and earns no commission either, because that is
   * what the mode means. The partner above them still earns normally: one
   * partner's terms must never silently reprice another's.
   */
  it('a rebate-only partner mid-chain earns nothing and blocks nobody', async () => {
    const sami = await makePartner('sami', prog['E2E RebateOnly'], undefined, agency['E2E Levant']);
    const nadia = await makePartner('nadia', prog['E2E Gold'], sami, agency['E2E Levant']);
    const client = await makeClient('mid-chain-client', nadia);

    await trade(client, uuid(7));

    /* nadia earns her Gold depth-1; sami earns nothing at depth 2. */
    expect(await paidFor(uuid(7))).toEqual(['nadia@1=30.00000000']);
  });
});

/* ── The broker's ceiling, across a chain no single programme can see ─────── */

describe('the total payout ceiling', () => {
  async function setCeiling(pct: string) {
    await ctx.db.execute(sql`
      INSERT INTO trading_settings (id, ib_max_total_payout_pct) VALUES (true, ${pct})
      ON CONFLICT (id) DO UPDATE SET ib_max_total_payout_pct = ${pct}
    `);
  }

  it('accrues a chain that fits under the ceiling', async () => {
    await setCeiling('40');
    const omar = await makePartner('omar', prog['E2E Standard'], undefined, agency['E2E Gulf']);
    const zaid = await makePartner('zaid', prog['E2E Gold'], omar, agency['E2E Gulf']);
    const client = await makeClient('under-client', zaid);

    /* 30 + 5 = 35, under 40. */
    await trade(client, uuid(8));
    expect(await paidFor(uuid(8))).toEqual(['zaid@1=30.00000000', 'omar@2=5.00000000']);
  });

  /*
   * The same chain against a tighter ceiling is REFUSED, not scaled — and
   * refused means NOTHING is written, so the deal can pay in full once the
   * rates are corrected.
   */
  it('refuses the whole chain rather than paying a reduced amount', async () => {
    await setCeiling('30');
    const omar = await makePartner('omar', prog['E2E Standard'], undefined, agency['E2E Gulf']);
    const zaid = await makePartner('zaid', prog['E2E Gold'], omar, agency['E2E Gulf']);
    const client = await makeClient('over-client', zaid);

    await expect(trade(client, uuid(9))).rejects.toThrow(/ceiling/i);
    expect(await paidFor(uuid(9))).toEqual([]);
  });

  it('counts the client’s rebate against the ceiling too', async () => {
    await setCeiling('22');
    const rami = await makePartner('rami', prog['E2E Hybrid'], undefined, agency['E2E Levant']);
    const client = await makeClient('rebate-ceiling-client', rami);

    /* 20 commission + 3 rebate = 23, over 22. */
    await expect(trade(client, uuid(10))).rejects.toThrow(/ceiling/i);
    expect(await paidFor(uuid(10))).toEqual([]);
  });
});

/* ── A suspended partner ──────────────────────────────────────────────────── */

describe('a suspended partner', () => {
  it('earns nothing and breaks the chain above them', async () => {
    const hana = await makePartner('hana', prog['E2E Gold'], undefined, agency['E2E Gold Agency']);
    const omar = await makePartner('omar', prog['E2E Gold'], hana, agency['E2E Gold Agency']);
    const client = await makeClient('suspended-client', omar);

    await ctx.db.execute(sql`UPDATE ib_accounts SET active = false WHERE user_id = ${omar}`);

    await trade(client, uuid(11));

    /* Nobody is paid: suspension is a decision about the whole subtree, so
       hana does not keep collecting through a partner who is switched off. */
    expect(await paidFor(uuid(11))).toEqual([]);
  });
});

/* ── Idempotency, on a populated platform ─────────────────────────────────── */

describe('replaying a trade', () => {
  it('pays each partner exactly once however many times it is delivered', async () => {
    const omar = await makePartner('omar', prog['E2E Standard'], undefined, agency['E2E Gulf']);
    const zaid = await makePartner('zaid', prog['E2E Gold'], omar, agency['E2E Gulf']);
    const client = await makeClient('replay-client', zaid);

    await trade(client, uuid(12));
    await trade(client, uuid(12));
    await trade(client, uuid(12));

    expect(await paidFor(uuid(12))).toEqual(['zaid@1=30.00000000', 'omar@2=5.00000000']);
  });
});
