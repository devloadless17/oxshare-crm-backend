import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/database/db';
import { tradingAccounts, users } from '../src/database/schema';
import { startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';

/**
 * `POST /v1/webhooks/mt5/accounts` over real HTTP, end to end.
 *
 * ## What this proves that the service spec cannot
 *
 * `mt5-account-sync.spec.ts` calls the service directly, so it proves the
 * staleness guard is right and nothing else. Everything between the bridge's
 * socket and that method is untested by it, and every layer in between has
 * refused a real delivery at least once in this codebase's history:
 *
 *   - the global `CsrfGuard`, which rejects Origin-less writes by default and
 *     answered 403 to every bridge POST until `@NoOriginCheck` was added — a
 *     failure the unit tests could not see because they exercised the guard and
 *     the controller separately;
 *   - `BridgeSecretGuard`, which must refuse an absent or wrong secret;
 *   - the global `ValidationPipe`, which decides whether the bridge's payload
 *     shape is even accepted.
 *
 * A webhook that 403s is indistinguishable from one nobody sent. The whole point
 * of the mirror is that the CRM's account list is served from the database rather
 * than from MT5, so if this path is closed the console shows a balance that never
 * moves and reports no error at all — which is why it is asserted here against
 * the database rather than against a 200.
 */

let ctx: HttpTestContext;
let accountId: string;

const LOGIN = '00077001';
const SECRET = 'test-only-bridge-secret-never-used-outside-vitest';
const WEBHOOK = '/v1/webhooks/mt5/accounts';

/** What the bridge's `AccountMirrorPayload` puts on the wire. */
function payload(over: Record<string, unknown> = {}) {
  return {
    login: LOGIN,
    balance: '1750.00000000',
    readAt: '2026-08-20T12:05:00.000Z',
    group: 'real\\Standard',
    leverage: 500,
    ...over,
  };
}

async function storedBalance(login = LOGIN) {
  const [row] = await getDb()
    .select({
      balance: tradingAccounts.balance,
      balanceSyncedAt: tradingAccounts.balanceSyncedAt,
    })
    .from(tradingAccounts)
    .where(eq(tradingAccounts.login, login))
    .limit(1);

  return row;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();

  const [client] = await getDb()
    .insert(users)
    .values({
      email: 'mirror@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Dana',
      lastName: 'Haddad',
    })
    .returning();

  const [account] = await getDb()
    .insert(tradingAccounts)
    .values({
      userId: client.id,
      login: LOGIN,
      environment: 'live',
      currency: 'USD',
      balance: '0',
      status: 'active',
    })
    .returning();

  accountId = account.id;
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the bridge delivering a balance', () => {
  it('writes the balance into the CRM database', async () => {
    // The assertion that matters. A 200 alone would pass even if the handler
    // did nothing at all, which is exactly the failure this endpoint would
    // otherwise present as a working screen showing a frozen number.
    expect((await storedBalance()).balance).toBe('0.00000000');

    const res = await request(ctx.server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-bridge-secret', SECRET)
      .send(payload());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ login: LOGIN, applied: true });

    const row = await storedBalance();
    expect(row.balance).toBe('1750.00000000');
    expect(row.balanceSyncedAt).toEqual(new Date('2026-08-20T12:05:00.000Z'));
  });

  it('is idempotent — the same delivery twice leaves one balance', async () => {
    // The bridge is best-effort and forward-only, but nothing stops a duplicate
    // reaching us; it must be a no-op rather than an error the bridge retries.
    const res = await request(ctx.server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-bridge-secret', SECRET)
      .send(payload({ balance: '9999.00000000' }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: false, reason: 'stale' });
    expect((await storedBalance()).balance).toBe('1750.00000000');
  });

  it('answers 200 for a login the CRM never opened, so the bridge stops retrying', async () => {
    /*
     * The broker's server carries accounts this CRM did not create — other
     * desks, the manager's own, ones opened directly in the terminal. A 4xx here
     * would make the bridge retry each of them on every sweep, forever.
     */
    const res = await request(ctx.server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-bridge-secret', SECRET)
      .send(payload({ login: '00000009' }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: false, reason: 'unknown-login' });
  });
});

describe('the guard in front of it', () => {
  it('refuses a delivery with no bridge secret', async () => {
    const res = await request(ctx.server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .send(payload({ balance: '1.00000000', readAt: '2026-08-20T13:00:00.000Z' }));

    expect(res.status).toBe(401);
    // The balance must be untouched: an unauthenticated caller moving a number
    // on a trading account is the whole reason this guard exists.
    expect((await storedBalance()).balance).toBe('1750.00000000');
  });

  it('refuses a delivery with the wrong bridge secret', async () => {
    const res = await request(ctx.server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-bridge-secret', 'not-the-secret-but-the-same-sort-of-length')
      .send(payload({ balance: '2.00000000', readAt: '2026-08-20T13:00:00.000Z' }));

    expect(res.status).toBe(401);
    expect((await storedBalance()).balance).toBe('1750.00000000');
  });

  it('rejects a balance that is not a decimal string', async () => {
    /*
     * §6.1: money crosses this boundary as a STRING. A number here would have
     * been through a JavaScript double before validation could object, which is
     * the conversion the bridge exists to do exactly once.
     */
    const res = await request(ctx.server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-bridge-secret', SECRET)
      .send(payload({ balance: 'not-a-number', readAt: '2026-08-20T13:00:00.000Z' }));

    expect(res.status).toBe(400);
    expect((await storedBalance()).balance).toBe('1750.00000000');
  });

  it('accepts a NEGATIVE balance, which is a real state', async () => {
    // An account stopped out through zero carries a debit until the broker
    // settles it. Refusing that number would make the one account an operator
    // most needs to see the one the mirror cannot deliver.
    const res = await request(ctx.server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-bridge-secret', SECRET)
      .send(payload({ balance: '-42.50000000', readAt: '2026-08-20T14:00:00.000Z' }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true });
    expect((await storedBalance()).balance).toBe('-42.50000000');
    expect(accountId).toBeTruthy();
  });
});
