import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  Mt5SymbolSyncService,
  type SymbolSyncRun,
} from '../src/modules/trading/mt5/mt5-symbol-sync.service';
import type { Mt5BridgeClient, Mt5Symbol } from '../src/modules/trading/mt5/mt5-bridge.client';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The MT5 SYMBOL mirror (0198), against real Postgres.
 *
 * The commission engine reads a deal's folder from this table, so what matters
 * is what it REMEMBERS: a symbol the server stops reporting keeps its row (a
 * deal on it may still be waiting to be priced), an empty answer from the
 * server never wipes the list, and a re-cased symbol updates its row through
 * the case-insensitive unique index rather than forking a second one.
 */

let ctx: MoneyTestContext;
let symbols: Mt5SymbolSyncService;

/** What the next `listSymbols()` answers, per test. */
let serverSymbols: Mt5Symbol[];
let listSymbols: ReturnType<typeof vi.fn>;
let configured: boolean;

function symbol(name: string, path: string, description = ''): Mt5Symbol {
  return { symbol: name, path, description };
}

type MirrorRow = {
  symbol: string;
  path: string;
  description: string;
  removed: boolean;
};

/** Every row, removed or not, by symbol. */
async function mirror(): Promise<MirrorRow[]> {
  const { rows } = await ctx.db.execute<MirrorRow>(sql`
    SELECT symbol, path, description, (removed_at IS NOT NULL) AS removed
      FROM mt5_symbols ORDER BY lower(symbol)
  `);
  return rows;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  listSymbols = vi.fn(() => Promise.resolve(serverSymbols));
  symbols = new Mt5SymbolSyncService(ctx.db, {
    get isConfigured() {
      return configured;
    },
    listSymbols,
  } as unknown as Mt5BridgeClient);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM mt5_symbols`);
  configured = true;
  listSymbols.mockClear();
});

describe('the symbol list is written down', () => {
  it('records each symbol with its folder path', async () => {
    serverSymbols = [
      symbol('EURUSD', 'Forex\\Majors\\EURUSD', 'Euro vs US Dollar'),
      symbol('BTCUSD', 'Crypto\\BTCUSD', 'Bitcoin vs US Dollar'),
    ];

    const run = (await symbols.sync()) as SymbolSyncRun;

    expect(run).toEqual({ onServer: 2, removed: 0 });
    expect(await mirror()).toEqual([
      {
        symbol: 'BTCUSD',
        path: 'Crypto\\BTCUSD',
        description: 'Bitcoin vs US Dollar',
        removed: false,
      },
      {
        symbol: 'EURUSD',
        path: 'Forex\\Majors\\EURUSD',
        description: 'Euro vs US Dollar',
        removed: false,
      },
    ]);
  });

  it('ignores blank symbol names and trims what it keeps', async () => {
    serverSymbols = [symbol('  XAUUSD ', ' Metals\\XAUUSD '), symbol('   ', 'Nowhere\\X')];

    const run = (await symbols.sync()) as SymbolSyncRun;

    expect(run.onServer).toBe(1);
    expect(await mirror()).toEqual([
      { symbol: 'XAUUSD', path: 'Metals\\XAUUSD', description: '', removed: false },
    ]);
  });
});

describe('a second sync updates, retires and restores', () => {
  it('updates a moved symbol, marks a vanished one removed, and restores one that returns', async () => {
    serverSymbols = [
      symbol('EURUSD', 'Forex\\EURUSD'),
      symbol('BTCUSD', 'Crypto\\BTCUSD'),
      symbol('XAUUSD', 'Metals\\XAUUSD'),
    ];
    await symbols.sync();

    /* EURUSD moves folder (and is re-cased); BTCUSD disappears. */
    serverSymbols = [symbol('eurusd', 'Forex\\Majors\\eurusd'), symbol('XAUUSD', 'Metals\\XAUUSD')];
    const second = (await symbols.sync()) as SymbolSyncRun;

    expect(second).toEqual({ onServer: 2, removed: 1 });
    const afterSecond = await mirror();
    /* Still three rows: removed is a mark, never a delete, and no fork on re-case. */
    expect(afterSecond).toHaveLength(3);
    expect(afterSecond.find((r) => r.symbol.toLowerCase() === 'eurusd')).toMatchObject({
      symbol: 'eurusd',
      path: 'Forex\\Majors\\eurusd',
      removed: false,
    });
    expect(afterSecond.find((r) => r.symbol === 'BTCUSD')).toMatchObject({
      path: 'Crypto\\BTCUSD',
      removed: true,
    });

    /* A symbol already removed is not counted again. */
    const third = (await symbols.sync()) as SymbolSyncRun;
    expect(third.removed).toBe(0);

    /* BTCUSD comes back. */
    serverSymbols = [...serverSymbols, symbol('BTCUSD', 'Crypto\\Majors\\BTCUSD')];
    const fourth = (await symbols.sync()) as SymbolSyncRun;

    expect(fourth).toEqual({ onServer: 3, removed: 0 });
    expect((await mirror()).find((r) => r.symbol === 'BTCUSD')).toMatchObject({
      path: 'Crypto\\Majors\\BTCUSD',
      removed: false,
    });
  });

  it('keeps one row when the server reports the same symbol twice in different cases', async () => {
    serverSymbols = [symbol('GBPUSD', 'Forex\\GBPUSD'), symbol('gbpusd', 'Forex\\gbpusd')];

    await symbols.sync();

    expect(await mirror()).toHaveLength(1);
  });
});

describe('what the sync refuses to do', () => {
  it('refuses an EMPTY server list and marks nothing removed', async () => {
    serverSymbols = [symbol('EURUSD', 'Forex\\EURUSD'), symbol('BTCUSD', 'Crypto\\BTCUSD')];
    await symbols.sync();

    serverSymbols = [];
    const run = await symbols.sync();

    expect(run).toEqual({ onServer: 0, removed: 0 });
    expect((await mirror()).every((r) => !r.removed)).toBe(true);
    expect(await mirror()).toHaveLength(2);
  });

  it('treats a list of only blank names as empty', async () => {
    serverSymbols = [symbol('EURUSD', 'Forex\\EURUSD')];
    await symbols.sync();

    serverSymbols = [symbol('', 'Forex\\X')];
    expect(await symbols.sync()).toEqual({ onServer: 0, removed: 0 });
    expect((await mirror())[0].removed).toBe(false);
  });

  it('returns null and never asks the bridge when the bridge is not configured', async () => {
    configured = false;
    serverSymbols = [symbol('EURUSD', 'Forex\\EURUSD')];

    expect(await symbols.sync()).toBeNull();
    expect(listSymbols).not.toHaveBeenCalled();
    expect(await mirror()).toEqual([]);
  });
});

describe('the picker list', () => {
  it('is empty and never-synced on a fresh install', async () => {
    expect(await symbols.listForAdmin()).toEqual({ symbols: [], lastSyncedAt: null });
  });

  it('leaves removed symbols out, orders by path, and dates the last sync', async () => {
    serverSymbols = [
      symbol('XAUUSD', 'Metals\\XAUUSD', 'Gold'),
      symbol('EURUSD', 'Forex\\EURUSD', 'Euro'),
      symbol('BTCUSD', 'Crypto\\BTCUSD', 'Bitcoin'),
    ];
    await symbols.sync();
    serverSymbols = serverSymbols.filter((s) => s.symbol !== 'BTCUSD');
    const before = Date.now();
    await symbols.sync();

    const list = await symbols.listForAdmin();

    expect(list.symbols).toEqual([
      { symbol: 'EURUSD', path: 'Forex\\EURUSD', description: 'Euro' },
      { symbol: 'XAUUSD', path: 'Metals\\XAUUSD', description: 'Gold' },
    ]);
    expect(list.lastSyncedAt).not.toBeNull();
    /* Allow for clock skew between this process and the database container. */
    expect(new Date(list.lastSyncedAt as Date).getTime()).toBeGreaterThan(before - 60_000);
  });
});
