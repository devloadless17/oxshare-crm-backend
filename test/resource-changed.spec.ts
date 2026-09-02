import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { lastValueFrom, of, throwError } from 'rxjs';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import {
  RESOURCE_CHANGED_CHANNEL,
  ResourceChangedPublisher,
  type ResourceChangedEvent,
} from '../src/common/realtime/resource-changed';
import { ResourceChangedInterceptor } from '../src/common/realtime/resource-changed.interceptor';
import { ANNOUNCES_CHANGE } from '../src/common/realtime/announces-change.decorator';
import {
  ADMIN_BROADCAST_ROOM,
  RESOURCE_EVENT,
  NotificationsRealtimeGateway,
} from '../src/modules/notifications/realtime.gateway';

/**
 * Cross-operator live updates: one reviewer's decision moving another
 * reviewer's open queue.
 *
 * The claim this rests on is the same one migration 0047 rests on — NOTIFY is
 * queued until COMMIT and discarded on rollback — so the first block proves it
 * against real Postgres for the NEW channel rather than assuming it carries
 * over. The rest is delivery and shape, which are ordinary units.
 */

let ctx: MoneyTestContext;
let listener: Client;
let heard: ResourceChangedEvent[];

async function waitFor(count: number, timeoutMs = 5_000): Promise<ResourceChangedEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (heard.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [...heard];
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const uri = new URL(process.env['TEST_PG_URI'] as string);
  uri.pathname = `/${ctx.databaseName}`;
  listener = new Client({ connectionString: uri.toString() });
  await listener.connect();
  await listener.query(`LISTEN ${RESOURCE_CHANGED_CHANNEL}`);
  heard = [];
  listener.on('notification', (message) => {
    if (message.channel !== RESOURCE_CHANGED_CHANNEL || !message.payload) return;
    heard.push(JSON.parse(message.payload) as ResourceChangedEvent);
  });
}, 120_000);

afterAll(async () => {
  await listener?.end();
  await stopMoneyTestDb(ctx);
});

describe('the resource_changed channel', () => {
  it('announces a committed change', async () => {
    heard = [];
    const publisher = new ResourceChangedPublisher(ctx.db);
    await publisher.publish({ resource: 'kyc', actorAdminId: 'admin-1' });
    const events = await waitFor(1);
    expect(events).toEqual([{ resource: 'kyc', actorAdminId: 'admin-1' }]);
  });

  it('says NOTHING when the transaction rolls back', async () => {
    /*
     * The guarantee the whole design rests on. A KYC approval that fails
     * halfway must not tell every other reviewer the queue moved — they would
     * refetch, see the row still pending, and have no way to tell that from a
     * stale screen.
     */
    heard = [];
    const publisher = new ResourceChangedPublisher(ctx.db);
    await expect(
      ctx.db.transaction(async (tx) => {
        await publisher.publish({ resource: 'withdrawals' }, tx);
        throw new Error('the decision failed after announcing');
      }),
    ).rejects.toThrow('the decision failed after announcing');

    // Give the database the same window a real delivery would have had.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(heard).toEqual([]);
  });

  it('never throws, so a broken announcement cannot undo a decision', async () => {
    /*
     * This runs after the money has moved. If it threw, a completed approval
     * would answer 500 and an operator would try it again.
     */
    const exploding = {
      execute: () => Promise.reject(new Error('connection lost')),
    } as unknown as MoneyTestContext['db'];
    const publisher = new ResourceChangedPublisher(exploding);
    await expect(publisher.publish({ resource: 'clients' })).resolves.toBeUndefined();
  });
});

/** A Socket.IO server reduced to what the gateway calls, `.except()` included. */
function fakeServer() {
  const sent: { rooms: string[]; excluded: string[]; event: string; payload: unknown }[] = [];
  const chain = (rooms: string[], excluded: string[]) => ({
    except: (room: string) => chain(rooms, [...excluded, room]),
    emit: (event: string, payload: unknown) => {
      sent.push({ rooms, excluded, event, payload });
    },
  });
  return { server: { to: (room: string) => chain([room], []) }, sent };
}

describe('publishResourceChange', () => {
  const build = () => {
    const gateway = new NotificationsRealtimeGateway({ get: () => 'test' } as never, {} as never);
    const { server, sent } = fakeServer();
    (gateway as unknown as { server: unknown }).server = server;
    return { gateway, sent };
  };

  it('reaches every operator except the one who acted', () => {
    const { gateway, sent } = build();
    gateway.publishResourceChange({ resource: 'kyc', actorAdminId: 'admin-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.rooms).toEqual([ADMIN_BROADCAST_ROOM]);
    // Their own screen refreshed from its own mutation; the echo would be a
    // second redundant refetch of everything they are looking at.
    expect(sent[0]?.excluded).toEqual(['admin:admin-1']);
    expect(sent[0]?.event).toBe(RESOURCE_EVENT);
  });

  it('reaches everyone when a system actor did it', () => {
    const { gateway, sent } = build();
    gateway.publishResourceChange({ resource: 'withdrawals' });
    expect(sent[0]?.excluded).toEqual([]);
  });

  it('carries a resource name and NOTHING else', () => {
    /*
     * The property the whole feature's safety rests on. No client id, no
     * amount, no status — so broadcasting to every admin cannot disclose
     * anything, and the console still reads the rows through the same
     * permission- and scope-guarded endpoints. If this ever grows a field,
     * the fan-out becomes an authorization decision.
     */
    const { gateway, sent } = build();
    gateway.publishResourceChange({ resource: 'clients', actorAdminId: 'admin-9' });
    expect(sent[0]?.payload).toEqual({ resource: 'clients' });
  });

  it('does not fall over with no server attached', () => {
    const gateway = new NotificationsRealtimeGateway({ get: () => 'test' } as never, {} as never);
    expect(() => gateway.publishResourceChange({ resource: 'kyc' })).not.toThrow();
  });
});

describe('ResourceChangedInterceptor', () => {
  const build = (resource: string | undefined, admin?: { id: string }) => {
    const publish = vi.fn(() => Promise.resolve());
    const interceptor = new ResourceChangedInterceptor(
      { get: () => resource } as never,
      { publish } as never,
    );
    const context = {
      getHandler: () => () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ admin }) }),
    } as never;
    return { interceptor, context, publish };
  };

  it('announces after a handler that succeeded', async () => {
    const { interceptor, context, publish } = build('kyc', { id: 'admin-2' });
    await lastValueFrom(interceptor.intercept(context, { handle: () => of('ok') }));
    expect(publish).toHaveBeenCalledWith({ resource: 'kyc', actorAdminId: 'admin-2' });
  });

  it('announces NOTHING when the handler threw', async () => {
    /*
     * The reason this is an interceptor rather than a line inside the service:
     * a refused approval — a 403 from PermissionsGuard, a 409 on an
     * already-decided submission — must not tell every other reviewer that the
     * queue moved. An interceptor cannot fire on a path that threw; a service
     * call placed one line too early can.
     */
    const { interceptor, context, publish } = build('kyc', { id: 'admin-2' });
    await expect(
      lastValueFrom(
        interceptor.intercept(context, { handle: () => throwError(() => new Error('refused')) }),
      ),
    ).rejects.toThrow('refused');
    expect(publish).not.toHaveBeenCalled();
  });

  it('stays out of the way on an unmarked handler', async () => {
    const { interceptor, context, publish } = build(undefined);
    await lastValueFrom(interceptor.intercept(context, { handle: () => of('ok') }));
    expect(publish).not.toHaveBeenCalled();
  });

  it('uses the metadata key the decorator writes', () => {
    expect(ANNOUNCES_CHANGE).toBe('announces_change');
  });
});
