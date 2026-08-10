import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { firstValueFrom, take, toArray } from 'rxjs';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { NotificationsStore } from '../src/store/notifications.store';
import {
  NotificationsRealtimeGateway,
  type NotificationEvent,
} from '../src/modules/notifications/realtime.gateway';
import { notificationStream } from '../src/modules/notifications/notification-stream';

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
/** Every payload the database has announced, in order. */
let heard: NotificationEvent[];

const CLIENT_A = { kind: 'client' as const, id: '11111111-1111-1111-1111-111111111111' };
const CLIENT_B = { kind: 'client' as const, id: '22222222-2222-2222-2222-222222222222' };

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

  heard = [];
  listener.on('notification', (message) => {
    if (message.payload) heard.push(JSON.parse(message.payload) as NotificationEvent);
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

  it('carries NO notification body — only what a listener needs to route it', async () => {
    heard = [];
    await store.insert({
      recipient: CLIENT_A,
      kind: 'withdrawal.rejected',
      // A rejection reason is arbitrary-length free text and must not ride the
      // 8000-byte NOTIFY channel — nor travel outside a permission-checked
      // read. The reader refetches the feed instead.
      params: { reason: 'A very long operator explanation that has no business on the wire' },
    });

    const [event] = await waitForEvents(1);
    expect(JSON.stringify(event)).not.toContain('operator explanation');
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

  it('announces every recipient of a fan-out, one event each', async () => {
    heard = [];
    await store.insertMany([CLIENT_A, CLIENT_B], {
      kind: 'admin.withdrawal.requested',
      params: {},
      dedupeKey: `fanout-${Date.now()}`,
    });

    const events = await waitForEvents(2);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.recipientId).sort()).toEqual([CLIENT_A.id, CLIENT_B.id].sort());
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

describe('the gateway routes an announcement to the right connection', () => {
  it('delivers only the events addressed to that recipient', async () => {
    const gateway = new NotificationsRealtimeGateway({
      get: () => 'test',
    } as never);

    const received = firstValueFrom(gateway.streamFor(CLIENT_A).pipe(take(1), toArray()));

    // B's event must not reach A's stream, whatever order they arrive in.
    gateway.publish({ id: 'n-b', recipientKind: 'client', recipientId: CLIENT_B.id, kind: 'x' });
    gateway.publish({ id: 'n-a', recipientKind: 'client', recipientId: CLIENT_A.id, kind: 'y' });

    expect((await received).map((e) => e.id)).toEqual(['n-a']);
  });

  it('does not cross the two audiences, even on a shared uuid', async () => {
    /*
     * An admin id and a client id are drawn from different tables and could
     * coincide. The pair must match on BOTH columns — the same ownership rule
     * the store's WHERE clause enforces, asserted here because the stream
     * bypasses that query entirely.
     */
    const gateway = new NotificationsRealtimeGateway({ get: () => 'test' } as never);
    const sharedId = CLIENT_A.id;

    const received = firstValueFrom(
      gateway.streamFor({ kind: 'admin', id: sharedId }).pipe(take(1), toArray()),
    );

    gateway.publish({
      id: 'for-client',
      recipientKind: 'client',
      recipientId: sharedId,
      kind: 'x',
    });
    gateway.publish({ id: 'for-admin', recipientKind: 'admin', recipientId: sharedId, kind: 'y' });

    expect((await received).map((e) => e.id)).toEqual(['for-admin']);
  });
});

describe('the SSE frame shape', () => {
  it('opens with a ping, so the browser knows the stream is live before any event', async () => {
    const gateway = new NotificationsRealtimeGateway({ get: () => 'test' } as never);
    const frames = firstValueFrom(
      notificationStream(gateway.streamFor(CLIENT_A), CLIENT_A).pipe(take(1), toArray()),
    );

    expect((await frames)[0].type).toBe('ping');
  });

  it('sends the id and kind, never the params', async () => {
    const gateway = new NotificationsRealtimeGateway({ get: () => 'test' } as never);
    const frames = firstValueFrom(
      notificationStream(gateway.streamFor(CLIENT_A), CLIENT_A).pipe(take(2), toArray()),
    );

    gateway.publish({
      id: 'n-1',
      recipientKind: 'client',
      recipientId: CLIENT_A.id,
      kind: 'kyc.approved',
    });

    const notification = (await frames).find((f) => f.type === 'notification');
    expect(notification?.data).toEqual({
      id: 'n-1',
      kind: 'kyc.approved',
      at: expect.any(String),
    });
  });
});
