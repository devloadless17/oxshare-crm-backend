/**
 * VOLUME FIXTURES — the trading and partner surface at a size worth soaking.
 *
 * ## Why this is a SCRIPT and not part of `seed.ts`
 *
 * `seed.ts` runs at every boot and is deliberately small: two trading accounts,
 * five deals, three transfers. Those exist to prove the code paths work, and
 * they already earned it — they are what made a dealer adjustment visible on a
 * client's transactions page for the first time.
 *
 * But you cannot soak concurrency, realtime throughput or "does the console stay
 * usable" against five deals, and you must not pay for thousands of inserts on
 * every restart either. So volume is ON DEMAND: run it when you want to soak,
 * never as a side effect of starting the app.
 *
 * ## What Domain 7 actually needs, and why each number
 *
 *   200 accounts   enough that the admin list PAGES rather than fitting on one
 *                  screen, which is where sorting and cursor bugs live
 *   4,000 deals    enough that a 30-day window is a real query rather than a
 *                  handful of rows, and enough to exceed the 500-row cap on
 *                  `/trading/balance-movements` so `truncated` is exercised
 *                  against real data rather than only in a unit test
 *   600 transfers  TERMINAL only — see below
 *   400 accruals   pending AND confirmed, so the commission surface has both
 *
 * ## ⚠️ NO PENDING TRANSFERS, EVER
 *
 * `TransferResumeScheduler` raises TRANSFER_STUCK at severity `page` once a
 * pending transfer passes TRANSFER_STALE_MS, and the alarm counts the BACKLOG
 * rather than the batch — so the resume backoff bounds how often a row is
 * RETRIED, not how often it is RAISED. Six hundred seeded pending transfers
 * would page on every tick for ever. An alarm that is always firing is an alarm
 * nobody reads, and it takes the real ones with it.
 *
 * A fixture that never settles is a permanent incident; a spec that creates one
 * is a test.
 *
 * ## Idempotent, and cheap to check
 *
 * Every row is keyed on a deterministic `vol-` identifier, so a second run adds
 * nothing. It reports what it found rather than what it intended.
 *
 * Usage:
 *   node scripts/seed-volume.mjs           # add volume
 *   node scripts/seed-volume.mjs --count   # report only, write nothing
 */
import 'dotenv/config';
import pg from 'pg';

const ACCOUNTS = 200;
const DEALS_PER_ACCOUNT = 20;
const TRANSFERS = 600;
const ACCRUALS = 400;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Refusing to guess at a database.');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url });
const countOnly = process.argv.includes('--count');

async function counts(db) {
  const { rows } = await db.query(`
    SELECT (SELECT count(*) FROM trading_accounts) AS accounts,
           (SELECT count(*) FROM mt5_deals)        AS deals,
           (SELECT count(*) FROM transfers)        AS transfers,
           (SELECT count(*) FROM ib_accruals)      AS accruals`);
  return rows[0];
}

async function main() {
  const db = await pool.connect();
  try {
    const before = await counts(db);
    console.log('before:', before);
    if (countOnly) return;

    /*
     * Hung off the e2e client, the same containment `seed.ts` uses: if this ever
     * runs against a populated database it touches one seeded identity.
     */
    const { rows: owners } = await db.query(
      `SELECT id FROM users WHERE email = 'e2e@oxshare.com' LIMIT 1`,
    );
    if (owners.length === 0) {
      console.error('No e2e@oxshare.com — start the backend once so seeds run, then re-run.');
      process.exitCode = 2;
      return;
    }
    const userId = owners[0].id;

    const { rows: wallets } = await db.query(
      `SELECT id, currency FROM wallets WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (wallets.length === 0) {
      console.error('That client holds no wallet; nothing to attach transfers to.');
      process.exitCode = 2;
      return;
    }

    // ── accounts ────────────────────────────────────────────────────────────
    // `vol-` logins, so volume rows are greppable and can never collide with
    // the five-digit logins `seed.ts` writes.
    for (let i = 0; i < ACCOUNTS; i += 1) {
      await db.query(
        /*
         * Casts are explicit because `$2` appears in BOTH the SELECT list and
         * the WHERE — without them Postgres cannot deduce one type for the two
         * positions and refuses the statement outright.
         */
        `INSERT INTO trading_accounts (user_id, login, environment, currency, balance, status, name)
         SELECT $1::uuid, $2::varchar, 'live', 'USD', $3::numeric, 'active', $4::varchar
         WHERE NOT EXISTS (SELECT 1 FROM trading_accounts WHERE login = $2::varchar)`,
        [userId, `vol-${i}`, `${1000 + i}.00000000`, `Volume ${i}`],
      );
    }

    // ── deals ───────────────────────────────────────────────────────────────
    // A fifth of them are BALANCE deals, so the dealer-adjustment read has real
    // volume behind it and its 500-row cap is actually reached.
    for (let a = 0; a < ACCOUNTS; a += 1) {
      const values = [];
      const params = [];
      for (let d = 0; d < DEALS_PER_ACCOUNT; d += 1) {
        const n = a * DEALS_PER_ACCOUNT + d;
        const isBalance = d % 5 === 0;
        const base = params.length;
        params.push(
          `vol-${n}`,
          `vol-${a}`,
          isBalance ? 'BALANCE' : 'EURUSD',
          isBalance ? 2 : d % 2,
          isBalance ? 0 : 1,
          isBalance ? '0.00000000' : '1.00000000',
          isBalance ? '0.00000000' : '1.08500000',
          isBalance ? (d % 10 === 0 ? '-25.00000000' : '50.00000000') : '12.34000000',
          new Date(Date.now() - n * 60 * 60 * 1000),
        );
        values.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},'0','0',$${base + 9},'sweep')`,
        );
      }
      await db.query(
        `INSERT INTO mt5_deals
           (mt5_deal_id, login, symbol, action, entry, volume, price, profit,
            commission, swap, dealt_at, source)
         VALUES ${values.join(',')}
         ON CONFLICT (mt5_deal_id) DO NOTHING`,
        params,
      );
    }

    // ── transfers ───────────────────────────────────────────────────────────
    // TERMINAL ONLY. See the warning at the top of this file.
    const { rows: accts } = await db.query(
      `SELECT id FROM trading_accounts WHERE login LIKE 'vol-%' ORDER BY login LIMIT $1`,
      [TRANSFERS],
    );
    for (let i = 0; i < Math.min(TRANSFERS, accts.length); i += 1) {
      const settled = i % 4 !== 0;
      await db.query(
        `INSERT INTO transfers
           (user_id, wallet_id, trading_account_id, direction, amount, currency, state,
            failure_reason, settled_at)
         SELECT $1::uuid, $2::uuid, $3::uuid, $4::transfer_direction, $5::numeric,
                $6::varchar, $7::transfer_state, $8::text, $9::timestamptz
         WHERE NOT EXISTS (
           SELECT 1 FROM transfers
            WHERE trading_account_id = $3::uuid AND amount = $5::numeric
         )`,
        [
          userId,
          wallets[0].id,
          accts[i].id,
          i % 2 === 0 ? 'wallet_to_account' : 'account_to_wallet',
          `${10 + i}.00000000`,
          wallets[0].currency,
          settled ? 'settled' : 'failed',
          settled ? null : 'MT5 refused the transfer: insufficient margin',
          settled ? new Date() : null,
        ],
      );
    }

    const after = await counts(db);
    console.log('after: ', after);
    console.log(
      'added: ',
      Object.fromEntries(Object.keys(after).map((k) => [k, Number(after[k]) - Number(before[k])])),
    );
    console.log(
      `\nNOTE: ib_accruals left at ${after.accruals}. They hang off the commission engine's own\n` +
        'shapes and belong with whoever owns it — this script does not invent partner money.',
    );
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
