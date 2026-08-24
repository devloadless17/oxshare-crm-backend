/**
 * Close the partner tree's open trades, accrue the commission, and report it.
 *
 * ## Why the sub-partner showed nothing
 *
 * `seed-partner-tree.mjs` leaves positions OPEN, and an open trade earns nobody
 * anything: commission is accrued when a position CLOSES, from what the broker
 * kept on it. A partner whose whole book is open sees trades on the positions
 * tab and zero on every figure — which is correct, and looks broken.
 *
 * ## Through PositionsService.close, not an UPDATE
 *
 * That method is the seam the real system uses: it closes the row conditionally
 * on it still being open (so two closes cannot both accrue), derives the broker
 * revenue as |commission| + |swap|, and calls the commission engine. Writing
 * `status = 'closed'` by hand would produce a closed trade that never paid
 * anybody and no way to tell that from an engine failure.
 *
 * ## The hold window is overridden, and that is the only shortcut
 *
 * Accruals are written `pending` and mature for `IB_COMMISSION_HOLD_HOURS`
 * (default 24) before `confirmPending` credits a wallet. A fixture that waited a
 * day would be useless, so this sets the window to 0 for its own process only —
 * the same code path, a different configured delay. Nothing else is faked: the
 * ledger entry, the wallet credit and the accrual transition all happen for
 * real.
 *
 * Usage:
 *   node scripts/close-tree-positions.mjs            # report only
 *   node scripts/close-tree-positions.mjs --apply
 *   node scripts/close-tree-positions.mjs --apply --open 2   # open a fresh batch first
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';

/*
 * BEFORE the app context is built: `holdHours()` reads this through
 * ConfigService, which snapshots the environment at module init.
 */
process.env.IB_COMMISSION_HOLD_HOURS = '0';
process.env.NODE_ENV ??= 'development';

const { AppModule } = await import('../dist/app.module.js');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const arg = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const APPLY = has('--apply');
const OPEN = Number.parseInt(arg('--open', '0'), 10);

const PARTNER_EMAIL = 'hazimehsen1@gmail.com';
const LOGIN_PREFIX = 'TREE-';
const TICKET_PREFIX = 'SIM-';

/*
 * Deliberately ROUND broker revenues, so the split can be checked by eye.
 *
 * commission + swap is what the house kept on the trade; the pair is chosen to
 * total 10, 20, 30 … rather than to look like a real spread, because the point
 * of this fixture is arithmetic somebody can verify without a calculator.
 */
const CLOSES = [
  { commission: '8.00', swap: '2.00' }, //  10
  { commission: '16.00', swap: '4.00' }, // 20
  { commission: '24.00', swap: '6.00' }, // 30
  { commission: '32.00', swap: '8.00' }, // 40
  { commission: '40.00', swap: '10.00' }, // 50
  { commission: '48.00', swap: '12.00' }, // 60
];

const SYMBOLS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'USDJPY'];
const pad = (value, width) => String(value).padStart(width);
const padEnd = (value, width) => String(value).padEnd(width);

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });

try {
  const { DRIZZLE_DB } = await import('../dist/database/database.module.js');
  const db = app.get(DRIZZLE_DB);
  const { sql } = await import('drizzle-orm');

  const all = async (strings, ...values) => (await db.execute(sql(strings, ...values))).rows ?? [];
  const one = async (strings, ...values) => (await all(strings, ...values))[0];

  const partner = await one`SELECT id FROM users WHERE email = ${PARTNER_EMAIL}`;
  if (!partner) throw new Error(`${PARTNER_EMAIL} does not exist — run seed-partner-tree first.`);

  if (!APPLY) {
    console.log('Report only. Re-run with --apply to close and accrue.\n');
    await report(all, partner.id);
  } else {
    await run({ all, one, db, sql, partner });
  }
} finally {
  await app.close();
}

async function run({ all, db, sql, partner }) {
  // ── Optionally open a fresh batch, so the script is re-runnable ──────────
  if (OPEN > 0) {
    const accounts = await all`
      SELECT ta.id, ta.user_id FROM trading_accounts ta
       WHERE ta.login LIKE ${`${LOGIN_PREFIX}%`} ORDER BY ta.login`;

    let opened = 0;
    for (const [at, account] of accounts.entries()) {
      for (let index = 0; index < OPEN; index += 1) {
        await db.execute(sql`
          INSERT INTO positions
            (id, user_id, trading_account_id, ticket, symbol, side, volume, open_price,
             profit, swap, commission, currency, status, opened_at)
          VALUES (${randomUUID()}, ${account.user_id}, ${account.id},
                  ${`${TICKET_PREFIX}${Date.now()}-${at}-${index}`},
                  ${SYMBOLS[(at + index) % SYMBOLS.length]},
                  ${index % 2 === 0 ? 'buy' : 'sell'},
                  ${(0.1 * (1 + index)).toFixed(2)}, '1.00000000',
                  '0', '0', '0', 'USD', 'open', now())`);
        opened += 1;
      }
    }
    console.log(`opened ${opened} fresh position(s)\n`);
  }

  // ── Close every open position on the tree's accounts ─────────────────────
  const open = await all`
    SELECT p.id, p.ticket, p.symbol, p.volume, u.email
      FROM positions p
      JOIN trading_accounts ta ON ta.id = p.trading_account_id
      JOIN users u ON u.id = p.user_id
     WHERE ta.login LIKE ${`${LOGIN_PREFIX}%`} AND p.status = 'open'
     ORDER BY u.email, p.ticket`;

  if (open.length === 0) {
    console.log('No open positions on the tree. Re-run with --open N to add some.\n');
  }

  const { PositionsService } = await import('../dist/modules/trading/positions.service.js');
  const positions = app.get(PositionsService);

  console.log('=== closing ===');
  for (const [at, row] of open.entries()) {
    const { commission, swap } = CLOSES[at % CLOSES.length];
    await positions.close(row.id, {
      closePrice: '1.00000000',
      // The CLIENT's result, which has nothing to do with what the broker kept
      // — a losing trade still pays a partner, and a winning one still does.
      profit: at % 2 === 0 ? '12.50' : '-7.25',
      swap,
      commission,
    });
    const revenue = (Number(commission) + Number(swap)).toFixed(2);
    console.log(
      `  ${padEnd(row.email, 30)} ${padEnd(row.symbol, 7)} broker kept ${pad(revenue, 7)}`,
    );
  }

  // ── Mature and credit them ───────────────────────────────────────────────
  const { CommissionService } = await import('../dist/modules/ib/commission.service.js');
  const result = await app.get(CommissionService).confirmPending();
  console.log(
    `\nconfirmed ${result.confirmed} accrual(s), ${result.failed} failed, ${result.held} still held`,
  );

  console.log('');
  await report(all, partner.id);
}

/** The split, per trade and in total, for both chain shapes in the tree. */
async function report(all, partnerId) {
  const rows = await all`
    SELECT a.source_id,
           a.base_amount,
           a.amount,
           a.depth,
           a.level,
           a.rate_value,
           a.status,
           earner.email  AS earner_email,
           client.email  AS client_email,
           p.symbol,
           p.status      AS position_status
      FROM ib_accruals a
      JOIN users earner ON earner.id = a.ib_user_id
      JOIN users client ON client.id = a.client_user_id
      JOIN positions p  ON p.id = a.source_id
     WHERE client.email LIKE 'hazimehsen1-client%'
     ORDER BY a.source_id, a.depth`;

  if (rows.length === 0) {
    console.log('No accruals for the tree yet.');
    return;
  }

  console.log('=== per closed trade ===');
  console.log(
    `${padEnd('client', 30)} ${padEnd('sym', 7)} ${pad('broker rev', 11)} ${pad('sub-IB L2', 10)} ${pad('IB L1', 10)} ${pad('broker keeps', 13)}`,
  );

  const byTrade = new Map();
  for (const row of rows) {
    const trade = byTrade.get(row.source_id) ?? {
      client: row.client_email,
      symbol: row.symbol,
      base: row.base_amount,
      legs: {},
    };
    trade.legs[row.depth] = row;
    byTrade.set(row.source_id, trade);
  }

  let totals = { base: 0, sub: 0, ib: 0 };
  for (const trade of byTrade.values()) {
    const sub = Number(trade.legs[1]?.amount ?? 0);
    const ib = Number(trade.legs[2]?.amount ?? 0);
    const base = Number(trade.base);
    totals = { base: totals.base + base, sub: totals.sub + sub, ib: totals.ib + ib };
    console.log(
      `${padEnd(trade.client, 30)} ${padEnd(trade.symbol, 7)} ${pad(base.toFixed(2), 11)} ${pad(sub.toFixed(2), 10)} ${pad(ib.toFixed(2), 10)} ${pad((base - sub - ib).toFixed(2), 13)}`,
    );
  }

  console.log(
    `${padEnd('TOTAL', 38)} ${pad(totals.base.toFixed(2), 11)} ${pad(totals.sub.toFixed(2), 10)} ${pad(totals.ib.toFixed(2), 10)} ${pad((totals.base - totals.sub - totals.ib).toFixed(2), 13)}`,
  );

  const pct = (part) => ((part / totals.base) * 100).toFixed(2);
  console.log(
    `${padEnd('share of broker revenue', 38)} ${pad('100.00%', 11)} ${pad(pct(totals.sub) + '%', 10)} ${pad(pct(totals.ib) + '%', 10)} ${pad(pct(totals.base - totals.sub - totals.ib) + '%', 13)}`,
  );

  console.log('\n=== wallet balances (USD) ===');
  const balances = await all`
    SELECT u.email, w.balance
      FROM wallets w JOIN users u ON u.id = w.user_id
     WHERE w.currency = 'USD'
       AND u.email IN ('hazimehsen1@gmail.com', 'hazimehussein43@gmail.com')
     ORDER BY u.email`;
  for (const row of balances) {
    console.log(`  ${padEnd(row.email, 30)} ${pad(Number(row.balance).toFixed(2), 12)}`);
  }

  const pending = await all`
    SELECT status, count(*)::int AS n, sum(amount) AS total
      FROM ib_accruals WHERE ib_user_id = ${partnerId} GROUP BY status ORDER BY status`;
  console.log('\n=== sub-partner accruals by status ===');
  for (const row of pending) {
    console.log(
      `  ${padEnd(row.status, 12)} ${pad(row.n, 4)}  ${pad(Number(row.total).toFixed(2), 10)}`,
    );
  }
}
