import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { NotificationsStore } from '../src/store/notifications.store';
import {
  NOTIFICATION_EVENT,
  NotificationsRealtimeGateway,
} from '../src/modules/notifications/realtime.gateway';
import type { RealtimePrincipalResolver } from '../src/modules/notifications/realtime.principal';

/**
 * The gateway's OWN listener, wired to a real database.
 *
 * `notifications-realtime.spec.ts` proves Postgres announces committed rows.
 * `realtime-gateway.spec.ts` proves the gateway routes an event to one room.
 * Neither proves the join between them — that this process actually subscribes,
 * parses what arrives, and survives the channel going away.
 *
 * That join is worth its own file because of HOW it fails. A dropped LISTEN
 * breaks nothing visible: every socket stays open, the page looks connected,
 * and it silently never updates again. There is no error for anyone to notice,
 * which makes it the one part of this system that cannot be left to be caught
 * in production.
 */

let ctx: MoneyTestContext;
let store: NotificationsStore;
let gateways: NotificationsRealtimeGateway[] = [];

const RECIPIENT = { kind: 'client' as const, id: 1000003 };

function databaseUrl(): string {
  const uri = new URL(process.env['TEST_PG_URI'] as string);
  uri.pathname = `/${ctx.databaseName}`;
  return uri.toString();
}

/**
 * A gateway pointed at the suite's database, with the socket server replaced by
 * a recorder.
 *
 * `NODE_ENV` is reported as `development` on purpose: `onModuleInit` skips
 * listening under `test` so ordinary suites do not each hold a connection open
 * against a container about to be torn down. This file is the one that wants
 * the real thing.
 */
function buildGateway(overrides: Record<string, string | undefined> = {}) {
  const config = {
    get: (key: string) =>
      key in overrides
        ? overrides[key]
        : key === 'NODE_ENV'
          ? 'development'
          : key === 'DATABASE_URL'
            ? databaseUrl()
            : undefined,
  };

  const gateway = new NotificationsRealtimeGateway(
    config as never,
    {} as unknown as RealtimePrincipalResolver,
  );

  const emitted: { room: string; payload: unknown }[] = [];
  (gateway as unknown as { server: unknown }).server = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        if (event === NOTIFICATION_EVENT) emitted.push({ room, payload });
      },
    }),
  };

  gateways.push(gateway);
  return { gateway, emitted };
}

async function waitFor<T>(get: () => T[], count: number, timeoutMs = 5_000): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  while (get().length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [...get()];
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new NotificationsStore(ctx.db);
}, 120_000);

afterEach(async () => {
  for (const gateway of gateways) await gateway.onModuleDestroy();
  gateways = [];
});

afterAll(async () => {
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('the gateway subscribes to the database', () => {
  it('emits into the recipient’s room when a row is committed', async () => {
    const { gateway, emitted } = buildGateway();
    await gateway.onModuleInit();

    await store.insert({
      recipient: RECIPIENT,
      kind: 'wallet.credited',
      params: { amount: '10.00000000', currency: 'USD' },
    });

    const [event] = await waitFor(() => emitted, 1);
    expect(event?.room).toBe(`client:${RECIPIENT.id}`);
    expect(event?.payload).toMatchObject({ kind: 'wallet.credited' });
  });

  it('keeps listening after a payload it cannot parse', async () => {
    /*
     * A malformed payload means the TRIGGER is wrong — a real bug, but one that
     * must not cost every other event. If a parse error tore the listener down,
     * one bad row would silence the whole feature until a restart.
     */
    const { gateway, emitted } = buildGateway();
    await gateway.onModuleInit();

    const intruder = new Client({ connectionString: databaseUrl() });
    await intruder.connect();
    await intruder.query(`NOTIFY notification_created, 'this is not json'`);
    await intruder.end();

    await store.insert({
      recipient: RECIPIENT,
      kind: 'kyc.approved',
      params: {},
    });

    const [event] = await waitFor(() => emitted, 1);
    expect(event?.payload).toMatchObject({ kind: 'kyc.approved' });
  });

  it('starts without a database rather than refusing to boot', async () => {
    /*
     * No DATABASE_URL is a misconfiguration, not a reason for the API to die.
     * The bell still works — both frontends keep a slow poll underneath the
     * socket for exactly this case — so this warns and carries on.
     */
    const { gateway } = buildGateway({ DATABASE_URL: undefined });

    await expect(gateway.onModuleInit()).resolves.toBeUndefined();
  });

  it('does not listen at all under NODE_ENV=test', async () => {
    // The guard that keeps every other suite from holding a connection open
    // against a container it is about to tear down.
    const { gateway, emitted } = buildGateway({ NODE_ENV: 'test' });
    await gateway.onModuleInit();

    await store.insert({
      recipient: RECIPIENT,
      kind: 'deposit.succeeded',
      params: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(emitted).toHaveLength(0);
  });

  it('re-establishes itself when the connection is dropped underneath it', async () => {
    /*
     * The silent failure this whole file exists for.
     *
     * The connection is killed the way a database restart or an idle-connection
     * reaper would kill it — from the server side, with no shutdown from us —
     * and the gateway must be delivering again afterwards without anybody
     * restarting the process.
     */
    const { gateway, emitted } = buildGateway();
    await gateway.onModuleInit();

    // Prove it works before breaking it, so a failure below is about recovery.
    await store.insert({
      recipient: RECIPIENT,
      kind: 'before.drop',
      params: {},
    });
    await waitFor(() => emitted, 1);

    const executioner = new Client({ connectionString: databaseUrl() });
    await executioner.connect();
    await executioner.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE query = 'LISTEN notification_created' AND pid <> pg_backend_pid()`,
    );
    await executioner.end();

    // The reconnect is on a 2-second timer; give it room on a loaded box.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    await store.insert({
      recipient: RECIPIENT,
      kind: 'after.drop',
      params: {},
    });

    const events = await waitFor(() => emitted, 2, 10_000);
    expect(events.map((e) => (e.payload as { kind: string }).kind)).toContain('after.drop');
  }, 30_000);

  it('SETTLES after an error on a live connection, instead of churning forever', async () => {
    /*
     * Recovering once is not the same as recovering.
     *
     * pg emits `'error'` on a client for backend errors that do NOT close the
     * socket, so a reconnect can be scheduled while the connection is still
     * healthy — and `listen()` failing its `LISTEN` query after a successful
     * connect reaches the same place. Replacing a healthy client means calling
     * `end()` on it, and `end()` on a healthy client emits `'end'` (measured,
     * not assumed). With the old client's handler still attached, that `'end'`
     * scheduled the NEXT reconnect, which two seconds later tore down the
     * healthy connection that had just replaced it: a permanent two-second
     * cycle, with every event landing in a gap silently lost.
     *
     * The kill-based test above cannot see this, and that is not an oversight:
     * `end()` on an ALREADY-DEAD client emits nothing, so the kill path never
     * re-enters. The trigger has to be an error on a LIVE connection.
     *
     * The assertion is a RATE, not an outcome — the churning version still
     * delivers events, just with holes.
     */
    const { gateway, emitted } = buildGateway();
    await gateway.onModuleInit();

    const logger = (gateway as unknown as { logger: { warn: (m: string) => void } }).logger;
    const warn = vi.spyOn(logger, 'warn');
    const reestablished = () => warn.mock.calls.filter(([m]) => /Re-establishing/.test(m)).length;

    // Exactly what pg does for a backend error that leaves the socket usable.
    const live = (gateway as unknown as { listener: Client }).listener;
    live.emit('error', new Error('a backend error that did not close the connection'));

    // One reconnect is correct and expected.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const afterFirst = reestablished();
    expect(afterFirst, 'the listener never rebuilt itself').toBeGreaterThan(0);

    // Three more churn cycles' worth of quiet.
    await new Promise((resolve) => setTimeout(resolve, 7_000));

    expect(reestablished(), 'the listener is rebuilding itself on a loop').toBe(afterFirst);

    // And it is genuinely still listening, not merely quiet.
    emitted.length = 0;
    await store.insert({ recipient: RECIPIENT, kind: 'after.settling', params: {} });
    const events = await waitFor(() => emitted, 1);
    expect(events.map((e) => (e.payload as { kind: string }).kind)).toContain('after.settling');
  }, 45_000);
});
