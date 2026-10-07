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
 * THE WHOLE IB FEATURE, END TO END, on one populated platform.
 *
 * ## Why this exists beside the suites that already pass
 *
 * Every other IB suite proves ONE rule against a fixture built for it:
 * `ib-multi-level` builds a three-deep chain, `ib-rebate` builds the rebate
 * split, `ib-applications` builds an agency. Each is deliberately minimal,
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
const who: Record<string, number> = {};
/** Programme ids, by name. */
/** Agency ids, by name. */
const agency: Record<string, string> = {};

async function makeUser(handle: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
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
/**
 * Set the ladder — one rate per rung, level 1 first, with an optional rebate on
 * the introducer's rung.
 *
 * There is ONE ladder now rather than a programme per partner, so this replaces
 * `makeProgram`. Every rung is reset before the requested rates are applied: a
 * rate left behind by a previous case would pay a partner terms the current one
 * never configured, and these suites share a database.
 */
/*
 * ⚠️ WRITTEN WITH THE 0117 CHECK LIFTED, deliberately.
 *
 * `ib_levels_commission_shape` refuses `percent` since 0117: every rung an
 * operator can SAVE is priced per lot. These cases are about the percentage
 * ARITHMETIC — the ceiling, the chain total, the rebate against one revenue —
 * which the engine still performs for rungs configured before that migration
 * and which nothing else covers.
 *
 * Dropping the constraint for the insert reproduces exactly that: a row the
 * form can no longer create and the engine must still price correctly. Writing
 * these as per-lot instead would leave the percentage paths untested while
 * live rows still use them.
 */
/**
 * The product's rate card: $40 a lot of commission and $5 a lot of rebate
 * (0140). Every trade here is ONE LOT, so each trade puts a $40 commission
 * POOL on the table and a $5 rebate pool.
 *
 * Since 0197 the commission pool is split down the chain rather than each rung
 * taking its share independently: a sub-partner (level 2+) takes their share,
 * and the level 1 partner takes 100% minus what was paid beneath them — the
 * whole $40 on their own client, $28 (70%) beside a default 30% sub-partner.
 * Level 1's own share on the ladder decides nothing.
 *
 * Since 0209 the REBATE pool is partner money too, split the same way with the
 * rebate shares — the client gets none of it. Both pools are paid in full on
 * every trade, so together ($45) they sit under the shipped $50-a-lot ceiling.
 */
let terms: CommissionTypeTerms;

/**
 * The ladder, level 1 first: a commission share and a rebate share per rung.
 * Level 1's own shares decide nothing (0197, 0209) — the level 1 partner takes
 * the rest of each pool. Every rung is reset.
 */
async function setLadder(rates: string[], rebates: string[] = []): Promise<void> {
  const shares: RungShares[] = rates.map((commission, index) => ({
    commission,
    rebate: rebates[index] ?? '0',
  }));
  if (shares.length === 0) shares.push({ commission: '0' });
  await setLadderShares(ctx.db, shares);
}

async function makeAgency(name: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO agencies (name, enabled, sort_order)
    VALUES (${name}, true, 0)
    RETURNING id
  `);
  agency[name] = rows[0].id;
  return rows[0].id;
}

/** A partner, optionally beneath another. Built top-down: `parent` is a self-FK. */
/**
 * A partner on a RUNG — 0112.
 *
 * `level` replaced the programme argument, and the difference is the whole
 * change: a partner's terms follow where they sit rather than a card assigned
 * to them. Level 1 deals with the broker directly; each recruited partner is one
 * deeper, which the caller states because these fixtures build the trees they
 * are testing.
 */
async function makePartner(
  handle: string,
  level: number,
  parent?: number,
  agencyId?: string,
): Promise<number> {
  const id = await makeUser(handle);
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, active, level, agency_id)
    VALUES (${id}, ${parent ?? null}, ${handle.toUpperCase().padEnd(8, 'X').slice(0, 8)}, true,
            ${level}, ${agencyId ?? null})
  `);
  return id;
}

/** A trading client, attributed to `introducer`. */
async function makeClient(handle: string, introducer: number): Promise<number> {
  const id = await makeUser(handle);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${introducer} WHERE id = ${id}`,
  );
  return id;
}

/** One closed one-lot trade on the product above, or on `rateCard`. */
async function trade(clientUserId: number, sourceId: string, rateCard = terms) {
  return commissions.accrueForDeal({
    dealRowId: sourceId,
    ticket: sourceId.slice(0, 6),
    clientUserId,
    lots: '1.00000000',
    currency: 'USD',
    terms: rateCard,
  });
}

/**
 * What landed, as `handle@depth=amount` strings — readable in a failure
 * message. Commission rows first, then rebates as `rebate:handle@depth=amount`;
 * a rebate flagged `paid_to_client` (only ever a pre-0209 row) renders as
 * `rebate→client:…`, so a new one written that way fails every expectation.
 */
async function paidFor(sourceId: string): Promise<string[]> {
  const { rows } = await ctx.db.execute<{
    ib_user_id: number;
    client_user_id: number | null;
    kind: string;
    depth: number;
    amount: string;
    paid_to_client: boolean;
  }>(sql`
    SELECT ib_user_id, client_user_id, kind, depth, amount, paid_to_client
      FROM ib_accruals WHERE source_id = ${sourceId} ORDER BY kind, depth
  `);

  const nameOf = (id: number) =>
    Object.entries(who).find(([, value]) => value === id)?.[0] ?? String(id);

  return rows.map((row) =>
    row.kind === 'rebate'
      ? row.paid_to_client
        ? `rebate→client:${nameOf(row.client_user_id ?? 0)}=${row.amount}`
        : `rebate:${nameOf(row.ib_user_id)}@${row.depth}=${row.amount}`
      : `${nameOf(row.ib_user_id)}@${row.depth}=${row.amount}`,
  );
}

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  const seeded = await seedProductTerms(ctx.db, {
    name: 'End-to-end terms',
    commissionPerLot: '40',
    rebatePerLot: '5',
  });
  terms = {
    id: seeded.typeId,
    name: 'End-to-end terms',
    enabled: true,
    commissionPerLot: '40.00000000',
    rebatePerLot: '5.00000000',
  };

  commissions = new CommissionService(
    ctx.db,
    new WalletService(ctx.db),
    {
      notify: vi.fn().mockResolvedValue(undefined),
      notifyAdmins: vi.fn().mockResolvedValue(undefined),
    },

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
  /* Back to the shipped per-lot ceiling: a case that lowers it must not leak. */
  await ctx.db.execute(sql`
    INSERT INTO trading_settings (id, ib_max_payout_per_lot) VALUES (true, '50')
    ON CONFLICT (id) DO UPDATE SET ib_max_payout_per_lot = '50'
  `);
  for (const key of Object.keys(who)) delete who[key];

  /*
   * The two rungs the business asked for: a main partner and a partner under
   * them, the sub-partner on the owner's default 30%. Level 1's 50% is ignored
   * by the engine (0197) — it is set to a figure that would show up in an
   * amount if it were not. The same for the rebate (0209): rung 2 takes 20% of
   * the rebate pool, and level 1's 50% decides nothing.
   */
  await setLadder(['50', '30'], ['50', '20']);

  await makeAgency('E2E Gold Agency');
  await makeAgency('E2E Levant');
  await makeAgency('E2E Gulf');
});

/* ── THE TWO RULES THE BUSINESS STATED, PINNED DIRECTLY ───────────────────── */

/*
 * A describe asserting the three programme MODES stood here — FR-IB-05's
 * `commission_only` / `rebate_only` / `hybrid`, checked against the enum so a
 * fourth could not be added in the database alone. The modes went with the
 * catalogue in 0112: they were a label describing which of two numbers were
 * set, and the numbers say that themselves.
 *
 * What replaces it is more valuable, because it is what the business actually
 * asked for and nothing else in this suite states it as one property:
 *
 *   "the second partner should not get any money for the clients of the main
 *    partner, but the main partner can get money from the users under the
 *    second partner"
 *
 * Both halves hold by CONSTRUCTION rather than by a rate — `resolveChain`
 * climbs `parent_ib_user_id` upward from the client's introducer, so a
 * sub-partner is simply never in the chain for their parent's own clients. That
 * is exactly why it is worth a test: a property that holds because of the
 * direction of a walk is one a later refactor can lose without any rate
 * changing, and the failure would be money paid to somebody who never
 * introduced the client.
 */
describe('who earns from whom, in a two-level tree', () => {
  /*
   * ONE tree, TWO trades, built once so both assertions describe the same
   * people. `hana` deals with the broker directly (rung 1); `omar` is the
   * partner she recruited (rung 2). Each introduces a client of their own.
   */
  async function tree() {
    await setLadder(['50', '30'], ['50', '20']);
    const hana = await makePartner('hana', 1, undefined, agency['E2E Gold Agency']);
    const omar = await makePartner('omar', 2, hana, agency['E2E Gold Agency']);
    return {
      hana,
      omar,
      hanaClient: await makeClient('hana-own-client', hana),
      omarClient: await makeClient('omar-own-client', omar),
    };
  }

  it('pays the sub-partner NOTHING on a client the main partner introduced', async () => {
    const { hanaClient } = await tree();

    await trade(hanaClient, uuid(20));

    /*
     * One row, and `omar` is not in it. Not "omar earns 0" — he is not an
     * earner on this trade at all, which is the difference between a rate set
     * to zero and a relationship that does not exist. With nobody beneath her
     * on this trade, hana takes the whole $40 pool — and the whole $5 rebate.
     */
    expect(await paidFor(uuid(20))).toEqual(['hana@1=40.00000000', 'rebate:hana@1=5.00000000']);
  });

  it('pays the main partner on a client the sub-partner introduced', async () => {
    const { omarClient } = await tree();

    await trade(omarClient, uuid(21));

    /*
     * BOTH earn, out of ONE pool — which is the whole of 0197.
     *
     * `omar` stands on rung 2 and takes rung 2's 30% of the $40 pool. `hana`
     * stands on rung 1 and takes what omar did not: 70%. Level 1's own 50% on
     * the ladder plays no part.
     *
     * ⚠️ Read the `@n` as DEPTH, not as a rung — it is `ib_accruals.depth`, how
     * far below each earner the trade happened. So `omar@1=12` is "the
     * introducer, paid his rung 2 share" and `hana@2=28` is "one hop up, paid
     * the rest".
     *
     * The rebate pool splits the same way (0209): omar's rung 2 takes 20% of
     * $5, hana the rest. The client is paid none of it.
     */
    expect(await paidFor(uuid(21))).toEqual([
      'omar@1=12.00000000',
      'hana@2=28.00000000',
      'rebate:omar@1=1.00000000',
      'rebate:hana@2=4.00000000',
    ]);
  });

  /*
   * A sub-partner's OWN shares (`commission_share_override`,
   * `rebate_share_override`) beat their rung's, and the main partner's rest
   * follows each: the owner's 50/50 example, and a 40% rebate share.
   */
  it('splits by the sub-partner’s own shares when they are set', async () => {
    const { omar, omarClient } = await tree();
    await ctx.db.execute(sql`
      UPDATE ib_accounts SET commission_share_override = '50', rebate_share_override = '40'
       WHERE user_id = ${omar}
    `);

    await trade(omarClient, uuid(22));

    expect(await paidFor(uuid(22))).toEqual([
      'omar@1=20.00000000',
      'hana@2=20.00000000',
      'rebate:omar@1=2.00000000',
      'rebate:hana@2=3.00000000',
    ]);
  });
});

/* ── One trade, one partner ───────────────────────────────────────────────── */

describe('a partner earns on their own client', () => {
  it('pays a level 1 introducer the whole commission and rebate, and nobody else', async () => {
    await setLadder(['25', '8'], ['25', '8']);
    const tariq = await makePartner('tariq', 1, undefined, agency['E2E Gulf']);
    const client = await makeClient('gulf-client', tariq);

    await trade(client, uuid(1));

    /* The whole $40 and the whole $5 — not level 1's 25% of either — and nobody
       else: nobody sits above him, and the client is paid nothing. */
    expect(await paidFor(uuid(1))).toEqual(['tariq@1=40.00000000', 'rebate:tariq@1=5.00000000']);
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
  /*
   * Three partners, three rungs, one trade.
   *
   * `hana` deals with the broker and is rung 1; `omar` was recruited by her at
   * rung 2; `zaid` by him at rung 3. The client belongs to `zaid`, so the trade
   * reaches him at DEPTH 1 — and he is paid the THIRD rung's share, because the
   * rung follows the partner and the depth follows the trade.
   *
   * New partners are capped at two levels, but a three-deep tree built directly
   * in the data is still walked: every sub-partner (level 2+) takes their own
   * rung's share, and the level 1 partner takes 100 − 8 − 5 = 87% of the pool.
   * The rebate pool the same way with the rebate shares: 100 − 10 − 20 = 70%.
   */
  it('pays each sub-partner by their rung and the level 1 partner the rest', async () => {
    await setLadder(['30', '8', '5'], ['30', '10', '20']);
    const hana = await makePartner('hana', 1, undefined, agency['E2E Gold Agency']);
    const omar = await makePartner('omar', 2, hana, agency['E2E Gold Agency']);
    const zaid = await makePartner('zaid', 3, omar, agency['E2E Gold Agency']);
    const client = await makeClient('gold-client', zaid);

    await trade(client, uuid(2));

    expect(await paidFor(uuid(2))).toEqual([
      'zaid@1=2.00000000',
      'omar@2=3.20000000',
      'hana@3=34.80000000',
      'rebate:zaid@1=1.00000000',
      'rebate:omar@2=0.50000000',
      'rebate:hana@3=3.50000000',
    ]);
  });

  /*
   * The same people, a different trade: hana's OWN client. She is depth 1 now
   * with nobody beneath her on the trade, so she takes the whole pool.
   */
  it('pays the same partner the whole pool on a client they introduced themselves', async () => {
    await setLadder(['30', '8'], ['30', '10']);
    const hana = await makePartner('hana', 1, undefined, agency['E2E Gold Agency']);
    const omar = await makePartner('omar', 2, hana, agency['E2E Gold Agency']);
    await makePartner('zaid', 3, omar, agency['E2E Gold Agency']);
    const direct = await makeClient('hana-client', hana);

    await trade(direct, uuid(3));

    expect(await paidFor(uuid(3))).toEqual(['hana@1=40.00000000', 'rebate:hana@1=5.00000000']);
  });
});

/* ── Every mode, on one platform ──────────────────────────────────────────── */

/*
 * The three programme MODES are gone with the catalogue (0112). What replaced
 * them is SHAPES — a type with both pools, a type with no rebate, a sub-partner
 * whose commission share is zero — and the behaviours they produce still
 * matter, so the tests keep their substance and lose the vocabulary.
 *
 * Since 0209 every shape pays PARTNERS only: the client who traded is never an
 * earner, whatever the rung or the type says.
 */
describe('a trade pays whichever of its two pools is set, to partners only', () => {
  it('pays the partner both the commission AND the rebate, and the client nothing', async () => {
    await setLadder(['20', '5'], ['3']);
    const rami = await makePartner('rami', 1, undefined, agency['E2E Levant']);
    const client = await makeClient('levant-client', rami);

    await trade(client, uuid(4));

    /* The whole $40 and the whole $5 to the level 1 partner — level 1's 3%
       rebate share decides nothing — and no row names the client as an earner. */
    expect(await paidFor(uuid(4))).toEqual(['rami@1=40.00000000', 'rebate:rami@1=5.00000000']);
    const { rows } = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM ib_accruals
       WHERE source_id = ${uuid(4)} AND (ib_user_id = ${client} OR paid_to_client)
    `);
    expect(rows[0].n).toBe(0);
  });

  /*
   * Level 1's own share no longer decides anything (0197), so "commission at
   * zero" is a SUB-PARTNER whose own share is 0 — a lone one, with no level 1
   * partner above to take the rest. Their rung's rebate share still pays THEM.
   */
  it('pays a lone sub-partner only their rebate share when they take no commission', async () => {
    await setLadderShares(ctx.db, [{ commission: '50' }, { commission: '30', rebate: '10' }]);
    const sami = await makePartner('sami', 2, undefined, agency['E2E Levant']);
    await ctx.db.execute(
      sql`UPDATE ib_accounts SET commission_share_override = '0' WHERE user_id = ${sami}`,
    );
    const client = await makeClient('sami-client', sami);

    await trade(client, uuid(5));

    /* 10% of the $5 pool, to sami; nobody above him takes the rest. */
    expect(await paidFor(uuid(5))).toEqual(['rebate:sami@1=0.50000000']);
  });

  /*
   * "Commission only" is a TYPE with no rebate on it. A level 1 partner takes
   * the rest of the rebate pool whatever their own share says, so setting
   * level 1's rebate share to 0 switches nothing off — the next case pins that.
   */
  it('pays no rebate when the commission type carries none', async () => {
    await setLadder(['30', '8'], ['0', '10']);
    const tariq = await makePartner('tariq', 1, undefined, agency['E2E Gulf']);
    const client = await makeClient('tariq-client', tariq);

    await trade(client, uuid(6), { ...terms, rebatePerLot: '0.00000000' });

    expect(await paidFor(uuid(6))).toEqual(['tariq@1=40.00000000']);
  });

  it('pays a level 1 partner the whole rebate even when level 1’s rebate share is 0', async () => {
    await setLadder(['30', '8'], ['0', '10']);
    const tariq = await makePartner('tariq', 1, undefined, agency['E2E Gulf']);
    const client = await makeClient('tariq-own-client', tariq);

    await trade(client, uuid(13));

    expect(await paidFor(uuid(13))).toEqual(['tariq@1=40.00000000', 'rebate:tariq@1=5.00000000']);
  });

  /*
   * A rung paying NOTHING, sitting above the introducer.
   *
   * Rung 2 here pays no commission share and no rebate share, so `sami` takes
   * nothing of either pool. The partner BELOW him, on rung 1, still earns
   * normally — the rest of each pool, which is all of it: one rung's terms must
   * never silently reprice another's.
   */
  it('a rung paying nothing mid-chain earns nothing and blocks nobody', async () => {
    await setLadder(['30'], ['0']);
    const sami = await makePartner('sami', 2, undefined, agency['E2E Levant']);
    const nadia = await makePartner('nadia', 1, sami, agency['E2E Levant']);
    const client = await makeClient('mid-chain-client', nadia);

    await trade(client, uuid(7));

    /* nadia, on rung 1, takes both whole pools; sami's rung 2 pays nothing, so he earns nothing. */
    expect(await paidFor(uuid(7))).toEqual(['nadia@1=40.00000000', 'rebate:nadia@1=5.00000000']);
  });
});

/* ── The broker's ceiling, across a chain no single programme can see ─────── */

describe('the per-lot payout ceiling', () => {
  /*
   * `ib_max_payout_per_lot` — the unit-error guard, and the only ceiling
   * since 0140 (the percentage-of-revenue one had nothing left to bound).
   * On a $40-a-lot type and one-lot trades every chain pays the whole $40
   * pool (0197), plus the whole $5 rebate pool to the partners (0209).
   */
  async function setCeiling(perLot: string) {
    await ctx.db.execute(sql`
      INSERT INTO trading_settings (id, ib_max_payout_per_lot) VALUES (true, ${perLot})
      ON CONFLICT (id) DO UPDATE SET ib_max_payout_per_lot = ${perLot}
    `);
  }

  it('accrues a chain that fits under the ceiling', async () => {
    await setCeiling('48');
    await setLadder(['30', '5'], ['30', '5']);
    const omar = await makePartner('omar', 1, undefined, agency['E2E Gulf']);
    const zaid = await makePartner('zaid', 2, omar, agency['E2E Gulf']);
    const client = await makeClient('under-client', zaid);

    /* 5% at rung 2 ($2) plus the rest, 95%, at rung 1 ($38) = $40, and the $5
       rebate split the same way ($0.25 + $4.75) — $45 in all, under 48. */
    await trade(client, uuid(8));
    expect(await paidFor(uuid(8))).toEqual([
      'zaid@1=2.00000000',
      'omar@2=38.00000000',
      'rebate:zaid@1=0.25000000',
      'rebate:omar@2=4.75000000',
    ]);
  });

  /*
   * The same chain against a tighter ceiling is REFUSED, not scaled — and
   * refused means NOTHING is written, so the deal can pay in full once the
   * rates are corrected.
   */
  it('refuses the whole chain rather than paying a reduced amount', async () => {
    await setCeiling('30');
    await setLadder(['30', '5']);
    const omar = await makePartner('omar', 1, undefined, agency['E2E Gulf']);
    const zaid = await makePartner('zaid', 2, omar, agency['E2E Gulf']);
    const client = await makeClient('over-client', zaid);

    /* $45 across the chain (commission and rebate), over 30. */
    await expect(trade(client, uuid(9))).rejects.toThrow(/ceiling/i);
    expect(await paidFor(uuid(9))).toEqual([]);
  });

  it('counts the partners’ rebate against the ceiling too', async () => {
    /* Rami's $40 commission alone fits under 42; with his $5 rebate the trade costs 45. */
    await setCeiling('42');
    const rami = await makePartner('rami', 1, undefined, agency['E2E Levant']);
    const client = await makeClient('rebate-ceiling-client', rami);

    /* 40 commission + 5 rebate = 45, over 42. */
    await expect(trade(client, uuid(10))).rejects.toThrow(/ceiling/i);
    expect(await paidFor(uuid(10))).toEqual([]);
  });
});

/* ── A suspended partner ──────────────────────────────────────────────────── */

describe('a suspended partner', () => {
  it('earns nothing and breaks the chain above them', async () => {
    const hana = await makePartner('hana', 1, undefined, agency['E2E Gold Agency']);
    const omar = await makePartner('omar', 2, hana, agency['E2E Gold Agency']);
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
    await setLadder(['30', '5'], ['30', '5']);
    const omar = await makePartner('omar', 1, undefined, agency['E2E Gulf']);
    const zaid = await makePartner('zaid', 2, omar, agency['E2E Gulf']);
    const client = await makeClient('replay-client', zaid);

    await trade(client, uuid(12));
    await trade(client, uuid(12));
    await trade(client, uuid(12));

    // Four rows after three deliveries — one per (earner, kind). The
    // `ib_accruals_source_earner_uq` index absorbs the replays rather than the
    // code checking first and inserting after.
    expect(await paidFor(uuid(12))).toEqual([
      'zaid@1=2.00000000',
      'omar@2=38.00000000',
      'rebate:zaid@1=0.25000000',
      'rebate:omar@2=4.75000000',
    ]);
  });
});
