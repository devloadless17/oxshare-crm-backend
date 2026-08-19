import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  Mt5GroupSyncService,
  type GroupSyncRun,
} from '../src/modules/trading/mt5/mt5-group-sync.service';
import type { Mt5BridgeClient, Mt5Group } from '../src/modules/trading/mt5/mt5-bridge.client';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The MT5 group mirror, against real Postgres.
 *
 * The interesting assertions are all about MEMORY: a live `GET /groups` reports
 * what is true now and structurally cannot report what changed, so every case
 * below — a group vanishing, coming back, being re-cased, or quietly changing
 * currency underneath a product still selling it — is one the previous
 * live-only code could not have detected at all.
 *
 * Real Postgres rather than a fake, because the case-insensitive unique index
 * IS the guarantee that a re-cased group updates its row instead of forking a
 * second one, and an in-memory map would assert nothing about it.
 */

let ctx: MoneyTestContext;
let groups: Mt5GroupSyncService;

/** What the next `listGroups()` answers, per test. */
let serverGroups: Mt5Group[];
let listGroups: ReturnType<typeof vi.fn>;

function group(name: string, currency = 'USD', leverageDefault = 200): Mt5Group {
  return { name, currency, leverageDefault };
}

async function names(): Promise<string[]> {
  return (await groups.cached()).map((row) => row.name);
}

/** A product selling one MT5 group, which is what makes drift matter. */
async function sellGroup(mt5Group: string, currency: string): Promise<void> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_products (name) VALUES (${`Product ${mt5Group}`}) RETURNING id
  `);
  await ctx.db.execute(sql`
    INSERT INTO trading_product_groups (product_id, environment, mt5_group, currency)
    VALUES (${rows[0].id}, 'live', ${mt5Group}, ${currency})
  `);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  // Not `async () =>`: there is nothing to await, and the lint rule is right
  // that an async function without one is a promise wearing a costume.
  listGroups = vi.fn(() => Promise.resolve(serverGroups));
  groups = new Mt5GroupSyncService(ctx.db, {
    get isConfigured() {
      return true;
    },
    listGroups,
  } as unknown as Mt5BridgeClient);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM trading_product_groups`);
  await ctx.db.execute(sql`DELETE FROM trading_products`);
  await ctx.db.execute(sql`DELETE FROM mt5_groups`);
  listGroups.mockClear();
});

describe('the catalogue is written down', () => {
  it('records what the server reports', async () => {
    serverGroups = [group('real\\Standard'), group('real\\ECN', 'EUR')];

    const run = (await groups.sync()) as GroupSyncRun;

    expect(run.added).toBe(2);
    expect(await names()).toEqual(['real\\ECN', 'real\\Standard']);
  });

  it('stores an unset default leverage as NULL rather than as 1:0', async () => {
    serverGroups = [group('real\\Standard', 'USD', 0)];

    await groups.sync();

    expect((await groups.cached())[0].leverageDefault).toBeNull();
  });

  it('re-running changes nothing and creates nothing', async () => {
    serverGroups = [group('real\\Standard')];

    await groups.sync();
    const second = (await groups.sync()) as GroupSyncRun;

    expect(second.added).toBe(0);
    expect(second.removed).toBe(0);
    expect(await names()).toEqual(['real\\Standard']);
  });
});

describe('a group that disappears', () => {
  it('is marked gone rather than deleted, and drops out of the picker', async () => {
    serverGroups = [group('real\\Standard'), group('real\\ECN')];
    await groups.sync();

    serverGroups = [group('real\\Standard')];
    const run = (await groups.sync()) as GroupSyncRun;

    expect(run.removed).toBe(1);
    // Gone from what an operator may choose...
    expect(await names()).toEqual(['real\\Standard']);
    // ...but the row survives, because accounts opened under it still need
    // explaining.
    const all = await groups.cached({ includeRemoved: true });
    expect(all.map((row) => row.name).sort()).toEqual(['real\\ECN', 'real\\Standard']);
    expect(all.find((row) => row.name === 'real\\ECN')?.removedAt).toBeInstanceOf(Date);
  });

  it('keeps its ORIGINAL removal time when it stays gone', async () => {
    serverGroups = [group('real\\Standard'), group('real\\ECN')];
    await groups.sync();
    serverGroups = [group('real\\Standard')];
    await groups.sync();

    const first = (await groups.cached({ includeRemoved: true })).find(
      (row) => row.name === 'real\\ECN',
    )?.removedAt;

    const run = (await groups.sync()) as GroupSyncRun;
    const second = (await groups.cached({ includeRemoved: true })).find(
      (row) => row.name === 'real\\ECN',
    )?.removedAt;

    // Not re-stamped: "how long has this been gone" must stay answerable.
    expect(second).toEqual(first);
    expect(run.removed).toBe(0);
  });

  it('comes back cleanly when the server reports it again', async () => {
    serverGroups = [group('real\\Standard'), group('real\\ECN')];
    await groups.sync();
    serverGroups = [group('real\\Standard')];
    await groups.sync();

    serverGroups = [group('real\\Standard'), group('real\\ECN')];
    const run = (await groups.sync()) as GroupSyncRun;

    expect(run.restored).toBe(1);
    expect(run.added).toBe(0); // Its history is intact — not a new row.
    expect(await names()).toEqual(['real\\ECN', 'real\\Standard']);
  });
});

describe('an empty catalogue is refused', () => {
  it('keeps the previous groups when MT5 reports none', async () => {
    serverGroups = [group('real\\Standard')];
    await groups.sync();

    serverGroups = [];
    const run = (await groups.sync()) as GroupSyncRun;

    /*
     * A manager account whose permissions changed reports zero groups, and so
     * does a half-initialised session. Both are far likelier than a broker
     * deleting their entire structure, and believing the empty answer would
     * flag every product on the platform as broken.
     */
    expect(run.removed).toBe(0);
    expect(await names()).toEqual(['real\\Standard']);
  });
});

describe('MT5 is case-insensitive, and so is the mirror', () => {
  it('updates the existing row when the server re-cases a group', async () => {
    serverGroups = [group('real\\Standard')];
    await groups.sync();

    serverGroups = [group('Real\\STANDARD')];
    const run = (await groups.sync()) as GroupSyncRun;

    expect(run.added).toBe(0);
    expect(run.removed).toBe(0);
    // One row, carrying the SERVER's spelling — that is what gets handed back
    // to MT5 on every account open.
    expect(await names()).toEqual(['Real\\STANDARD']);
  });
});

describe('drift against what products are selling', () => {
  it('reports a claimed group the server no longer has', async () => {
    serverGroups = [group('real\\Standard')];
    await groups.sync();
    await sellGroup('real\\ECN', 'USD');

    const run = (await groups.sync()) as GroupSyncRun;

    // Silent until now: a client hits it at account-open time as a bare MT5
    // return code, and the desk hears "I can't open an account".
    expect(run.claimedMissing).toBe(1);
  });

  it('reports a claimed group whose currency changed underneath it', async () => {
    await sellGroup('real\\Standard', 'USD');
    serverGroups = [group('real\\Standard', 'EUR')];

    const run = (await groups.sync()) as GroupSyncRun;

    // `trading_product_groups.currency` is cached at attach time, so every
    // balance on those accounts is labelled with the wrong currency.
    expect(run.currencyDrift).toBe(1);
    expect(run.claimedMissing).toBe(0);
  });

  it('says nothing when the catalogue and the products agree', async () => {
    await sellGroup('real\\Standard', 'USD');
    serverGroups = [group('real\\Standard', 'USD')];

    const run = (await groups.sync()) as GroupSyncRun;

    expect(run.currencyDrift).toBe(0);
    expect(run.claimedMissing).toBe(0);
  });
});

describe('the picker still answers when MT5 does not', () => {
  it('reads live when the bridge is up, and says so', async () => {
    serverGroups = [group('real\\Standard')];

    const offer = await groups.offerable();

    expect(offer.live).toBe(true);
    // NULL means "this is current", which is the whole signal.
    expect(offer.groups[0].lastSeenAt).toBeNull();
  });

  it('falls back to the mirror, dated, when the bridge throws', async () => {
    serverGroups = [group('real\\Standard')];
    await groups.sync();

    listGroups.mockRejectedValueOnce(new Error('bridge unreachable'));
    const offer = await groups.offerable();

    // Before this the screen answered with an error page.
    expect(offer.live).toBe(false);
    expect(offer.groups.map((row) => row.name)).toEqual(['real\\Standard']);
    expect(offer.groups[0].lastSeenAt).toBeInstanceOf(Date);
  });

  it('does not offer a group the server has stopped reporting', async () => {
    serverGroups = [group('real\\Standard'), group('real\\ECN')];
    await groups.sync();
    serverGroups = [group('real\\Standard')];
    await groups.sync();

    listGroups.mockRejectedValueOnce(new Error('bridge unreachable'));
    const offer = await groups.offerable();

    // Offering it would produce an account-open failure naming neither the
    // field nor the reason — the exact outcome the products screen prevents.
    expect(offer.groups.map((row) => row.name)).toEqual(['real\\Standard']);
  });
});

describe('a deployment with no bridge', () => {
  it('reports null rather than pretending to have synced', async () => {
    const unconfigured = new Mt5GroupSyncService(ctx.db, {
      get isConfigured() {
        return false;
      },
      listGroups: vi.fn(),
    } as unknown as Mt5BridgeClient);

    expect(await unconfigured.sync()).toBeNull();
  });
});
