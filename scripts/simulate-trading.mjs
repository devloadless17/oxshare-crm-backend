/**
 * Open, move and close positions for about a minute, through the real service.
 *
 * ## What this is for
 *
 * There is no deal feed yet — the MT5 Web API this broker granted exposes no
 * pump mode, so nothing streams trades in. Without a feed, `positions` stays
 * empty, no trade ever closes, and the commission engine has nothing to pay on.
 * This stands in for the feed so the rest of the chain can be watched working
 * end to end: a trade closes, the broker's revenue is computed, the partner
 * accrues, and the payout job credits their wallet.
 *
 * ## It calls `PositionsService.close`, not the database
 *
 * That method is where closing a position and paying the partner are welded
 * together, on purpose: anything that can close a position without accruing is
 * a silent underpayment. Writing the rows here would skip exactly the thing
 * being tested — and would prove only that this script can write rows.
 *
 * ## The numbers are DERIVED, not random
 *
 * Same reason the load seeder derives its dates: a run that differs each time
 * makes "did commission change because of my code or because of the dice"
 * unanswerable. Volume, price and commission come from the tick index.
 *
 * Usage:
 *   node scripts/simulate-trading.mjs                        # report only
 *   node scripts/simulate-trading.mjs --apply
 *   node scripts/simulate-trading.mjs --apply --seconds 120 --client someone@example.com
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const arg = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const APPLY = has('--apply');
const SECONDS = Number.parseInt(arg('--seconds', '60'), 10);
const CLIENT = arg('--client', 'hazimehussein01@gmail.com');

/** One tick a second: slow enough to watch, fast enough to finish. */
const TICK_MS = 1_000;
const SYMBOLS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'USDJPY'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const money = (value) => value.toFixed(8);

async function main() {
  process.env.NODE_ENV ??= 'development';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const { DRIZZLE_DB } = await import('../dist/database/database.module.js');
    const { PositionsService } = await import('../dist/modules/trading/positions.service.js');
    const { sql } = await import('drizzle-orm');

    const db = app.get(DRIZZLE_DB);
    const service = app.get(PositionsService);
    const query = async (text) => (await db.execute(sql.raw(text))).rows ?? [];

    const [client] = await query(`SELECT id, email FROM users WHERE email = '${CLIENT}'`);
    if (!client) {
      console.log(`No client ${CLIENT}.`);
      return;
    }

    const accounts = await query(
      `SELECT id, currency FROM trading_accounts WHERE user_id = '${client.id}' ORDER BY created_at LIMIT 1`,
    );
    if (accounts.length === 0) {
      console.log(`${CLIENT} has no trading account — open one first, or the positions have`);
      console.log('nowhere to hang and the commission has no client to attribute to.');
      return;
    }
    const account = accounts[0];

    const [partner] = await query(
      `SELECT p.email FROM users c JOIN users p ON p.id = c.referred_by_ib_user_id WHERE c.id = '${client.id}'`,
    );

    console.log(`client   : ${client.email}`);
    console.log(`account  : ${account.id} (${account.currency})`);
    console.log(`partner  : ${partner?.email ?? 'none — nobody will earn'}`);
    console.log(`duration : ${SECONDS}s, one tick a second`);

    if (!APPLY) {
      console.log('\nDry run. Re-run with --apply to trade.');
      return;
    }

    const open = [];
    let opened = 0;
    let closed = 0;
    const started = Date.now();

    console.log('\n=== trading ===');
    for (let tick = 0; Date.now() - started < SECONDS * 1_000; tick += 1) {
      /*
       * Three things happen on a tick, and the ORDER matters: close before
       * opening, so a position always lives at least a couple of ticks and the
       * "update" step has something to move. Opening first would let a position
       * open and close on the same tick, which is not a trade anyone recognises.
       */
      if (open.length >= 3 || (open.length > 0 && tick % 3 === 0)) {
        const position = open.shift();
        const commission = -(3 + (tick % 5)); // charged TO the client, so negative
        const swap = -(tick % 2);
        const row = await service.close(position.id, {
          closePrice: money(position.price * (1 + ((tick % 7) - 3) / 1000)),
          profit: money((tick % 11) - 5),
          swap: money(swap),
          commission: money(commission),
        });
        closed += 1;
        console.log(
          `  t+${tick}s  CLOSE ${row.ticket} ${row.symbol}  ` +
            `commission ${commission} swap ${swap}  -> broker kept ${Math.abs(commission) + Math.abs(swap)}`,
        );
      }

      if (open.length > 0) {
        const position = open[0];
        await service.update(position.id, { profit: money((tick % 13) - 6) });
      }

      if (open.length < 3) {
        const symbol = SYMBOLS[tick % SYMBOLS.length];
        const price = 1 + (tick % 100) / 100;
        const row = await service.open({
          userId: client.id,
          tradingAccountId: account.id,
          ticket: `SIM-${started}-${tick}`,
          symbol,
          side: tick % 2 === 0 ? 'buy' : 'sell',
          // Lots, which is what a per_lot level is paid on.
          volume: money(0.1 * (1 + (tick % 5))),
          openPrice: money(price),
          currency: account.currency,
        });
        open.push({ id: row.id, price });
        opened += 1;
        console.log(`  t+${tick}s  OPEN  ${row.ticket} ${symbol} ${row.volume} lots`);
      }

      await sleep(TICK_MS);
    }

    // Everything still open is closed, so the run leaves no half-finished trade.
    for (const position of open) {
      await service.close(position.id, {
        closePrice: money(position.price),
        profit: '0.00000000',
        swap: '0.00000000',
        commission: '-4.00000000',
      });
      closed += 1;
    }

    console.log(`\nopened ${opened}, closed ${closed}`);

    const [totals] = await query(
      `SELECT count(*) n, coalesce(sum(amount), 0) total
         FROM ib_accruals
        WHERE client_user_id = '${client.id}' AND source_type = 'position'`,
    );
    console.log(`commission accrued on trades: ${totals.n} row(s), ${totals.total}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(`\n${error?.stack ?? error}`);
  process.exitCode = 1;
});
