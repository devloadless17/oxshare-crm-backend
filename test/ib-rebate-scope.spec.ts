import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { IbStore } from '../src/store/ib.store';
import { scopeOf } from '../src/common/security/client-scope';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * AN ACCRUAL IS SCOPED ON WHOEVER IS PAID, AND THAT DEPENDS ON ITS KIND.
 *
 * ⚠️ This closes a live inversion. `findAccrualsPage` scoped every row on
 * `ib_user_id`, which is correct for a commission and wrong for a REBATE:
 * `CommissionService.confirmPending` states the rule the query has to follow —
 * "`ibUserId` on a rebate row is the partner whose RUNG produced it —
 * attribution, not entitlement" — and pays `clientUserId`.
 *
 * Scoping the wrong column was wrong in BOTH directions at once, which is why
 * both are asserted here:
 *
 *   - A desk holding the PARTNER's tag saw rebates that are the client's own
 *     money, for a client they hold no territory over.
 *   - A desk holding the CLIENT's tag saw none of their own client's rebates,
 *     because the row was filed under a partner they cannot see.
 *
 * Neither was hypothetical: every rebate row in the development database had
 * `ib_user_id` different from `client_user_id`.
 *
 * ## The masking is the other half
 *
 * A visible row still names two people, and the one who is NOT the beneficiary
 * may be outside the reader's territory. Their identity is nulled and a flag
 * says so — the same control the 13 Aug scoped walk added for the client on a
 * commission, now applied to the partner on a rebate.
 */

let ctx: MoneyTestContext;
let store: IbStore;

/** The partner. Tagged to the partner desk only. */
let partnerId: string;
/** Their referred client. Tagged to the client desk only. */
let clientId: string;
let partnerTagId: string;
let clientTagId: string;

async function makeUser(email: string, first: string, last: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
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
 * One accrual. `ibUserId` is the partner on BOTH kinds — that is the point: a
 * rebate records the partner whose rung priced it and pays the client.
 */
async function accrue(kind: 'commission' | 'rebate', sourceId: string) {
  await ctx.db.execute(sql`
    INSERT INTO ib_accruals
      (ib_user_id, client_user_id, kind, source_type, source_id, depth, rate_value,
       base_amount, amount, currency, status)
    VALUES
      (${partnerId}, ${clientId}, ${kind}, 'transaction', ${sourceId}, 1, '70.0000',
       '100.00000000', '70.00000000', 'USD', 'confirmed')
  `);
}

interface Row {
  accrual: { kind: string };
  partner: { id: string; email: string | null };
  client: { id: string; email: string | null };
  partnerMasked: boolean;
  clientMasked: boolean;
}

function page(tagIds: string[]) {
  return store.findAccrualsPage({
    page: 1,
    limit: 25,
    scope: scopeOf(tagIds),
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
  await accrue('rebate', '22222222-2222-2222-2222-222222222222');
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('the partner desk', () => {
  it('sees the commission it earned, and NOT the client rebate', async () => {
    const { rows } = await page([partnerTagId]);

    /*
     * The rebate is the CLIENT's money on a client this desk holds no territory
     * over. Under the old predicate both rows came back, because both carry
     * this partner in `ib_user_id`.
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
  it('sees its own client REBATE, which was invisible to it before', async () => {
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
     * The mirror of the 13 Aug finding. The rebate is visible because the
     * BENEFICIARY is in territory; the partner named on it is attribution, and
     * this desk holds no territory over them.
     */
    expect(rebate.partnerMasked).toBe(true);
    expect(rebate.partner.email).toBeNull();

    expect(rebate.clientMasked).toBe(false);
    expect(rebate.client.email).toBe('rebate-client@oxshare-e2e.test');
  });
});

describe("a partner's earnings total", () => {
  it('counts their COMMISSION only, never their clients rebates', async () => {
    const earnings = await store.earningsByPartner([partnerId]);
    const mine = earnings.get(partnerId);

    /*
     * ⚠️ This summed every accrual carrying the partner's id, and a rebate row
     * carries it too — as attribution, not entitlement. So the figure included
     * money paid to their CLIENT.
     *
     * The fixture has one confirmed commission of 70.00 and one confirmed
     * rebate of 70.00 against the same partner, so the old behaviour produced
     * exactly double. That shape was real: on the development database one
     * partner earned 20.79 and the screen read 41.58.
     *
     * The wallet was never wrong — only this display total — which is the
     * worst way for it to be wrong: an operator reconciling the commission
     * wallet against the screen finds a gap with no explanation.
     */
    expect(mine?.confirmed).toBe('70.00000000');
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
