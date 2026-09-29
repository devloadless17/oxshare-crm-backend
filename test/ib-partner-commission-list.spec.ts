import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { IbOverviewService } from '../src/modules/ib/ib-overview.service';
import type { CommissionService } from '../src/modules/ib/commission.service';
import type { IbWalletService } from '../src/modules/ib/ib-wallet.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * A partner's Commissions list (`GET /ib/commissions`) shows THEIR commission
 * and nothing else.
 *
 * Every closed trade writes two rows naming the introducing partner: the
 * partner's commission, and the client's rebate — which carries the partner in
 * `ib_user_id` only because the partner's rung priced it. The list used to
 * return both, so a partner saw each trade twice under "Your share" and a
 * client's rebate counted in the partner's totals. A partner who reported four
 * trades as eight rows is why this exists.
 */
let ctx: MoneyTestContext;
let overview: IbOverviewService;
let partnerId: number;
let clientId: number;

async function user(email: string, first: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', ${first}, 'Test')
    RETURNING id
  `);
  return rows[0].id;
}

/** The two rows one closed lot writes: 70% of $10 to the partner, 70% of $3 to the client. */
async function closedTrade(): Promise<void> {
  const dealId = randomUUID();
  await ctx.db.execute(sql`
    INSERT INTO ib_accruals (ib_user_id, client_user_id, source_type, source_id, depth,
                             rate_value, base_amount, amount, currency, kind)
    VALUES (${partnerId}, ${clientId}, 'deal', ${dealId}, 1,
            '70.0000', '10.00000000', '7.00000000', 'USD', 'commission'),
           (${partnerId}, ${clientId}, 'deal', ${dealId}, 1,
            '70.0000', '3.00000000', '2.10000000', 'USD', 'rebate')
  `);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  overview = new IbOverviewService(
    ctx.db,
    {} as unknown as CommissionService,
    {} as unknown as IbWalletService,
  );
  partnerId = await user('commission-list-partner@oxshare-e2e.test', 'Ali');
  clientId = await user('commission-list-client@oxshare-e2e.test', 'Client');
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe("a partner's commission list", () => {
  it('lists one row per trade — the commission — and never the client’s rebate', async () => {
    await closedTrade();
    await closedTrade();

    const rows = await overview.commissionsFor(partnerId);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.amount)).toEqual(['7.00000000', '7.00000000']);
    expect(rows.every((row) => row.source === 'deal')).toBe(true);
    expect(rows[0]?.clientName).toBe('Client Test');
  });
});
