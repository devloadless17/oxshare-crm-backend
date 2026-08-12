/**
 * A live trading feed for a dev database: open positions, tick them, close them.
 *
 * ## What this is and is not
 *
 * `positions` is written by NOTHING in this codebase — there is no deal feed
 * yet, so every screen that reads open trades has only ever seen an empty
 * table. This fills it the way a real feed would: positions appear, their
 * prices and floating profit move every tick, and some of them close.
 *
 * It is a FIXTURE, not the feature. When the MT5 deal feed lands, positions
 * arrive from the broker and this script becomes redundant. Until then it is
 * the only way to see those screens with something on them.
 *
 * ## Closing a position pays NO commission, and that is not a bug here
 *
 * The commission engine accepts one revenue event — `RevenueEvent.source` is
 * the literal `'deposit'` — so no amount of trading moves a partner's balance
 * today. Making this script write accruals would invent a payout the running
 * system cannot produce, and the first person to trust it would be quoting a
 * partner money the engine never calculated. It writes trades and nothing else.
 *
 * ## Every position it writes is MARKED
 *
 * Tickets are `SIM-…`, which no MT5 ticket can match (they are numeric), so
 * `--purge` removes exactly these and nothing a real feed ever wrote.
 *
 * Usage:
 *   node scripts/simulate-positions.mjs                  # 60s, all accounts
 *   node scripts/simulate-positions.mjs --seconds 120
 *   node scripts/simulate-positions.mjs --email a@b.com  # one client's accounts
 *   node scripts/simulate-positions.mjs --purge
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const arg = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const SECONDS = Number.parseInt(arg('--seconds', '60'), 10);
const EMAIL = arg('--email', null);
const PURGE = has('--purge');

/** Tickets a real MT5 feed can never mint: its own are numeric. */
const TICKET_PREFIX = 'SIM-';
const TICK_MS = 2_000;

/*
 * Instruments with a plausible price and a tick size, so the numbers on screen
 * look like a terminal rather than like random floats. Nothing depends on the
 * values being accurate — only on them moving the way prices move.
 */
const SYMBOLS = [
  { symbol: 'EURUSD', price: 1.0850, tick: 0.0004, digits: 5, valuePerLot: 100_000 },
  { symbol: 'GBPUSD', price: 1.2710, tick: 0.0006, digits: 5, valuePerLot: 100_000 },
  { symbol: 'USDJPY', price: 157.20, tick: 0.05, digits: 3, valuePerLot: 1_000 },
  { symbol: 'XAUUSD', price: 2_350.0, tick: 1.2, digits: 2, valuePerLot: 100 },
  { symbol: 'BTCUSD', price: 61_500.0, tick: 45.0, digits: 2, valuePerLot: 1 },
];

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

function assertNotProduction() {
  const url = process.env.DATABASE_URL ?? '';
  if ((process.env.NODE_ENV ?? 'development') === 'production' || /\b(prod|production)\b/i.test(url)) {
    throw new Error('This writes fixture trades and does not run against production.');
  }
}

/*
 * A deterministic wobble rather than Math.random(), so two runs against the
 * same database produce the same tape. A simulator whose output differs every
 * time makes "did my change break this" unanswerable.
 */
let seed = 20260812;
const next = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const money = (value, digits = 2) => value.toFixed(digits);

async function purge() {
  const { rowCount } = await db.query(`DELETE FROM positions WHERE ticket LIKE '${TICKET_PREFIX}%'`);
  console.log(`removed ${rowCount} simulated position(s)`);
}

async function main() {
  assertNotProduction();
  await db.connect();

  if (PURGE) {
    await purge();
    return;
  }

  const accounts = (
    await db.query(
      `SELECT ta.id, ta.user_id, ta.login, ta.currency, u.email
         FROM trading_accounts ta
         JOIN users u ON u.id = ta.user_id
        WHERE ta.status = 'active'
          ${EMAIL ? `AND u.email = '${EMAIL}'` : ''}
        ORDER BY ta.created_at
        LIMIT 25`,
    )
  ).rows;

  if (accounts.length === 0) {
    console.log(EMAIL ? `No active trading account for ${EMAIL}.` : 'No active trading accounts.');
    return;
  }

  console.log(`simulating on ${accounts.length} account(s) for ${SECONDS}s\n`);
  for (const account of accounts) {
    console.log(`  ${account.login.padEnd(12)} ${account.email}`);
  }
  console.log();

  /** Positions this run is holding, in memory, so ticks are one UPDATE each. */
  const open = [];
  const until = Date.now() + SECONDS * 1_000;
  let opened = 0;
  let closed = 0;
  let ticks = 0;

  const openOne = async () => {
    const account = accounts[opened % accounts.length];
    const instrument = SYMBOLS[opened % SYMBOLS.length];
    const side = next() > 0.45 ? 'buy' : 'sell';
    // 0.01–1.00 lots, in steps of 0.01, like a real volume.
    const volume = Math.max(1, Math.round(next() * 100)) / 100;
    const openPrice = instrument.price * (1 + (next() - 0.5) * 0.002);

    const row = {
      id: randomUUID(),
      ticket: `${TICKET_PREFIX}${Date.now()}${opened}`,
      account,
      instrument,
      side,
      volume,
      openPrice,
      price: openPrice,
    };

    await db.query(
      `INSERT INTO positions
         (id, user_id, trading_account_id, ticket, symbol, side, volume, open_price,
          profit, swap, commission, currency, status, opened_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'0','0',$9,$10,'open', now())`,
      [
        row.id,
        account.user_id,
        account.id,
        row.ticket,
        instrument.symbol,
        side,
        money(volume, 2),
        money(openPrice, instrument.digits),
        // A commission charged at open, as most brokers do on raw-spread books.
        money(volume * 3.5, 2),
        account.currency,
      ],
    );

    open.push(row);
    opened += 1;
    console.log(
      `  OPEN   ${row.ticket}  ${instrument.symbol.padEnd(7)} ${side.padEnd(4)} ` +
        `${volume.toFixed(2)} lots @ ${openPrice.toFixed(instrument.digits)}  [${account.login}]`,
    );
  };

  const tickOne = async (row) => {
    const drift = (next() - 0.5) * 2 * row.instrument.tick;
    row.price += drift;

    /*
     * Profit in the ACCOUNT's currency, from the direction of the move. A short
     * gains when the price falls, which is the one sign error that would make
     * every number on the screen look plausible and be wrong.
     */
    const direction = row.side === 'buy' ? 1 : -1;
    const profit = (row.price - row.openPrice) * direction * row.volume * row.instrument.valuePerLot;

    await db.query(`UPDATE positions SET profit = $1, updated_at = now() WHERE id = $2`, [
      money(profit, 2),
      row.id,
    ]);
    ticks += 1;
  };

  const closeOne = async (row) => {
    const direction = row.side === 'buy' ? 1 : -1;
    const profit = (row.price - row.openPrice) * direction * row.volume * row.instrument.valuePerLot;

    /*
     * `positions_closed_has_close_data` requires close_price AND closed_at on a
     * closed row — the schema refuses a half-closed position, which is exactly
     * the state a crash between two updates would otherwise leave.
     */
    await db.query(
      `UPDATE positions
          SET status = 'closed', close_price = $1, profit = $2, closed_at = now(), updated_at = now()
        WHERE id = $3`,
      [money(row.price, row.instrument.digits), money(profit, 2), row.id],
    );

    closed += 1;
    console.log(
      `  CLOSE  ${row.ticket}  ${row.instrument.symbol.padEnd(7)} ` +
        `@ ${row.price.toFixed(row.instrument.digits)}  ${profit >= 0 ? '+' : ''}${money(profit, 2)} ${row.account.currency}`,
    );
  };

  // Open a few immediately, so the screens have something before the first tick.
  for (let n = 0; n < Math.min(5, accounts.length * 2); n += 1) await openOne();

  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));

    for (const row of open) await tickOne(row);

    // Close roughly a third of what is open, oldest first, then top back up so
    // the table never empties and never grows without bound.
    const closing = open.splice(0, Math.max(1, Math.floor(open.length / 3)));
    for (const row of closing) await closeOne(row);

    const room = Math.min(8, accounts.length * 2) - open.length;
    for (let n = 0; n < room; n += 1) await openOne();
  }

  // Leave the tape with open positions on it — an empty table at the end would
  // undo the point of running this.
  console.log(`\ndone: ${opened} opened, ${closed} closed, ${open.length} left open, ${ticks} price updates`);
  console.log(`\nRemove them with:  node scripts/simulate-positions.mjs --purge`);
}

main()
  .catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.end());
