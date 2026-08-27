#!/usr/bin/env node
/**
 * A standing-in MT5 server: opens five positions and keeps them moving.
 *
 * ## What this is for
 *
 * There is no MT5 bridge connected to this deployment, so nothing ever writes a
 * trade — and the commission engine is the one part of this system that cannot
 * be judged from a unit test alone. It pays real partners real money from real
 * deals, and every suite that covers it constructs its own fixture. This drives
 * the SAME path the bridge would: `POST /webhooks/mt5/deals`, authenticated with
 * `X-Bridge-Secret`, one deal at a time.
 *
 * ## What it deliberately is NOT
 *
 * It is not a price feed and it does not touch `positions`. That table is empty
 * on purpose (see backend/CLAUDE.md) and `LIVE_REVENUE_FEED` is `'deal'`, so
 * writing positions would model a path that pays nobody. What MT5 actually
 * gives this CRM is DEALS — an opening leg, then a closing leg carrying the
 * charges — and that is what this sends.
 *
 * ## The lifecycle it mimics
 *
 *   OPEN    one deal, entry 0, carrying its share of the commission
 *   ...     the position sits open; each tick re-prices it and reports floating
 *           P/L, which the CRM stores nowhere — by design, it moves every tick
 *   CLOSE   one deal, entry 1, on the SAME positionId, carrying the rest
 *
 * The closing leg is what earns commission (FR-IB-04), and `unconsumedLegs`
 * sums BOTH legs' charges — so splitting the commission across them is the
 * case that matters. A simulator that put every charge on the close would pass
 * while the most common broker configuration silently paid nothing.
 *
 * ## Usage
 *
 *   node scripts/mt5-position-simulator.mjs --logins 5000001,5000002
 *   node scripts/mt5-position-simulator.mjs --ticks 20 --interval 2000
 *   node scripts/mt5-position-simulator.mjs --close-after 5     # close, reopen
 *
 * Every flag has a default; with none it opens five positions across whatever
 * logins it finds, re-prices them every three seconds, and closes each after
 * ten ticks before opening a replacement — so it can be left running.
 */

import { setTimeout as sleep } from 'node:timers/promises';

/* ── Configuration ──────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

const API = flag('api', process.env.API_URL ?? 'http://localhost:3001/v1');
const SECRET = flag(
  'secret',
  process.env.MT5_BRIDGE_SECRET ?? 'dev-only-bridge-secret-not-for-production-use',
);
const POSITIONS = Number(flag('positions', '5'));
const INTERVAL = Number(flag('interval', '3000'));
const CLOSE_AFTER = Number(flag('close-after', '10'));
const MAX_TICKS = Number(flag('ticks', 'Infinity'));
const LOGINS = (flag('logins', '') || '').split(',').filter(Boolean);

const SYMBOLS = [
  { name: 'EURUSD', price: 1.0854, pip: 0.0001, contract: 100_000 },
  { name: 'GBPUSD', price: 1.2712, pip: 0.0001, contract: 100_000 },
  { name: 'XAUUSD', price: 2318.4, pip: 0.1, contract: 100 },
  { name: 'USDJPY', price: 157.32, pip: 0.01, contract: 100_000 },
  { name: 'AUDUSD', price: 0.6634, pip: 0.0001, contract: 100_000 },
];

/*
 * MT5's own numbers, not an enum of ours.
 *
 * `action` 0/1 are BUY/SELL; `entry` 0 is IN and 1 is OUT. The CRM passes both
 * through unmapped because MT5 adds values across builds, and this has to speak
 * the same dialect — sending a friendly string would exercise a translation
 * layer that does not exist in production.
 */
const DEAL_BUY = 0;
const DEAL_SELL = 1;
const ENTRY_IN = 0;
const ENTRY_OUT = 1;

/* ── A tiny deterministic-ish random walk ───────────────────────────────── */

let seed = 20260827;
/** Mulberry32 — seeded so a failing run can be replayed exactly. */
function random() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const money = (n) => n.toFixed(8);
const priceOf = (n, digits) => n.toFixed(digits);

/* ── The wire ───────────────────────────────────────────────────────────── */

let ticket = Date.now() % 1_000_000_000;
const nextTicket = () => String(++ticket);

async function send(deal) {
  const response = await fetch(`${API}/webhooks/mt5/deals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-secret': SECRET },
    body: JSON.stringify(deal),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText} — ${body.slice(0, 300)}`);
  }
  return response.json().catch(() => ({}));
}

/* ── Positions ──────────────────────────────────────────────────────────── */

/**
 * Open a position: ONE deal, entry 0.
 *
 * The opening leg carries HALF the round turn's commission. MT5 lets a broker
 * put the charge all on the open, all on the close, or split it — and the split
 * is the case worth simulating, because `unconsumedLegs` has to find the
 * opening leg and sum it with the close. A simulator charging only on close
 * would never exercise that.
 */
async function open(position) {
  const { symbol, lots, side } = position;
  const digits = symbol.pip === 0.01 ? 3 : symbol.pip === 0.1 ? 2 : 5;

  position.positionId = nextTicket();
  position.openPrice = symbol.price;
  position.openedAt = new Date();
  position.ticks = 0;
  position.openCommission = -(3.5 * lots) / 2;

  await send({
    dealId: nextTicket(),
    login: position.login,
    positionId: position.positionId,
    orderId: nextTicket(),
    symbol: symbol.name,
    action: side === 'buy' ? DEAL_BUY : DEAL_SELL,
    entry: ENTRY_IN,
    volume: money(lots),
    price: priceOf(position.openPrice, digits),
    /* An opening deal has no realised profit — that is what "opening" means. */
    profit: money(0),
    commission: money(position.openCommission),
    swap: money(0),
    comment: 'simulator: open',
    dealtAt: position.openedAt.toISOString(),
  });

  console.log(
    `  OPEN  ${symbol.name.padEnd(6)} ${side.toUpperCase().padEnd(4)} ${lots} lots @ ` +
      `${priceOf(position.openPrice, digits)}  login ${position.login}  pos ${position.positionId}`,
  );
}

/**
 * Re-price an open position and report where it stands.
 *
 * NOTHING IS SENT. Floating P/L is not a deal, and this CRM deliberately stores
 * no unrealised figure anywhere — it changes on every tick, so a stored copy is
 * stale the moment it is written. The tick exists to make the simulation behave
 * like a real book, and to show the operator running it that the position is
 * alive.
 */
function tick(position) {
  const { symbol, lots, side } = position;
  const drift = (random() - 0.5) * symbol.pip * 12;
  symbol.price = Math.max(symbol.pip, symbol.price + drift);
  position.ticks += 1;

  const move = symbol.price - position.openPrice;
  const direction = side === 'buy' ? 1 : -1;
  /*
   * P/L in the ACCOUNT's currency, which is not the same arithmetic for every
   * symbol — and getting it wrong showed: USDJPY reported a 2-lot loss of
   * $12,991 on a 6-pip move, because `price * contract` is yen, not dollars.
   *
   * A quote symbol of USD (EURUSD, XAUUSD) converts at 1. A BASE of USD
   * (USDJPY) earns its P/L in the quote currency, so it divides by the rate.
   * Nothing here is fed to the CRM — it stores no unrealised figure — but a
   * number this wrong on the console makes the simulator untrustworthy for
   * reading, which is most of what it is for.
   */
  const quoteToAccount = symbol.name.startsWith('USD') ? 1 / symbol.price : 1;
  position.floating = move * direction * lots * symbol.contract * quoteToAccount;

  /* Swap accrues while a position is HELD — the other half of broker revenue
     alongside commission, and the reason it is summed with it. */
  position.swap = -0.12 * lots * position.ticks;
  return position;
}

/**
 * Close it: one deal, entry 1, on the SAME positionId.
 *
 * This is the leg that earns commission. FR-IB-04 says commission is computed
 * "on the closing of a deal — never on its opening", and the engine finds the
 * opening leg through `mt5_position_id` to sum the whole round turn's charges.
 */
async function close(position) {
  const { symbol, lots, side } = position;
  const digits = symbol.pip === 0.01 ? 3 : symbol.pip === 0.1 ? 2 : 5;
  const closeCommission = -(3.5 * lots) / 2;

  await send({
    dealId: nextTicket(),
    login: position.login,
    positionId: position.positionId,
    orderId: nextTicket(),
    symbol: symbol.name,
    /* A close is the OPPOSITE action to the open — MT5 reports the deal that
       flattened the position, not the one that created it. */
    action: side === 'buy' ? DEAL_SELL : DEAL_BUY,
    entry: ENTRY_OUT,
    volume: money(lots),
    price: priceOf(symbol.price, digits),
    profit: money(position.floating ?? 0),
    commission: money(closeCommission),
    swap: money(position.swap ?? 0),
    comment: 'simulator: close',
    dealtAt: new Date().toISOString(),
  });

  const revenue = -(position.openCommission + closeCommission) + -(position.swap ?? 0);
  console.log(
    `  CLOSE ${symbol.name.padEnd(6)} pos ${position.positionId}  ` +
      `P/L ${(position.floating ?? 0).toFixed(2).padStart(9)}  ` +
      `broker kept ${revenue.toFixed(2)}  (commission + swap)`,
  );
}

/* ── Which accounts to trade on ─────────────────────────────────────────── */

/**
 * The logins to trade, from `--logins` or discovered from the API.
 *
 * Discovery goes through the same webhook surface rather than the database, so
 * this script needs no connection string and can point at any deployment. When
 * nothing is found it says so and stops, rather than inventing logins — a deal
 * on a login no `trading_accounts` row claims is ORPHANED, which the engine
 * holds unprocessed on purpose, and a simulator that silently generated those
 * would look like it was working while paying nobody.
 */
async function resolveLogins() {
  if (LOGINS.length > 0) return LOGINS;

  console.error(
    'No --logins given.\n' +
      '\n' +
      'This script does not guess: a deal on a login no trading account claims is\n' +
      'ORPHANED, and the engine holds those unprocessed rather than paying them. It\n' +
      'would look like the simulator was working while no commission was earned.\n' +
      '\n' +
      'Find real logins with:\n' +
      '  docker exec pg psql -U app -d appdb -c \\\n' +
      '    \"SELECT login FROM trading_accounts ORDER BY created_at DESC LIMIT 5;\"\n' +
      '\n' +
      'Then:  node scripts/mt5-position-simulator.mjs --logins 5000001,5000002\n',
  );
  process.exit(1);
}

/* ── The loop ───────────────────────────────────────────────────────────── */

async function main() {
  const logins = await resolveLogins();

  console.log(`MT5 position simulator → ${API}`);
  console.log(
    `${POSITIONS} positions across ${logins.length} login(s), a tick every ${INTERVAL}ms, ` +
      `closing after ${CLOSE_AFTER} ticks.\n`,
  );

  const positions = Array.from({ length: POSITIONS }, (_, index) => ({
    login: logins[index % logins.length],
    symbol: { ...SYMBOLS[index % SYMBOLS.length] },
    lots: [0.1, 0.5, 1, 2, 0.25][index % 5],
    side: index % 2 === 0 ? 'buy' : 'sell',
  }));

  console.log('Opening:');
  for (const position of positions) await open(position);

  let ticks = 0;
  /*
   * A clean stop rather than a killed process: Ctrl-C sets the flag and the
   * loop finishes the tick it is on. Half-sending a close leg would leave a
   * position open in the CRM with no way to flatten it from here.
   */
  let running = true;
  process.on('SIGINT', () => {
    console.log('\nStopping after this tick…');
    running = false;
  });

  while (running && ticks < MAX_TICKS) {
    await sleep(INTERVAL);
    ticks += 1;

    const line = positions
      .map((position) => {
        tick(position);
        const digits = position.symbol.pip === 0.01 ? 3 : position.symbol.pip === 0.1 ? 2 : 5;
        return (
          `${position.symbol.name} ${priceOf(position.symbol.price, digits)} ` +
          `(${(position.floating ?? 0) >= 0 ? '+' : ''}${(position.floating ?? 0).toFixed(2)})`
        );
      })
      .join('   ');
    console.log(`tick ${String(ticks).padStart(3)}  ${line}`);

    for (const position of positions) {
      if (position.ticks < CLOSE_AFTER) continue;
      await close(position);
      /* Reopened, so the book stays at `POSITIONS` and the run can be left
         going for as long as somebody wants deals arriving. */
      await open(position);
    }
  }

  console.log('\nClosing every open position before exit:');
  for (const position of positions) await close(position);

  console.log(
    '\nDone. The deals are ingested; commission is calculated by the drain:\n' +
      '  npm run ib:accrue        (or wait for the cron)\n',
  );
}

main().catch((error) => {
  console.error('\nSimulator failed:', error.message);
  process.exit(1);
});
