import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { Mt5AccountSyncService } from '../src/modules/trading/mt5/mt5-account-sync.service';
import { tradingAccounts, users } from '../src/database/schema';
import type { Mt5AccountSnapshotDto } from '../src/modules/trading/mt5/dto/mt5-account-snapshot.dto';

/**
 * The balance mirror's ingest, against a REAL Postgres.
 *
 * ## Why this suite exists at all
 *
 * The whole guarantee lives in one WHERE clause. `ingestSnapshot` applies a
 * snapshot only when it was READ more recently than whatever produced the value
 * already stored — and that is the kind of condition which reads as obviously
 * correct and is trivially wrong in a way nothing else would catch. If it
 * inverted, a balance would silently go backwards minutes after a transfer with
 * every component still reporting success, which is the most expensive shape a
 * bug can have on a trading product.
 *
 * Against a real database rather than a mock, for the reason ARCHITECTURE §11
 * gives about money paths: the guard is expressed in SQL, so a fake `update()`
 * would be asserting that this file's own idea of the comparison matches itself.
 */

let ctx: MoneyTestContext;
let service: Mt5AccountSyncService;

/** The account every case below writes to. */
const LOGIN = '00012345';

/** A second account, so a snapshot cannot be seen to hit the wrong row. */
const OTHER_LOGIN = '00099999';

const EARLIER = new Date('2026-08-20T12:00:00.000Z');
const LATER = new Date('2026-08-20T12:05:00.000Z');

function snapshot(over: Partial<Mt5AccountSnapshotDto> = {}): Mt5AccountSnapshotDto {
  return {
    login: LOGIN,
    balance: '1000.00000000',
    readAt: LATER.toISOString(),
    ...over,
  };
}

/** The stored row, read back as the database actually holds it. */
async function stored(login = LOGIN) {
  const [row] = await ctx.db
    .select({
      balance: tradingAccounts.balance,
      balanceSyncedAt: tradingAccounts.balanceSyncedAt,
      mt5Group: tradingAccounts.mt5Group,
      leverage: tradingAccounts.leverage,
      credit: tradingAccounts.credit,
    })
    .from(tradingAccounts)
    .where(eq(tradingAccounts.login, login))
    .limit(1);

  return row;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  service = new Mt5AccountSyncService(ctx.db);

  // USD is not inserted here: the migrations seed the currency table, and
  // `trading_accounts.currency` references it. Adding one would collide on the
  // primary key — which is itself a useful reminder that this suite runs the
  // real committed migrations rather than a synthesised schema.

  const [client] = await ctx.db
    .insert(users)
    .values({
      email: 'sync@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Dana',
      lastName: 'Haddad',
    })
    .returning();

  await ctx.db.insert(tradingAccounts).values([
    {
      userId: client.id,
      login: LOGIN,
      environment: 'live',
      currency: 'USD',
      balance: '0',
      status: 'active',
    },
    {
      userId: client.id,
      login: OTHER_LOGIN,
      environment: 'demo',
      currency: 'USD',
      balance: '500.00000000',
      status: 'active',
    },
  ]);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('ingesting a pushed snapshot', () => {
  it('applies the first snapshot, where nothing has ever been confirmed', async () => {
    /*
     * `balance_synced_at` starts NULL, meaning MT5 has never confirmed this
     * figure. Every comparison against a timestamp answers false for NULL, so
     * without the explicit IS NULL branch the FIRST snapshot for every account
     * in the estate would be rejected — and the mirror would never start.
     */
    const before = await stored();
    expect(before.balanceSyncedAt).toBeNull();

    const result = await service.ingestSnapshot(snapshot({ readAt: EARLIER.toISOString() }));

    expect(result.applied).toBe(true);
    const after = await stored();
    expect(after.balance).toBe('1000.00000000');
    expect(after.balanceSyncedAt).toEqual(EARLIER);
  });

  it('applies a snapshot read AFTER the one already stored', async () => {
    const result = await service.ingestSnapshot(
      snapshot({ balance: '1750.00000000', readAt: LATER.toISOString() }),
    );

    expect(result.applied).toBe(true);
    expect((await stored()).balance).toBe('1750.00000000');
  });

  it('REFUSES a snapshot read before the one already stored', async () => {
    /*
     * The case the guard exists for. Delivery is best-effort and forward-only,
     * but a snapshot delayed in flight can still arrive after a newer one has
     * landed — and applying it would walk the balance backwards.
     */
    const result = await service.ingestSnapshot(
      snapshot({ balance: '1.00000000', readAt: EARLIER.toISOString() }),
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('stale');
    expect((await stored()).balance).toBe('1750.00000000');
    expect((await stored()).balanceSyncedAt).toEqual(LATER);
  });

  it('REFUSES a re-delivery of the snapshot already applied', async () => {
    // Equal read times, not just earlier ones: `lt` rather than `lte` is what
    // makes a duplicate a no-op instead of a pointless write.
    const result = await service.ingestSnapshot(
      snapshot({ balance: '9999.00000000', readAt: LATER.toISOString() }),
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('stale');
    expect((await stored()).balance).toBe('1750.00000000');
  });

  it('reports an unknown login without touching anything', async () => {
    /*
     * Normal, and must never be an error: the bridge sweeps every account on the
     * broker's server, including ones opened in the manager terminal that this
     * CRM has never heard of. A 4xx would make the bridge retry them forever.
     */
    const result = await service.ingestSnapshot(snapshot({ login: '00000001' }));

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('unknown-login');
  });

  it('writes only the account it names', async () => {
    // The guard is on `balance_synced_at`, and a WHERE clause that lost its
    // login predicate would still satisfy every assertion above.
    expect((await stored(OTHER_LOGIN)).balance).toBe('500.00000000');
    expect((await stored(OTHER_LOGIN)).balanceSyncedAt).toBeNull();
  });

  /*
   * LAST in this describe, deliberately: the cases above share one row and read
   * each other's state, so a test that advances the balance has to run after
   * them or it moves the ground under the assertions that follow.
   */
  it('mirrors the CREDIT, which is discrete like the balance', async () => {
    /*
     * Credit moves on a dealer action, not on a tick — which is the whole test
     * for whether a figure belongs in this table. It was already arriving on
     * every snapshot and being discarded, so showing a client's tradeable
     * position on a LIST meant one live MT5 call per row: the exact read this
     * mirror exists to avoid.
     *
     * It is stored BESIDE the balance and never summed into it. Credit is not
     * the client's money to withdraw.
     */
    const result = await service.ingestSnapshot(
      snapshot({
        balance: '2400.00000000',
        credit: '250.00000000',
        readAt: new Date(LATER.getTime() + 60_000).toISOString(),
      }),
    );

    expect(result.applied).toBe(true);
    const after = await stored();
    expect(after.credit).toBe('250.00000000');
    // Untouched by the credit — the two are separate figures.
    expect(after.balance).toBe('2400.00000000');
  });

  it('mirrors the GROUP and LEVERAGE, not only the balance', async () => {
    /*
     * The bridge sends both on every snapshot and this DTO has always documented
     * them — and they were written only at account CREATION and never again. A
     * broker moving an account to a different group, or changing its leverage in
     * the manager terminal, was invisible here for ever: the console kept
     * rendering the value from the day the account was opened, with nothing to
     * mark it as old. The same failure the balance mirror exists to end, on the
     * two fields sitting beside it.
     */
    const result = await service.ingestSnapshot(
      snapshot({
        balance: '2100.00000000',
        readAt: new Date(LATER.getTime() + 120_000).toISOString(),
        group: 'real\\VIP',
        leverage: 200,
      }),
    );

    expect(result.applied).toBe(true);
    const after = await stored();
    expect(after.balance).toBe('2100.00000000');
    expect(after.mt5Group).toBe('real\\VIP');
    expect(after.leverage).toBe(200);
  });

  it('an OMITTED group does not blank the one already known', async () => {
    /*
     * Absent means "no news", not "no group". Both fields are optional on the
     * wire, so a read that did not ask for them must leave what is stored alone
     * — writing null over a known group because this particular snapshot was
     * silent is worse than the staleness it replaces.
     */
    expect((await stored()).mt5Group).toBe('real\\VIP');

    await service.ingestSnapshot(
      snapshot({
        balance: '2200.00000000',
        readAt: new Date(LATER.getTime() + 180_000).toISOString(),
      }),
    );

    const after = await stored();
    expect(after.balance).toBe('2200.00000000');
    expect(after.mt5Group).toBe('real\\VIP');
    expect(after.leverage).toBe(200);
  });
});

describe('recording what a CRM-initiated operation left behind', () => {
  it('applies a fresher balance from the operation response', async () => {
    const afterOperation = new Date('2026-08-20T12:10:00.000Z');
    await service.recordFromOperation(LOGIN, '2000.00000000', afterOperation);

    const row = await stored();
    expect(row.balance).toBe('2000.00000000');
    expect(row.balanceSyncedAt).toEqual(afterOperation);
  });

  it('is guarded too, so a late sweep cannot undo a transfer just made', async () => {
    /*
     * The ordering that makes this matter: a transfer completes at 12:10 and
     * writes MT5's answer, while a sweep round that read at 12:05 is still being
     * delivered. Without the same guard on both writers, the client watches
     * their deposit disappear a few seconds after it arrived.
     */
    const result = await service.ingestSnapshot(
      snapshot({ balance: '1750.00000000', readAt: LATER.toISOString() }),
    );

    expect(result.applied).toBe(false);
    expect((await stored()).balance).toBe('2000.00000000');
  });
});

describe('the login set the bridge reconciles against', () => {
  it('lists every login the CRM holds, ascending', async () => {
    /*
     * The bridge used to enumerate the broker's WHOLE BOOK every balance round
     * — one call per group returning every account on the server — to reconcile
     * the handful the CRM owns. Its own log said so: `unknown-login; ignored`
     * lines are snapshots read from MT5, pushed over HTTP, and discarded after
     * two queries.
     *
     * The CRM is the only component that knows which logins matter, so it says.
     */
    const { logins } = await service.knownLogins();

    expect(logins).toContain(LOGIN);
    expect(logins).toContain(OTHER_LOGIN);

    // Ordered, so the bridge's watermark walks a stable sequence rather than
    // whatever order Postgres felt like returning.
    expect([...logins].sort()).toEqual(logins);
  });

  it('omits accounts with no MT5 login yet', async () => {
    /*
     * An account created in the CRM but not yet opened on MT5 has nothing to
     * reconcile, and a null in this list would become a login the bridge tries
     * to read.
     */
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES ('nologin@oxshare-e2e.test', 'x', 'No', 'Login')
      RETURNING id
    `);
    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, login, environment, currency, balance, status)
      VALUES (${rows[0].id}, NULL, 'live', 'USD', '0', 'active')
    `);

    const { logins } = await service.knownLogins();

    expect(logins.every((login) => typeof login === 'string' && login.length > 0)).toBe(true);
  });
});
