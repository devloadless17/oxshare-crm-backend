import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Mt5DealsService } from '../src/modules/trading/mt5/mt5-deals.service';
import type { Mt5DealDto } from '../src/modules/trading/mt5/dto/mt5-deal.dto';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Many deals in one round trip — the delivery shape that survives a busy day.
 *
 * ## What this is for
 *
 * Deals arrived one HTTP request at a time, delivered sequentially by the
 * bridge's outbox: roughly fifty a second once the round trip is counted. A
 * hundred thousand deals — a volatile hour, a backfill, a bridge offline over a
 * weekend — takes over half an hour to hand over, and until it does, the CRM's
 * idea of what has been traded is behind. Commission waits on that, and so does
 * every screen that reads from it.
 *
 * ## Why batching is SAFE here, which is the part worth testing
 *
 * The bridge's own notes rejected a batch endpoint once, on the grounds that a
 * failed batch either re-delivers deals the CRM already has or forces the bridge
 * to track per-item outcomes. Both halves of that turn out to be fine, and these
 * cases are why:
 *
 *   - re-delivering is FREE, because ingestion is idempotent on the MT5 ticket;
 *   - per-item outcomes come back in the response, so the outbox still retires
 *     entries individually rather than all-or-nothing.
 *
 * Against real Postgres, because every guarantee here is a constraint: the
 * unique index on the ticket, and what `onConflictDoNothing` returns.
 */

let ctx: MoneyTestContext;
let service: Mt5DealsService;

const LINKED = '800100';
const UNLINKED = '800999';

function deal(over: Partial<Mt5DealDto> = {}): Mt5DealDto {
  return {
    dealId: '900001',
    login: LINKED,
    symbol: 'EURUSD',
    action: 0,
    entry: 1,
    volume: '1.00000000',
    price: '1.08542000',
    profit: '10.00000000',
    commission: '-2.00000000',
    swap: '0',
    dealtAt: new Date().toISOString(),
    ...over,
  };
}

async function storedCount(): Promise<number> {
  const { rows } = await ctx.db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM mt5_deals`,
  );
  return Number(rows[0].n);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  service = new Mt5DealsService();

  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES ('batch@oxshare-e2e.test', 'x', 'Batch', 'Client')
    RETURNING id
  `);
  await ctx.db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, environment, currency, balance, status)
    VALUES (${rows[0].id}, ${LINKED}, 'live', 'USD', '0', 'active')
  `);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM mt5_deals`);
});

describe('ingesting a batch', () => {
  it('stores every new deal and reports one result per ticket', async () => {
    const { results } = await service.ingestBatch(
      [deal({ dealId: '1' }), deal({ dealId: '2' }), deal({ dealId: '3' })],
      'sweep',
    );

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ingested)).toBe(true);
    expect(await storedCount()).toBe(3);
  });

  it('is IDEMPOTENT — a re-delivered ticket is reported, not refused', async () => {
    /*
     * The property that makes batching safe at all. The bridge retries a failed
     * batch whole, so it necessarily re-sends deals the CRM already holds; if
     * that were an error, every retry would poison itself.
     */
    await service.ingestBatch([deal({ dealId: '1' }), deal({ dealId: '2' })], 'sweep');

    const { results } = await service.ingestBatch(
      [deal({ dealId: '2' }), deal({ dealId: '3' })],
      'sweep',
    );

    expect(results.find((r) => r.dealId === '2')?.ingested).toBe(false);
    expect(results.find((r) => r.dealId === '3')?.ingested).toBe(true);
    // Three distinct tickets, not four rows.
    expect(await storedCount()).toBe(3);
  });

  it('collapses a ticket repeated INSIDE one payload', async () => {
    /*
     * Not a defensive nicety — an ordinary input. The sweep re-reads a rolling
     * window and the outbox can hold the same ticket from both the push and the
     * sweep, so one batch legitimately carries it twice. Postgres raises on the
     * second conflicting row of a single statement, so this must be collapsed
     * before the insert rather than caught after it.
     */
    const { results } = await service.ingestBatch(
      [deal({ dealId: '7' }), deal({ dealId: '7' }), deal({ dealId: '8' })],
      'sweep',
    );

    expect(results).toHaveLength(2);
    expect(await storedCount()).toBe(2);
  });

  it('STORES a deal whose login matches no account, and says so', async () => {
    /*
     * Identical to the single-deal rule, deliberately. An unknown login is
     * normal — the broker's server carries accounts this CRM did not open — and
     * refusing would lose a financial event. It is stored and accrues the moment
     * somebody links the account.
     */
    const { results } = await service.ingestBatch(
      [deal({ dealId: '10', login: UNLINKED }), deal({ dealId: '11' })],
      'sweep',
    );

    expect(results.find((r) => r.dealId === '10')).toMatchObject({
      ingested: true,
      orphaned: true,
    });
    expect(results.find((r) => r.dealId === '11')?.orphaned).toBe(false);
    expect(await storedCount()).toBe(2);
  });

  it('an empty batch is a no-op, not an error', async () => {
    // The outbox can legitimately find nothing due between polls.
    await expect(service.ingestBatch([], 'sweep')).resolves.toEqual({ results: [] });
  });

  it('handles a full-size batch in one statement', async () => {
    /*
     * The point of the endpoint. 500 deals is one INSERT and one indexed lookup
     * — against 500 HTTP round trips and 1,000 queries on the old path.
     */
    const many = Array.from({ length: 500 }, (_, i) => deal({ dealId: `b${i}` }));

    const { results } = await service.ingestBatch(many, 'sweep');

    expect(results).toHaveLength(500);
    expect(results.every((r) => r.ingested)).toBe(true);
    expect(await storedCount()).toBe(500);
  });
});
