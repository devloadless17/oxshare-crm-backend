import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { IbStore } from '../src/store/ib.store';
import { scopeOf } from '../src/common/security/client-scope';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * AN ACCRUAL IS SCOPED ON WHOEVER WAS PAID.
 *
 * Since 0209 (owner, 7 Oct 2026) that is the PARTNER on every new accrual —
 * commission and rebate alike: the rebate is partner money, split down the
 * chain and credited to the partner's commission wallet, and the client gets
 * nothing. Only a LEGACY rebate, paid to the trading client before 0209 and
 * marked `paid_to_client = true` by that migration, still has the CLIENT as its
 * beneficiary. `accrualBeneficiarySql` is that rule in SQL, and
 * `findAccrualsPage` scopes every row by it.
 *
 * ⚠️ This closed a live inversion, and the legacy rows still carry it. Scoping a
 * client-paid rebate on `ib_user_id` was wrong in BOTH directions at once,
 * which is why both are asserted here:
 *
 *   - A desk holding the PARTNER's tag saw rebates that are the client's own
 *     money, for a client they hold no territory over.
 *   - A desk holding the CLIENT's tag saw none of their own client's rebates,
 *     because the row was filed under a partner they cannot see.
 *
 * And the new rule must not be read through the old one: a NEW rebate is the
 * partner's, so the partner desk sees it and the client desk does not.
 *
 * ## The masking is the other half
 *
 * A visible row still names two people, and the one who is NOT the beneficiary
 * may be outside the reader's territory. Their identity is nulled and a flag
 * says so — the same control the 13 Aug scoped walk added for the client on a
 * commission, applied to the partner on a legacy rebate.
 */

let ctx: MoneyTestContext;
let store: IbStore;

/** The partner. Tagged to the partner desk only. */
let partnerId: number;
/** Their referred client. Tagged to the client desk only. */
let clientId: number;
let partnerTagId: string;
let clientTagId: string;

async function makeUser(email: string, first: string, last: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${first}, ${last})
    RETURNING id
  `);
  return rows[0].id;
}

async function makeTag(slug: string, label: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO client_tags (slug, label) VALUES (${slug}, ${label}) RETURNING id
  `);
  return rows[0].id;
}

/**
 * One accrual. `ibUserId` is the partner on every kind — that is the point:
 * whether the row is the partner's or the client's is decided by
 * `paid_to_client`, never by which id happens to be on it.
 */
async function accrue(
  kind: 'commission' | 'rebate',
  sourceId: string,
  paidToClient = false,
  amount = '70.00000000',
) {
  await ctx.db.execute(sql`
    INSERT INTO ib_accruals
      (ib_user_id, client_user_id, kind, source_type, source_id, depth, rate_value,
       base_amount, amount, currency, status, paid_to_client)
    VALUES
      (${partnerId}, ${clientId}, ${kind}, 'transaction', ${sourceId}, 1, '70.0000',
       '100.00000000', ${amount}, 'USD', 'confirmed', ${paidToClient})
  `);
}

interface Row {
  accrual: { kind: string; amount: string };
  partner: { id: string; email: string | null };
  client: { id: string; email: string | null };
  partnerMasked: boolean;
  clientMasked: boolean;
}

function page(tagIds: string[]) {
  return store.findAccrualsPage({
    page: 1,
    limit: 25,
    scope: scopeOf(tagIds, false),
  }) as unknown as Promise<{ rows: Row[]; total: number }>;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new IbStore(ctx.db);

  partnerTagId = await makeTag('rebate-partner-desk', 'Partner Desk');
  clientTagId = await makeTag('rebate-client-desk', 'Client Desk');

  partnerId = await makeUser('rebate-partner@oxshare-e2e.test', 'Paula', 'Partner');
  clientId = await makeUser('rebate-client@oxshare-e2e.test', 'Clive', 'Client');

  /*
   * DISJOINT territories, which is what makes the two directions separable. A
   * fixture that tagged both people to one desk would pass under the old
   * predicate and the new one alike.
   */
  await ctx.db.execute(sql`
    INSERT INTO client_tag_assignments (user_id, tag_id)
    VALUES (${partnerId}, ${partnerTagId}), (${clientId}, ${clientTagId})
  `);

  await accrue('commission', '11111111-1111-1111-1111-111111111111');
  // LEGACY: a rebate the old engine paid to the client, before 0209.
  await accrue('rebate', '22222222-2222-2222-2222-222222222222', true);
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('the partner desk', () => {
  it('sees the commission it earned, and NOT the legacy client-paid rebate', async () => {
    const { rows } = await page([partnerTagId]);

    /*
     * The legacy rebate is the CLIENT's money on a client this desk holds no
     * territory over. Under the old predicate both rows came back, because
     * both carry this partner in `ib_user_id`.
     */
    expect(rows.map((r) => r.accrual.kind)).toEqual(['commission']);
  });

  it('masks the out-of-scope client on the commission it can see', async () => {
    const { rows } = await page([partnerTagId]);
    const [commission] = rows;

    // The row is theirs to review; the client who generated it is not theirs
    // to identify.
    expect(commission.clientMasked).toBe(true);
    expect(commission.client.email).toBeNull();

    // The beneficiary is in territory and is never masked.
    expect(commission.partnerMasked).toBe(false);
    expect(commission.partner.email).toBe('rebate-partner@oxshare-e2e.test');
  });
});

describe('the client desk', () => {
  it('sees its own client’s LEGACY rebate, which was invisible to it before', async () => {
    const { rows } = await page([clientTagId]);

    /*
     * The half that was silently missing. A desk holding this client saw no
     * rebate at all, because the row was filed under a partner in another
     * territory — so a client's own money did not appear on the screen that
     * exists to show it.
     */
    expect(rows.map((r) => r.accrual.kind)).toEqual(['rebate']);
  });

  it('masks the attributed partner, who is outside its territory', async () => {
    const { rows } = await page([clientTagId]);
    const [rebate] = rows;

    /*
     * The mirror of the 13 Aug finding. The legacy rebate is visible because
     * the BENEFICIARY (the client it was paid to) is in territory; the partner
     * named on it is attribution, and this desk holds no territory over them.
     */
    expect(rebate.partnerMasked).toBe(true);
    expect(rebate.partner.email).toBeNull();

    expect(rebate.clientMasked).toBe(false);
    expect(rebate.client.email).toBe('rebate-client@oxshare-e2e.test');
  });
});

describe("a partner's earnings total", () => {
  it('counts their COMMISSION, never a rebate that was paid to their client', async () => {
    const earnings = await store.earningsByPartner([partnerId]);
    const mine = earnings.get(partnerId);

    /*
     * ⚠️ This summed every accrual carrying the partner's id, and a legacy
     * rebate row carries it too — as attribution, not entitlement. So the
     * figure included money paid to their CLIENT.
     *
     * The fixture has one confirmed commission of 70.00 and one confirmed
     * LEGACY rebate of 70.00 against the same partner, so the old behaviour
     * produced exactly double. That shape was real: on the development
     * database one partner earned 20.79 and the screen read 41.58.
     *
     * One entry per currency since the directory returned — the fixture
     * accrues in one, so there is exactly one line and it holds 70, not 140.
     */
    expect(mine).toHaveLength(1);
    expect(mine?.[0]?.confirmed).toBe('70.00000000');
  });
});

describe('an unrestricted reader', () => {
  it('sees both rows with nobody masked', async () => {
    const { rows } = await page([partnerTagId, clientTagId]);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.partnerMasked).toBe(false);
      expect(row.clientMasked).toBe(false);
    }
  });
});

/*
 * LAST, and with its own fixture: from here on a NEW (0209) rebate exists
 * beside the two rows above, which the counts in the cases above do not expect.
 */
describe('a NEW rebate (0209) is the PARTNER’s, and is scoped on the partner', () => {
  beforeAll(async () => {
    // Partner money: `paid_to_client` false, as every rebate since 0209 is written.
    // A different amount from the legacy row, so the two cannot be confused.
    await accrue('rebate', '33333333-3333-3333-3333-333333333333', false, '30.00000000');
  });

  it('the partner desk sees it beside its commission', async () => {
    const { rows } = await page([partnerTagId]);

    expect(rows.map((r) => [r.accrual.kind, r.accrual.amount]).sort()).toEqual(
      [
        ['commission', '70.00000000'],
        ['rebate', '30.00000000'],
      ].sort(),
    );

    // The partner is the beneficiary and is never masked; the client — who was
    // paid nothing and is outside this desk — is.
    const rebate = rows.find((r) => r.accrual.kind === 'rebate')!;
    expect(rebate.partnerMasked).toBe(false);
    expect(rebate.partner.email).toBe('rebate-partner@oxshare-e2e.test');
    expect(rebate.clientMasked).toBe(true);
    expect(rebate.client.email).toBeNull();
  });

  it('the client desk does NOT see it — the client received none of it', async () => {
    const { rows } = await page([clientTagId]);

    // Only the legacy rebate, which really was the client's money.
    expect(rows.map((r) => [r.accrual.kind, r.accrual.amount])).toEqual([
      ['rebate', '70.00000000'],
    ]);
  });

  it('an unrestricted reader sees all three, with nobody masked', async () => {
    const { rows } = await page([partnerTagId, clientTagId]);

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.partnerMasked).toBe(false);
      expect(row.clientMasked).toBe(false);
    }
  });
});
