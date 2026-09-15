import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { IbStore } from '../src/store/ib.store';
import { scopeOf, UNRESTRICTED } from '../src/common/security/client-scope';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The commission ledger can be narrowed by the PARTNER it names, in words.
 *
 * ## The defect this closes
 *
 * `/commissions` displays a named Partner column — first name, last name,
 * email — and offered exactly one way to narrow to one partner: `ibUserId`, a
 * uuid the screen prints nowhere. So an operator reading a partner's rows could
 * not filter to them without leaving for another screen to copy an id. The same
 * defect was found and fixed on `/wallets`, `/trading-accounts` and `/ledger`;
 * this is the fourth instance of one class, which is why it is now guarded by a
 * census in the admin app rather than only by these cases.
 *
 * ## Why the search reads the PARTNER and not the CLIENT
 *
 * Each accrual names two people. Rows are scoped on `ib_user_id`, and an
 * out-of-scope client's identity is MASKED in the store's mapper
 * (`ib-accrual-scope.spec.ts`). A filter that matched the client's email would
 * hand back the masking as a row COUNT: type an address, get one row, and you
 * have learned that a client with that address exists in a territory you may
 * not read. Searching only the partner — the column the scope is already
 * decided on — is what keeps the filter from becoming an existence probe, and
 * the last case here is that property stated as a test rather than a comment.
 */

let ctx: MoneyTestContext;
let store: IbStore;
let alexId: string;
let bruceId: string;
let clientId: string;
let tagId: string;

async function makeUser(email: string, first: string, last: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${first}, ${last})
    RETURNING id
  `);
  return rows[0].id;
}

async function accrue(partnerId: string, sourceId: string) {
  await ctx.db.execute(sql`
    INSERT INTO ib_accruals
      (ib_user_id, client_user_id, source_type, source_id, depth, rate_value,
       base_amount, amount, currency, status)
    VALUES
      (${partnerId}, ${clientId}, 'transaction', ${sourceId}, 1, '70.0000',
       '100.00000000', '70.00000000', 'USD', 'confirmed')
  `);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new IbStore(ctx.db);

  const { rows: tagRows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO client_tags (slug, label) VALUES ('search-desk', 'Search Desk') RETURNING id
  `);
  tagId = tagRows[0].id;

  alexId = await makeUser('alexandra@oxshare-e2e.test', 'Alexandra', 'Nolan');
  bruceId = await makeUser('bruce@oxshare-e2e.test', 'Bruce', 'Tan');
  clientId = await makeUser('traded@oxshare-e2e.test', 'Traded', 'Client');

  await ctx.db.execute(sql`
    INSERT INTO client_tag_assignments (user_id, tag_id)
    VALUES (${alexId}, ${tagId}), (${bruceId}, ${tagId}), (${clientId}, ${tagId})
  `);

  // TWO partners with accruals, deliberately: a search that returned everything
  // would pass against a single-partner fixture, which is the vacuity these
  // filter tests are most prone to.
  await accrue(alexId, '11111111-1111-1111-1111-111111111111');
  await accrue(alexId, '22222222-2222-2222-2222-222222222222');
  await accrue(bruceId, '33333333-3333-3333-3333-333333333333');
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

interface AccrualRow {
  accrual: { ibUserId: string };
  partner: { id: string; email: string | null };
}

function page(q?: string, scope = UNRESTRICTED) {
  return store.findAccrualsPage({ page: 1, limit: 25, scope, q }) as unknown as Promise<{
    rows: AccrualRow[];
    total: number;
    totals: { status: string; amount: string }[];
  }>;
}

describe('narrowing the commission ledger to a partner by name', () => {
  it('the fixture holds more than one partner, so a filter can be wrong', async () => {
    // The non-vacuity floor. Without it every assertion below would also pass
    // against a query that ignored `q` entirely.
    const all = await page();
    expect(all.total).toBe(3);
    expect(new Set(all.rows.map((r) => r.accrual.ibUserId)).size).toBe(2);
  });

  it('finds a partner by their FIRST NAME and excludes the other', async () => {
    const found = await page('alexandra');
    expect(found.rows.length).toBe(2);
    expect(found.rows.every((r) => r.accrual.ibUserId === alexId)).toBe(true);
  });

  it('finds a partner by their EMAIL', async () => {
    const found = await page('bruce@oxshare-e2e.test');
    expect(found.rows.length).toBe(1);
    expect(found.rows[0].partner.id).toBe(bruceId);
  });

  it('finds a partner by their LAST NAME, which no other column carries', async () => {
    const found = await page('Nolan');
    expect(found.rows.length).toBe(2);
    expect(found.rows.every((r) => r.accrual.ibUserId === alexId)).toBe(true);
  });

  it('is case-insensitive, because an operator types what they read', async () => {
    const found = await page('ALEXANDRA');
    expect(found.rows.length).toBe(2);
  });

  it('answers nothing rather than everything when nobody matches', async () => {
    // The failure mode worth pinning: a predicate dropped by a later edit turns
    // "no such partner" into the whole ledger, which reads as a working filter.
    const found = await page('nobody-by-this-name');
    expect(found.rows.length).toBe(0);
    expect(found.total).toBe(0);
  });

  it('counts the FILTERED set, not the whole table', async () => {
    // The count query is a separate statement and has to carry both the
    // predicate and the join it needs. Omitting the join is a 500 on the first
    // keystroke; omitting the predicate is a pager that promises pages of rows
    // the list will never show.
    const found = await page('alexandra');
    expect(found.total).toBe(2);
  });

  it('sums the FILTERED set in the status totals', async () => {
    // Same statement-level trap on the third query. A totals row computed over
    // the unfiltered table would tell an operator looking at one partner's two
    // accruals that the confirmed total is three partners' worth of money.
    const found = await page('alexandra');
    const confirmed = found.totals.find((t) => t.status === 'confirmed');
    expect(confirmed?.amount).toBe('140.00000000');
  });

  it('does NOT search the client on the row, so the filter cannot probe for one', async () => {
    // The client here is fully visible to an unrestricted reader and still must
    // not match: the search reads the partner only. If this ever returns rows,
    // the masking in `ib-accrual-scope.spec.ts` has become defeatable by typing
    // an email into a search box.
    const byClientEmail = await page('traded@oxshare-e2e.test');
    expect(byClientEmail.rows.length).toBe(0);

    const byClientName = await page('Traded');
    expect(byClientName.rows.length).toBe(0);
  });

  it('applies the search INSIDE the reader’s territory, never instead of it', async () => {
    // A filter that replaced the scope predicate rather than narrowing it would
    // be a scope escape dressed as a search box. Bruce is out of this desk's
    // territory; searching for him by name must still answer nothing.
    await ctx.db.execute(sql`
      DELETE FROM client_tag_assignments WHERE user_id = ${bruceId}
    `);
    const desk = scopeOf([tagId], false);

    const mine = await page('alexandra', desk);
    expect(mine.rows.length).toBe(2);

    const theirs = await page('bruce', desk);
    expect(theirs.rows.length).toBe(0);
    expect(theirs.total).toBe(0);
  });
});
