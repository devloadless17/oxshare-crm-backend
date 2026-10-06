import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { IbCommissionTypesService } from '../src/modules/ib/ib-commission-types.service';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { auditStub, TEST_ACTOR } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * A commission type's symbol EXCLUSIONS (0198), through the CRUD service.
 *
 * What is stored is what the engine matches against, so the cleaning rules are
 * pinned here: trimmed, `/` read as MT5's `\`, no leading or trailing
 * separator, de-duplicated case-insensitively keeping the first spelling, and
 * sorted. On update `undefined` leaves a list alone and `[]` clears it — the
 * same contract `description` has — and the audit row carries both lists
 * before and after, because "who stopped paying on Crypto" is exactly the
 * question an auditor will ask.
 */

let ctx: MoneyTestContext;
let audit: ReturnType<typeof auditStub>;
let types: IbCommissionTypesService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`UPDATE trading_products SET commission_type_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_commission_types WHERE name LIKE 'Excl %'`);
  audit = auditStub();
  types = new IbCommissionTypesService(ctx.db, audit as unknown as AdminAuditService);
});

function auditDetails(action: string): Record<string, unknown> {
  const call = audit.record.mock.calls.find((c) => c[1] === action);
  expect(call, `no ${action} audit row was written`).toBeDefined();
  return call![4] as Record<string, unknown>;
}

async function stored(id: string) {
  const { rows } = await ctx.db.execute<{ excluded_paths: string[]; excluded_symbols: string[] }>(
    sql`SELECT excluded_paths, excluded_symbols FROM ib_commission_types WHERE id = ${id}`,
  );
  return rows[0];
}

describe('creating a type with exclusions', () => {
  it('round-trips both lists through create, the row and the read', async () => {
    const created = await types.create(
      {
        name: 'Excl round trip',
        commissionPerLot: '10',
        rebatePerLot: '2',
        excludedPaths: ['Crypto', 'Forex\\Exotics'],
        excludedSymbols: ['BTCUSD'],
      },
      TEST_ACTOR,
    );

    expect(created.excludedPaths).toEqual(['Crypto', 'Forex\\Exotics']);
    expect(created.excludedSymbols).toEqual(['BTCUSD']);
    expect(await stored(created.id)).toEqual({
      excluded_paths: ['Crypto', 'Forex\\Exotics'],
      excluded_symbols: ['BTCUSD'],
    });

    const read = await types.findOne(created.id);
    expect(read?.excludedPaths).toEqual(['Crypto', 'Forex\\Exotics']);
    expect(read?.excludedSymbols).toEqual(['BTCUSD']);
  });

  it('defaults both lists to empty when they are not sent', async () => {
    const created = await types.create(
      { name: 'Excl none', commissionPerLot: '10', rebatePerLot: '0' },
      TEST_ACTOR,
    );

    expect(created.excludedPaths).toEqual([]);
    expect(created.excludedSymbols).toEqual([]);
    expect(await stored(created.id)).toEqual({ excluded_paths: [], excluded_symbols: [] });
  });

  it('cleans what it stores: trim, separators, case-insensitive dedupe, sorted', async () => {
    const created = await types.create(
      {
        name: 'Excl cleaned',
        commissionPerLot: '10',
        rebatePerLot: '0',
        excludedPaths: [
          'forex/majors/', // `/` → `\`, trailing separator dropped
          '  Crypto  ', // trimmed
          '\\Metals', // leading separator dropped
          'CRYPTO', // a duplicate in another case: the FIRST spelling is kept
          'Forex\\Majors', // a duplicate of the first once cleaned
          '   ', // blank: dropped
          '\\', // only a separator: dropped
        ],
        excludedSymbols: [' xauusd ', 'BTCUSD', 'XAUUSD', 'btcusd', ''],
      },
      TEST_ACTOR,
    );

    expect(created.excludedPaths).toEqual(['Crypto', 'forex\\majors', 'Metals']);
    expect(created.excludedSymbols).toEqual(['BTCUSD', 'xauusd']);
    expect(await stored(created.id)).toEqual({
      excluded_paths: ['Crypto', 'forex\\majors', 'Metals'],
      excluded_symbols: ['BTCUSD', 'xauusd'],
    });
  });

  it('puts both lists in the create audit details', async () => {
    const created = await types.create(
      {
        name: 'Excl audited create',
        commissionPerLot: '10',
        rebatePerLot: '0',
        excludedPaths: ['Crypto'],
        excludedSymbols: ['XAUUSD'],
      },
      TEST_ACTOR,
    );

    const details = auditDetails('ib_commission_type.create');
    expect(details).toMatchObject({
      name: 'Excl audited create',
      excludedPaths: ['Crypto'],
      excludedSymbols: ['XAUUSD'],
    });
    expect(audit.record.mock.calls[0][3]).toBe(created.id);
  });
});

describe('updating a type’s exclusions', () => {
  async function seeded() {
    return await types.create(
      {
        name: 'Excl update',
        commissionPerLot: '10',
        rebatePerLot: '0',
        excludedPaths: ['Crypto'],
        excludedSymbols: ['XAUUSD'],
      },
      TEST_ACTOR,
    );
  }

  it('replaces the lists it is sent, cleaned the same way as on create', async () => {
    const type = await seeded();

    const updated = await types.update(
      type.id,
      { excludedPaths: ['Indices/Cash/', 'Crypto', 'crypto'], excludedSymbols: [' US500 '] },
      TEST_ACTOR,
    );

    expect(updated.excludedPaths).toEqual(['Crypto', 'Indices\\Cash']);
    expect(updated.excludedSymbols).toEqual(['US500']);
    expect(await stored(type.id)).toEqual({
      excluded_paths: ['Crypto', 'Indices\\Cash'],
      excluded_symbols: ['US500'],
    });
  });

  it('leaves both lists unchanged when they are not sent', async () => {
    const type = await seeded();

    const updated = await types.update(type.id, { commissionPerLot: '12' }, TEST_ACTOR);

    expect(updated.commissionPerLot).toBe('12.00000000');
    expect(updated.excludedPaths).toEqual(['Crypto']);
    expect(updated.excludedSymbols).toEqual(['XAUUSD']);
    expect(await stored(type.id)).toEqual({
      excluded_paths: ['Crypto'],
      excluded_symbols: ['XAUUSD'],
    });
  });

  it('changes one list without touching the other', async () => {
    const type = await seeded();

    const updated = await types.update(type.id, { excludedSymbols: ['BTCUSD'] }, TEST_ACTOR);

    expect(updated.excludedPaths).toEqual(['Crypto']);
    expect(updated.excludedSymbols).toEqual(['BTCUSD']);
  });

  it('clears a list sent as []', async () => {
    const type = await seeded();

    const updated = await types.update(
      type.id,
      { excludedPaths: [], excludedSymbols: [] },
      TEST_ACTOR,
    );

    expect(updated.excludedPaths).toEqual([]);
    expect(updated.excludedSymbols).toEqual([]);
    expect(await stored(type.id)).toEqual({ excluded_paths: [], excluded_symbols: [] });
  });

  it('puts the lists before AND after in the update audit details', async () => {
    const type = await seeded();

    await types.update(
      type.id,
      { excludedPaths: ['Crypto', 'Metals'], excludedSymbols: [] },
      TEST_ACTOR,
    );

    const details = auditDetails('ib_commission_type.update');
    expect(details.before).toMatchObject({
      excludedPaths: ['Crypto'],
      excludedSymbols: ['XAUUSD'],
    });
    expect(details.after).toMatchObject({
      excludedPaths: ['Crypto', 'Metals'],
      excludedSymbols: [],
    });
  });
});
