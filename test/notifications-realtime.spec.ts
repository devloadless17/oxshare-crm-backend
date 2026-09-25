import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { NotificationsStore } from '../src/store/notifications.store';
import type { NotificationEvent } from '../src/modules/notifications/realtime.gateway';

/**
 * Real-time delivery, against real Postgres — because the guarantee this
 * feature rests on is a property of the DATABASE, not of any code here.
 *
 * The claim in migration 0047 is that `pg_notify` fires when the transaction
 * COMMITS and is discarded on rollback. Everything else in the design follows
 * from that: it is why a withdrawal approval can announce itself from inside
 * the money transaction without ever telling a client about a decision that
 * was rolled back a moment later. A mock cannot hold that claim up.
 */

let ctx: MoneyTestContext;
let store: NotificationsStore;
let listener: Client;
/** Every `notification_created` payload the database has announced, in order. */
let heard: NotificationEvent[];
/** Every `notification_changed` payload — a row read or resolved (0140). */
let changed: { recipientKind: string; recipientId: string }[];

const CLIENT_A = { kind: 'client' as const, id: '11111111-1111-1111-1111-111111111111' };
const CLIENT_B = { kind: 'client' as const, id: '22222222-2222-2222-2222-222222222222' };
const ADMIN_1 = 'a1111111-1111-4111-8111-111111111111';
const ADMIN_2 = 'a2222222-2222-4222-8222-222222222222';
const ADMIN_3 = 'a3333333-3333-4333-8333-333333333333';

/** A client whose KYC waits for review — a real item for a task to be about. */
async function kycSubject(email: string): Promise<{ userId: string; portalId: number }> {
  const { rows } = await ctx.db.execute<{ id: string; portal_id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Realtime', 'Subject') RETURNING id, portal_id`);
  await ctx.db.execute(
    sql`INSERT INTO kyc_submissions (user_id, status) VALUES (${rows[0].id}, 'submitted')`,
  );
  return { userId: rows[0].id, portalId: rows[0].portal_id };
}

function kycTask(userId: string) {
  return {
    kind: 'admin.kyc.submitted',
    params: { userId },
    subjectKind: 'kyc' as const,
    subjectId: userId,
    subjectUserId: userId,
    stillOpen: 'awaiting-review' as const,
  };
}

/** Wait for the listener to hear something, or give up. */
async function waitForEvents(count: number, timeoutMs = 5_000): Promise<NotificationEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (heard.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [...heard];
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new NotificationsStore(ctx.db);

  /*
   * A dedicated client on the suite's OWN database, built the way
   * `money-setup.ts` builds it: each suite gets a fresh database inside the
   * shared container, and `TEST_PG_URI` points at the container's admin
   * connection rather than at that database.
   */
  const uri = new URL(process.env['TEST_PG_URI'] as string);
  uri.pathname = `/${ctx.databaseName}`;
  listener = new Client({ connectionString: uri.toString() });
  await listener.connect();
  await listener.query('LISTEN notification_created');
  await listener.query('LISTEN notification_changed');

  heard = [];
  changed = [];
  listener.on('notification', (message) => {
    if (!message.payload) return;
    if (message.channel === 'notification_changed') {
      changed.push(JSON.parse(message.payload) as { recipientKind: string; recipientId: string });
      return;
    }
    heard.push(JSON.parse(message.payload) as NotificationEvent);
  });
}, 120_000);

afterAll(async () => {
  await listener?.end().catch(() => undefined);
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('the database announces a notification when it becomes real', () => {
  it('fires on a committed insert, carrying who it is for', async () => {
    heard = [];
    await store.insert({
      recipient: CLIENT_A,
      kind: 'withdrawal.approved',
      params: { amount: '10.00000000' },
    });

    const [event] = await waitForEvents(1);
    expect(event, 'no event was announced for a committed insert').toBeDefined();
    expect(event.recipientKind).toBe('client');
    expect(event.recipientId).toBe(CLIENT_A.id);
    expect(event.kind).toBe('withdrawal.approved');
    expect(event.id).toBeTruthy();
  });

  it('carries the params a toast interpolates', async () => {
    /*
     * REVERSED from 0047, by migration 0061, and the reason is on the wire's
     * own terms rather than a relaxation of it.
     *
     * 0047 sent routing fields only and argued the reader should refetch. That
     * was right for a bell badge and is not enough for a toast: with `{id,
     * kind}` alone the browser can render a title from its kind catalogue but
     * not a single number, so every toast would be generic or would arrive
     * visibly after the event it announces.
     *
     * The privacy objection still holds and is still satisfied: the gateway
     * emits into `<kind>:<id>`, the room holding exactly the sockets of the
     * principal this row names, so `params` reaches the one reader the
     * permission-checked endpoint would have served it to.
     */
    heard = [];
    await store.insert({
      recipient: CLIENT_A,
      kind: 'withdrawal.rejected',
      params: { reason: 'Destination account name does not match', amount: '250.00000000' },
    });

    const [event] = await waitForEvents(1);
    expect(event.params).toMatchObject({
      reason: 'Destination account name does not match',
      amount: '250.00000000',
    });
    expect(Object.keys(event).sort()).toEqual([
      'id',
      'kind',
      'params',
      'recipientId',
      'recipientKind',
    ]);
  });

  it('drops params rather than failing when they would burst the NOTIFY limit', async () => {
    /*
     * ⚠️ The failure this guards is not a missing toast — it is a rolled-back
     * WITHDRAWAL.
     *
     * `pg_notify` refuses a payload over 8000 bytes, and the trigger runs
     * inside the caller's transaction. A rejection reason long enough to burst
     * it would raise 22023 from the trigger and abort the money movement the
     * notification was announcing.
     *
     * So 0061 builds the payload twice and falls back to 0047's slim form. An
     * over-long reason degrades to the generic toast — which both frontends
     * already render, because it is what they must do for an unknown `kind`
     * anyway — instead of taking the transaction down with it.
     */
    heard = [];
    await store.insert({
      recipient: CLIENT_A,
      kind: 'withdrawal.rejected',
      // Past the 6000-byte budget the trigger allows params, well under the
      // column's own limit — the row must still be written.
      params: { reason: 'x'.repeat(7000) },
    });

    const [event] = await waitForEvents(1);
    expect(event, 'the insert must still announce, without params').toBeDefined();
    expect(event.params).toBeUndefined();
    expect(Object.keys(event).sort()).toEqual(['id', 'kind', 'recipientId', 'recipientKind']);
  });

  it('says NOTHING when the surrounding transaction rolls back', async () => {
    /*
     * The property the whole design rests on.
     *
     * The in-transaction notify writes the bell row inside somebody's money
     * transaction. If the announcement escaped before the commit, a rolled-back
     * withdrawal approval would push "your withdrawal was approved" to a client
     * whose withdrawal is still pending — the UI contradicting the ledger,
     * which is the worst failure this feature could have.
     */
    heard = [];
    await ctx.db
      .transaction(async (tx) => {
        await store.insert({ recipient: CLIENT_B, kind: 'deposit.succeeded', params: {} }, tx);
        throw new Error('the money transaction failed after the notify');
      })
      .catch(() => undefined);

    // Long enough that a leaked announcement would have arrived.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(heard, 'a rolled-back insert announced itself').toEqual([]);
  });

  it('announces every admin a task fans out to, one event each, with its Portal ID', async () => {
    const { userId, portalId } = await kycSubject('rt-fanout@oxshare-e2e.test');
    heard = [];
    await store.insertAdminTask([ADMIN_1, ADMIN_2], kycTask(userId));

    const events = await waitForEvents(2);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.recipientId).sort()).toEqual([ADMIN_1, ADMIN_2].sort());
    // The toast can say "#1000245" the instant the task lands — and only that:
    // a name is masked per reader, which only the HTTP read can do.
    expect(events.every((e) => e.subjectPortalId === portalId)).toBe(true);
  });

  it('stays silent for a replay the dedupe index absorbed', async () => {
    const event = { kind: 'commission.confirmed', params: {}, dedupeKey: `replay-${Date.now()}` };
    heard = [];
    await store.insert({ recipient: CLIENT_A, ...event });

    /*
     * Wait for the FIRST announcement before clearing.
     *
     * `pg_notify` is delivered asynchronously after the commit returns, so
     * clearing immediately after the insert races it: the first event lands in
     * the cleared buffer and reads as the replay having announced itself. The
     * test would then fail against a trigger that is behaving perfectly.
     */
    await waitForEvents(1);
    heard = [];
    await store.insert({ recipient: CLIENT_A, ...event });
    await new Promise((resolve) => setTimeout(resolve, 500));

    // No row was written, so nobody is told. A trigger on INSERT would
    // otherwise turn every at-least-once redelivery into a second buzz.
    expect(heard).toEqual([]);
  });
});

describe('a row read or resolved tells its reader’s open tabs — on commit only (0140)', () => {
  it('announces a RESOLUTION to every recipient, and a rolled-back decision to nobody', async () => {
    const { userId } = await kycSubject('rt-resolve@oxshare-e2e.test');
    await store.insertAdminTask([ADMIN_1, ADMIN_2], kycTask(userId));
    await waitForEvents(2);

    // A decision that rolls back resolved nothing, so it says nothing.
    changed = [];
    await ctx.db
      .transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE kyc_submissions SET status = 'approved' WHERE user_id = ${userId}`,
        );
        throw new Error('the approval failed after the status moved');
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(changed, 'a rolled-back resolution announced itself').toEqual([]);

    // The real one: both admins' tabs are told, once each.
    await ctx.db.execute(
      sql`UPDATE kyc_submissions SET status = 'approved' WHERE user_id = ${userId}`,
    );
    const deadline = Date.now() + 5_000;
    while (changed.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(changed.map((c) => c.recipientId).sort()).toEqual([ADMIN_1, ADMIN_2].sort());
  });

  it('folds "mark all as read" on many rows into ONE event for that reader', async () => {
    for (const n of [1, 2, 3]) {
      const { userId } = await kycSubject(`rt-bulk-${n}@oxshare-e2e.test`);
      await store.insertAdminTask([ADMIN_3], kycTask(userId));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    changed = [];
    const updated = await store.markAllAdminRead({
      adminId: ADMIN_3,
      kinds: ['admin.kyc.submitted'],
      scope: UNRESTRICTED,
    });
    expect(updated).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(changed).toEqual([{ recipientKind: 'admin', recipientId: ADMIN_3 }]);
  });
});
