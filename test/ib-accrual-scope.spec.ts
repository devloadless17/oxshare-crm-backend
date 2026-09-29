import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { IbStore } from '../src/store/ib.store';
import { scopeOf, UNRESTRICTED } from '../src/common/security/client-scope';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The commission ledger masks the OUT-OF-SCOPE client's identity (#4, the
 * 13 Aug scoped walk).
 *
 * Accrual rows are scoped on the PARTNER (`ib_user_id`), so a scoped admin sees
 * an in-territory partner's accruals — but each accrual also names the CLIENT
 * whose deposit generated it, and that client may be outside the reader's tags.
 * The row and its AMOUNTS stay (the partner's earning is theirs to review); the
 * client's name and email are nulled and `clientMasked` is raised, so a scoped
 * desk never reads the PII of a client it may not see. Real Postgres, because
 * the mask is computed in the query.
 */

let ctx: MoneyTestContext;
let store: IbStore;
let partnerId: string;
let inScopeClientId: string;
let outScopeClientId: string;
let tagId: string;

async function makeUser(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${email.split('@')[0]}, 'Person')
    RETURNING id
  `);
  return rows[0].id;
}

async function accrue(clientId: string, sourceId: string) {
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
    INSERT INTO client_tags (slug, label) VALUES ('accrual-desk', 'Accrual Desk') RETURNING id
  `);
  tagId = tagRows[0].id;

  partnerId = await makeUser('accrual-partner@oxshare-e2e.test');
  inScopeClientId = await makeUser('accrual-inscope@oxshare-e2e.test');
  outScopeClientId = await makeUser('accrual-outscope@oxshare-e2e.test');

  // The partner and the in-scope client carry the desk's tag; the out-of-scope
  // client carries nothing.
  await ctx.db.execute(sql`
    INSERT INTO client_tag_assignments (user_id, tag_id)
    VALUES (${partnerId}, ${tagId}), (${inScopeClientId}, ${tagId})
  `);

  await accrue(inScopeClientId, '11111111-1111-1111-1111-111111111111');
  await accrue(outScopeClientId, '22222222-2222-2222-2222-222222222222');
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

interface AccrualRow {
  accrual: { clientUserId: string; amount: string };
  client: { id: string; email: string | null; firstName: string | null; lastName: string | null };
  clientMasked: boolean;
}

describe('commission accruals mask the out-of-scope client (#4)', () => {
  it('a scoped desk sees BOTH the partner’s accruals, with amounts intact', async () => {
    const { rows } = (await store.findAccrualsPage({
      page: 1,
      limit: 10,
      scope: scopeOf([tagId], false, false),
    })) as unknown as { rows: AccrualRow[] };

    // Scoped on the partner, who is in territory — both rows are present.
    expect(rows.length).toBe(2);
    // The amounts survive on both: earnings are not PII.
    expect(rows.every((r) => r.accrual.amount === '70.00000000')).toBe(true);
  });

  it('shows the in-scope client’s identity and HIDES the out-of-scope one’s', async () => {
    const { rows } = (await store.findAccrualsPage({
      page: 1,
      limit: 10,
      scope: scopeOf([tagId], false, false),
    })) as unknown as { rows: AccrualRow[] };

    const mine = rows.find((r) => r.client.id === inScopeClientId);
    // Found by the flag: the outside client's id is no longer sent at all.
    const theirs = rows.find((r) => r.clientMasked);

    // In-scope: full identity, not masked.
    expect(mine?.clientMasked).toBe(false);
    expect(mine?.client.email).toBe('accrual-inscope@oxshare-e2e.test');

    // Out-of-scope: the row is here (partner-scoped) but the client is masked —
    // no name, no email, flagged so the screen can say "outside your territory".
    expect(theirs?.clientMasked).toBe(true);
    expect(theirs?.client.email).toBeNull();
    expect(theirs?.client.firstName).toBeNull();
    expect(theirs?.client.lastName).toBeNull();
  });

  it('sends no id of the outside client — not on the person, not on the accrual', async () => {
    const page = await store.findAccrualsPage({
      page: 1,
      limit: 10,
      scope: scopeOf([tagId], false, false),
    });
    const theirs = page.rows.find((r) => r.clientMasked)!;
    expect(theirs.client.id).toBeNull();
    expect(theirs.accrual.clientUserId).toBeNull();
    expect(theirs.accrual.sourceId).toBeNull();
    expect(JSON.stringify(page)).not.toContain(outScopeClientId);
  });

  it('a filter or search naming the outside client answers like an unknown one', async () => {
    const scope = scopeOf([tagId], false, false);
    // The control: the same filter on the in-scope client finds its row.
    const mine = await store.findAccrualsPage({
      page: 1,
      limit: 10,
      scope,
      clientUserId: inScopeClientId,
    });
    expect(mine.total).toBe(1);

    const byId = await store.findAccrualsPage({
      page: 1,
      limit: 10,
      scope,
      clientUserId: outScopeClientId,
    });
    expect(byId.total).toBe(0);
    expect(byId.totals).toEqual([]);
    // Unrestricted, the same filter does find it — the refusal is scope, not data.
    const all = await store.findAccrualsPage({
      page: 1,
      limit: 10,
      scope: UNRESTRICTED,
      clientUserId: outScopeClientId,
    });
    expect(all.total).toBe(1);
  });

  it('masks nothing for an unrestricted reader', async () => {
    const { rows } = (await store.findAccrualsPage({
      page: 1,
      limit: 10,
      scope: UNRESTRICTED,
    })) as unknown as { rows: AccrualRow[] };

    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.clientMasked === false)).toBe(true);
    expect(rows.every((r) => r.client.email !== null)).toBe(true);
  });
  it('the partner search matches only a partner the reader may see', async () => {
    const outsider = scopeOf([tagId], false, false);
    // Runs LAST: it adds a rebate row the counts above do not expect.
    const { rows: tag } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO client_tags (slug, label) VALUES ('accrual-other', 'Other') RETURNING id`);
    const hiddenPartner = await makeUser('accrual-hidden-partner@oxshare-e2e.test');
    await ctx.db.execute(sql`
      INSERT INTO client_tag_assignments (user_id, tag_id) VALUES (${hiddenPartner}, ${tag[0].id})`);
    // A REBATE the hidden partner produced, paid to the in-scope client: the
    // row is visible (the beneficiary is in territory), the partner masked.
    await ctx.db.execute(sql`
      INSERT INTO ib_accruals
        (ib_user_id, client_user_id, source_type, source_id, depth, rate_value,
         base_amount, amount, currency, status, kind)
      VALUES
        (${hiddenPartner}, ${inScopeClientId}, 'transaction', gen_random_uuid(), 1, '10.0000',
         '100.00000000', '10.00000000', 'USD', 'confirmed', 'rebate')`);

    const visibleRebate = await store.findAccrualsPage({
      page: 1,
      limit: 10,
      scope: outsider,
      kind: 'rebate',
    });
    expect(visibleRebate.total).toBe(1);
    expect(visibleRebate.rows[0].partnerMasked).toBe(true);

    for (const q of ['accrual-hidden-partner@oxshare-e2e.test', 'accrual-hidden']) {
      expect((await store.findAccrualsPage({ page: 1, limit: 10, scope: outsider, q })).total).toBe(
        0,
      );
    }
    const byPartner = await store.findAccrualsPage({
      page: 1,
      limit: 10,
      scope: outsider,
      ibUserId: hiddenPartner,
    });
    expect(byPartner.total).toBe(0);
  });
});
