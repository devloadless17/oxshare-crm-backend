import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, getDb, resetDb } from '../src/database/db';
import { users } from '../src/database/schema';
import { WalletService } from '../src/modules/wallet/wallet.service';

/**
 * A client must be able to reach every entry in their own ledger.
 *
 * `GET /wallet/ledger` discarded paging and hardcoded `limit: 100`, so a client
 * with more than 100 rows could not reach their older entries by any means. The
 * ledger is append-only and never stops growing, so every funded account crosses
 * that line eventually — and the party with the strongest incentive to spot an
 * error in the ledger was the one who could not look at it.
 *
 * Keyset rather than offset, and here it matters more than on any other list:
 * offset paging over a set being appended to SKIPS rows, and a client checking
 * their own history against their own records must not be shown a page that
 * quietly omits a transaction.
 *
 * Testcontainers, because the guarantee is an index-ordered seek in SQL.
 */

let ctx: MoneyTestContext;
let wallets: WalletService;
let clientId: string;
let otherClientId: string;

const TOTAL = 120; // deliberately past the old hardcoded 100

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  wallets = new WalletService(getDb());

  const [client] = await ctx.db
    .insert(users)
    .values({
      email: 'ledger-paging@test.local',
      passwordHash: 'x',
      firstName: 'Ledger',
      lastName: 'Client',
    })
    .returning();
  const [other] = await ctx.db
    .insert(users)
    .values({
      email: 'ledger-other@test.local',
      passwordHash: 'x',
      firstName: 'Other',
      lastName: 'Client',
    })
    .returning();
  clientId = client.id;
  otherClientId = other.id;

  // Written through the real money path (`post` — lock, insert, update, one
  // transaction) rather than hand-inserted rows: what the client can page
  // through must be what the ledger actually holds.
  for (let i = 0; i < TOTAL; i++) {
    await wallets.post({
      userId: clientId,
      currency: 'USD',
      amount: '1.00000000',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: `paging-${i}`,
    });
  }
  await wallets.post({
    userId: otherClientId,
    currency: 'USD',
    amount: '99.00000000',
    entryType: 'deposit',
    referenceType: 'transaction',
    referenceId: 'other-client-entry',
  });
}, 180_000);

afterAll(async () => {
  await closeDb();
  await stopMoneyTestDb(ctx);
});

describe("a client's own ledger", () => {
  it('reaches every entry past the old 100-row ceiling', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await wallets.listEntries({
        userId: clientId,
        limit: '25',
        cursor: cursor ? decode(cursor) : undefined,
      });
      for (const entry of page.items) seen.add(entry.id);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages, 'walk did not terminate').toBeLessThan(20);
    } while (cursor);

    // 120 > 100. Before this, entries 101..120 were unreachable.
    expect(seen.size).toBe(TOTAL);
  });

  it('never repeats an entry across pages', async () => {
    const ids: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await wallets.listEntries({
        userId: clientId,
        limit: '25',
        cursor: cursor ? decode(cursor) : undefined,
      });
      ids.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    // A duplicate would read to the client as a transaction that happened twice,
    // which on a money screen is worse than a missing one — it invites a support
    // call about money that was never moved.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('honours the limit rather than the old fixed page size', async () => {
    const page = await wallets.listEntries({ userId: clientId, limit: '10' });
    expect(page.items).toHaveLength(10);
  });

  it('clamps an absurd limit instead of serving the whole table', async () => {
    const page = await wallets.listEntries({ userId: clientId, limit: '100000' });
    expect(page.items.length).toBeLessThanOrEqual(100);
  });

  /**
   * The scoping guarantee, asserted at the service so it holds regardless of how
   * the controller is called. `userId` is derived from the session and is not a
   * parameter of the route — it is the only thing between this endpoint and one
   * client reading another's ledger.
   */
  it("never returns another client's entries", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;

    do {
      const page = await wallets.listEntries({
        userId: clientId,
        limit: '50',
        cursor: cursor ? decode(cursor) : undefined,
      });
      for (const entry of page.items) seen.add(entry.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    const theirs = await wallets.listEntries({ userId: otherClientId, limit: '50' });
    expect(theirs.items.length).toBeGreaterThan(0);
    for (const entry of theirs.items) {
      expect(seen.has(entry.id), 'leaked another client entry').toBe(false);
    }
  });
});

/** Local helper so the walk reads the way a caller would actually write it. */
function decode(cursor: string) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    createdAt: string;
    id: string;
  };
}
