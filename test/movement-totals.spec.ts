import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  movementTotalsSource,
  TransactionsService,
  type AdminMovementsFilter,
} from '../src/modules/payments/transactions.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { UNRESTRICTED, type ClientScope } from '../src/common/security/client-scope';
import { auditStubAs } from './audit-stub';
import { emailStubAs } from './email-stub';
import { notificationsStubAs } from './notifications-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { gatewayStubAs } from './gateway-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The Financial page's tab counts and summary come from STORED TOTALS (0165) —
 * per day for a reader who sees every client, per client for a territory or one
 * client — and must be EXACTLY what counting the live rows gives, after inserts,
 * state changes and deletes, folded or not.
 *
 * The live answer is the service's own other path, forced by a date range that
 * covers everything (the per-client totals have no day, so a territory with dates
 * reads the rows). Comparing the service with itself tests the mapping the
 * triggers state against the union the list uses, and the territory predicate
 * applied to the totals against the one applied to the rows, restating neither.
 */

let ctx: MoneyTestContext;
let service: TransactionsService;
let tagA: string;
let clientA: number;

/** Territory tag A, with and without new clients; new clients alone. */
const scopes = (): Record<string, ClientScope> => ({
  onlyA: { unrestricted: false, tagIds: [tagA], includesUntriaged: false },
  aAndNew: { unrestricted: false, tagIds: [tagA], includesUntriaged: true },
  newOnly: { unrestricted: false, tagIds: [], includesUntriaged: true },
});
const EVERYTHING = { from: '2000-01-01', to: '2999-12-31' };

async function q(text: string, values: unknown[] = []) {
  return (await ctx.pool.query(text, values)).rows as Record<string, unknown>[];
}

async function client(email: string) {
  const [u] = await q(
    `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Tot', 'Als') RETURNING id`,
    [email],
  );
  const id = u.id as number;
  const wallet = (currency: string, kind = 'main') =>
    q(`INSERT INTO wallets (user_id, currency, kind) VALUES ($1, $2, $3) RETURNING id`, [
      id,
      currency,
      kind,
    ]).then((r) => r[0].id as string);
  return {
    id,
    usd: await wallet('USD'),
    eur: await wallet('EUR'),
    commission: await wallet('USD', 'commission'),
  };
}

const tx = (
  userId: number,
  walletId: string,
  direction: string,
  state: string,
  currency: string,
  amount: string,
  at: string,
) =>
  q(
    `INSERT INTO transactions (user_id, wallet_id, direction, state, currency, amount, provider, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7) RETURNING id`,
    [userId, walletId, direction, state, currency, amount, at],
  ).then((r) => r[0].id as string);

/** One read, as the Financial page makes it; rows sorted so order is not the question. */
async function read(filter: AdminMovementsFilter) {
  const summary = await service.summarizeForAdmin(filter);
  const list = await service.listAllForAdmin({ ...filter, limit: 1 });
  const key = (r: object) => JSON.stringify(r);
  return {
    rows: [...summary.rows].sort((a, b) => key(a).localeCompare(key(b))),
    directions: [...summary.directions].sort((a, b) => key(a).localeCompare(key(b))),
    counts: list.counts,
    directionCounts: list.directionCounts,
    total: list.total,
  };
}

const FILTERS: Omit<AdminMovementsFilter, 'scope'>[] = [
  {},
  { currency: 'EUR' },
  { direction: 'withdrawal' },
  { state: 'pending' },
  { kind: 'transfer' },
  { from: '2026-03-02', to: '2026-03-02' },
  { from: '2026-03-01', to: '2026-03-01', direction: 'deposit', state: 'success' },
];

/** Every stored-totals path against the live rows, for every filter. */
async function expectTotalsAreTheRows() {
  let compared = 0;
  for (const filter of FILTERS) {
    const label = JSON.stringify(filter);
    const liveRange = { from: filter.from ?? EVERYTHING.from, to: filter.to ?? EVERYTHING.to };

    // The whole book: daily totals vs the rows, seen through a territory holding everyone.
    const daily = { ...filter, scope: UNRESTRICTED };
    const everyone = { ...filter, ...liveRange, scope: scopes().aAndNew };
    expect(movementTotalsSource(daily)).toBe('daily');
    expect(movementTotalsSource(everyone)).toBeUndefined();
    expect(await read(daily), `daily ${label}`).toEqual(await read(everyone));
    compared++;

    if (filter.from) continue; // per-client totals have no day
    // Each territory, and one client: per-client totals vs the rows.
    const reads: [string, AdminMovementsFilter][] = [
      ...Object.entries(scopes()).map(([name, scope]): [string, AdminMovementsFilter] => [
        name,
        { ...filter, scope },
      ]),
      ['one client', { ...filter, scope: UNRESTRICTED, userId: clientA }],
    ];
    for (const [name, totals] of reads) {
      expect(movementTotalsSource(totals), name).toBe('client');
      expect(movementTotalsSource({ ...totals, ...EVERYTHING }), name).toBeUndefined();
      expect(await read(totals), `${name} ${label}`).toEqual(
        await read({ ...totals, ...EVERYTHING }),
      );
      compared++;
    }
  }
  expect(compared).toBe(FILTERS.length + 4 * FILTERS.filter((f) => !f.from).length);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  service = new TransactionsService(
    new WalletService(ctx.db),
    ctx.db,
    new PaymentMethodsService(ctx.db, currencies, auditStubAs(), gatewayStubAs()),
    currencies,
    gatewayStubAs(),
    new ConfigService(),
    emailStubAs(),
    notificationsStubAs(),
    transfersStubAs(),
    transferExecutorStubAs(),
  );

  await q(
    `INSERT INTO currencies (code, name, symbol, decimals, enabled) VALUES ('EUR', 'Euro', '€', 2, true)
     ON CONFLICT (code) DO NOTHING`,
  );
  const a = await client('totals-a@example.com');
  const b = await client('totals-b@example.com');
  clientA = a.id;
  // A carries territory tag A; B carries no tag, so B is a "new client".
  [{ id: tagA }] = (await q(
    `INSERT INTO client_tags (slug, label) VALUES ('totals-a', 'Totals A') RETURNING id`,
  )) as { id: string }[];
  const [{ id: adminId }] = await q(
    `INSERT INTO admins (email, password_hash, name) VALUES ('totals-admin@example.com', 'x', 'Totals') RETURNING id`,
  );
  await q(`INSERT INTO client_tag_assignments (user_id, tag_id, assigned_by) VALUES ($1, $2, $3)`, [
    a.id,
    tagA,
    adminId,
  ]);

  // Seconds either side of a UTC midnight, so a day boundary is exercised.
  await tx(a.id, a.usd, 'deposit', 'success', 'USD', '100.12345678', '2026-03-01T23:59:59Z');
  await tx(a.id, a.usd, 'deposit', 'success', 'USD', '0.00000001', '2026-03-02T00:00:01Z');
  await tx(a.id, a.eur, 'deposit', 'pending', 'EUR', '250.50000000', '2026-03-02T10:00:00Z');
  await tx(b.id, b.usd, 'withdrawal', 'approved', 'USD', '75.00000000', '2026-03-02T11:00:00Z');
  await tx(b.id, b.usd, 'withdrawal', 'rejected', 'USD', '12.34000000', '2026-03-03T09:00:00Z');
  await tx(b.id, b.eur, 'deposit', 'failure', 'EUR', '9.99000000', '2026-03-01T08:00:00Z');

  const [account] = await q(
    `INSERT INTO trading_accounts (user_id, login, currency) VALUES ($1, '99100001', 'USD') RETURNING id`,
    [a.id],
  );
  for (const [direction, state, amount] of [
    ['wallet_to_account', 'pending', '10.00000000'],
    ['account_to_wallet', 'settled', '20.00000000'],
    ['wallet_to_account', 'failed', '30.00000000'],
  ]) {
    await q(
      `INSERT INTO transfers (user_id, wallet_id, trading_account_id, direction, state, amount, currency, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'USD', '2026-03-02T12:00:00Z')`,
      [a.id, a.usd, account.id, direction, state, amount],
    );
  }
  await q(
    `INSERT INTO ib_wallet_transfers (user_id, from_wallet_id, to_wallet_id, amount, currency, created_at)
     VALUES ($1, $2, $3, '5.55000000', 'USD', '2026-03-02T13:00:00Z')`,
    [b.id, b.commission, b.usd],
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('the stored totals (0165) are the live rows, counted', () => {
  it('agree on every tab, total, filter and territory — deltas not yet folded', async () => {
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM movement_total_deltas`);
    expect(n, 'the triggers wrote no deltas — the case is vacuous').toBeGreaterThan(0);
    await expectTotalsAreTheRows();
  });

  it('still agree after states change, a transfer settles, and a row is deleted', async () => {
    await q(`UPDATE transactions SET state = 'success' WHERE state = 'pending'`);
    await q(`UPDATE transactions SET state = 'success' WHERE state = 'approved'`);
    await q(`UPDATE transfers SET state = 'settled' WHERE state = 'pending'`);
    await q(`DELETE FROM transactions WHERE state = 'rejected'`);
    await expectTotalsAreTheRows();
  });

  it('still agree once folded — no delta and no empty bucket left behind', async () => {
    await q(`SELECT fold_movement_totals()`);
    const [left] = await q(`
      SELECT (SELECT count(*) FROM movement_total_deltas)::int AS deltas,
             (SELECT count(*) FROM movement_daily_totals WHERE count = 0)::int AS empty_days,
             (SELECT count(*) FROM movement_client_totals WHERE count = 0)::int AS empty_clients,
             (SELECT count(*) FROM movement_client_totals)::int AS client_buckets`);
    expect(left).toMatchObject({ deltas: 0, empty_days: 0, empty_clients: 0 });
    expect(left.client_buckets, 'the per-client totals are empty — vacuous').toBeGreaterThan(0);
    await expectTotalsAreTheRows();
  });

  it('keep amounts exact to the eighth decimal', async () => {
    for (const scope of [UNRESTRICTED, scopes().onlyA]) {
      const summary = await service.summarizeForAdmin({
        scope,
        currency: 'USD',
        direction: 'deposit',
        kind: 'payment',
      });
      const success = summary.rows.find((r) => r.state === 'success');
      expect(success?.total).toBe('100.12345679');
    }
  });
});
