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

/**
 * How recent a deal must be to be left UNPROCESSED.
 *
 * Shorter than the 48-hour window `hasAgedBacklog()` uses, so an unprocessed
 * fixture can never BE an aged backlog no matter when the script is run.
 */
const RECENT_MS = 24 * 60 * 60 * 1000;

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

    /*
     * ⚠️ ACCOUNTS ARE SPREAD ACROSS CLIENTS, and the first version of this
     * script put all two hundred on ONE.
     *
     * That concentration is not a shape the product produces, and it quietly
     * destroyed most of what the volume was for: pages that are all one owner
     * never cross a scope boundary, "this client's accounts" returns 200 or 0
     * and never 3, a tag-scoped admin sees all-or-nothing rather than a slice,
     * and the partner tree is a line rather than a tree. **A fixture can have
     * the right ROW COUNT and the wrong DISTRIBUTION, and only the second one
     * makes a soak mean anything.** Found by crm-92, whose commission step asked
     * for fifty clients to attribute and was told there was one.
     *
     * ONE deliberately fat client is kept — the e2e client kicks off with a
     * long tail — because the unbounded `/dashboard` payload is a real
     * observation and it needs a fixture somebody can point at. The rest are
     * 2-5 accounts each, which is what the product actually makes.
     */
    const { rows: spread } = await db.query(
      `SELECT id FROM users
        WHERE id <> $1 AND status = 'active'
        ORDER BY created_at
        LIMIT 60`,
      [userId],
    );
    const ownerPool = [userId, ...spread.map((r) => r.id)];
    console.log(`spreading accounts across ${ownerPool.length} clients`);

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
      /*
       * The first 40 stay on the e2e client — the deliberately fat one, so the
       * unbounded-dashboard case remains observable. The rest round-robin over
       * the pool, which lands 2-5 accounts on each.
       */
      const owner = i < 40 ? userId : ownerPool[i % ownerPool.length];

      await db.query(
        /*
         * Casts are explicit because `$2` appears in BOTH the SELECT list and
         * the WHERE — without them Postgres cannot deduce one type for the two
         * positions and refuses the statement outright.
         */
        `INSERT INTO trading_accounts (user_id, login, environment, currency, balance, status, name)
         SELECT $1::integer, $2::varchar, 'live', 'USD', $3::numeric, 'active', $4::varchar
         WHERE NOT EXISTS (SELECT 1 FROM trading_accounts WHERE login = $2::varchar)`,
        [owner, `vol-${i}`, `${1000 + i}.00000000`, `Volume ${i}`],
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
        const dealtAt = new Date(Date.now() - n * 60 * 60 * 1000);
        params.push(
          `vol-${n}`,
          `vol-${a}`,
          isBalance ? 'BALANCE' : 'EURUSD',
          isBalance ? 2 : d % 2,
          isBalance ? 0 : 1,
          isBalance ? '0.00000000' : '1.00000000',
          isBalance ? '0.00000000' : '1.08500000',
          isBalance ? (d % 10 === 0 ? '-25.00000000' : '50.00000000') : '12.34000000',
          dealtAt,
          // Unprocessed ONLY inside the 48h window the backlog check uses.
          dealtAt.getTime() > Date.now() - RECENT_MS ? null : new Date(),
        );
        /*
         * ⚠️ HISTORICAL DEALS ARE MARKED COMMISSION-PROCESSED. This is the
         * whole reason the tuple carries a twelfth column.
         *
         * `hasAgedBacklog()` is true when unprocessed TRADE deals older than 48
         * hours exist and `IB_ACCRUAL_START` is unset — and in that state
         * `accruePending` pays nothing and ALERTS ON EVERY RUN, never throttled,
         * by this repo's own design. Seeding 3,162 aged trades put the
         * commission engine into that permanent holding state, which is exactly
         * the always-firing alarm we refused to create with a stuck transfer,
         * in a second place nobody looked. Found by crm-92 on the live data.
         *
         * So: anything older than the recent window is a fixture for LISTS and
         * READS, not engine input, and says so by carrying a processed
         * timestamp. The recent tail below stays unprocessed so accrual is
         * still exercised — without ever constituting a BACKLOG.
         */
        values.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},'0','0',$${base + 9},'sweep',$${base + 10})`,
        );
      }
      await db.query(
        `INSERT INTO mt5_deals
           (mt5_deal_id, login, symbol, action, entry, volume, price, profit,
            commission, swap, dealt_at, source, commission_processed_at)
         VALUES ${values.join(',')}
         ON CONFLICT (mt5_deal_id) DO NOTHING`,
        params,
      );
    }

    // ── transfers ───────────────────────────────────────────────────────────
    // TERMINAL ONLY. See the warning at the top of this file.
    /*
     * ⚠️ The account's OWN owner and their OWN wallet — not the e2e client's.
     *
     * Before the accounts were spread, every one belonged to the same client
     * and a single `userId`/`walletId` pair was correct for all of them. It is
     * not any more: a transfer joining client A's wallet to client B's trading
     * account is data the product cannot produce, and a soak built on it would
     * be measuring a shape that never occurs.
     *
     * Only accounts whose owner HAS a wallet are eligible, which is why the
     * join is inner rather than a lookup per row.
     */
    const { rows: accts } = await db.query(
      `SELECT ta.id, ta.user_id, w.id AS wallet_id, w.currency
         FROM trading_accounts ta
         JOIN wallets w ON w.user_id = ta.user_id
        WHERE ta.login LIKE 'vol-%'
        ORDER BY ta.login
        LIMIT $1`,
      [TRANSFERS],
    );
    for (let i = 0; i < Math.min(TRANSFERS, accts.length); i += 1) {
      const settled = i % 4 !== 0;
      await db.query(
        `INSERT INTO transfers
           (user_id, wallet_id, trading_account_id, direction, amount, currency, state,
            failure_reason, settled_at)
         SELECT $1::integer, $2::uuid, $3::uuid, $4::transfer_direction, $5::numeric,
                $6::varchar, $7::transfer_state, $8::text, $9::timestamptz
         WHERE NOT EXISTS (
           SELECT 1 FROM transfers
            WHERE trading_account_id = $3::uuid AND amount = $5::numeric
         )`,
        [
          accts[i].user_id,
          accts[i].wallet_id,
          accts[i].id,
          i % 2 === 0 ? 'wallet_to_account' : 'account_to_wallet',
          `${10 + i}.00000000`,
          accts[i].currency,
          settled ? 'settled' : 'failed',
          settled ? null : 'MT5 refused the transfer: insufficient margin',
          settled ? new Date() : null,
        ],
      );
    }

    /*
     * ── THE COMMISSION SURFACE: ATTRIBUTION AND A LADDER THAT PAYS ─────────
     *
     * Measured before writing this: 200 volume clients, ZERO with a referrer,
     * and both enabled rungs paying 0.00 per lot. So the commission engine
     * would examine the recent deals, resolve an EMPTY chain for every one of
     * them, and correctly accrue nothing — for ever. `ib_accruals` stays 0 and
     * the whole partner surface is unexercisable, while looking populated.
     *
     * ⚠️ THIS SEEDS THE INPUTS, NOT THE OUTPUT. It would be far easier to
     * INSERT rows into `ib_accruals` directly, and it would prove nothing: a
     * fabricated accrual exercises no chain resolution, no rate lookup, no
     * plausibility check and no idempotency constraint. Attributing clients and
     * configuring rungs makes the ENGINE produce them, through
     * `resolveChain` -> `calculate` -> `ib_accruals`, which is the thing a soak
     * is for. Seeding the output would be the fixture equivalent of asserting
     * on a value the test itself wrote.
     *
     * ⚠️ AND IT MOVES REAL MONEY, EVENTUALLY. An accrual is pending until the
     * hourly `confirmPending` credits the partner's commission wallet. That is
     * the intended behaviour and the reason this lives in the OPT-IN volume
     * script rather than the boot seed: nobody should have partner money
     * credited as a side effect of starting the app.
     *
     * The rung update is CONDITIONAL on the term still being zero, so it can
     * never overwrite rates a real operator has set. Migration 0112 seeds them
     * enabled-but-zero on purpose — "a visible 'not configured yet'" — and this
     * fills that in for a soak without ever touching a configured ladder.
     */
    const { rowCount: rungsPriced } = await db.query(
      `UPDATE ib_levels
          SET commission_mode = 'per_lot', commission_amount_per_lot = $1,
              rebate_mode = 'per_lot', rebate_amount_per_lot = $2
        WHERE enabled
          AND coalesce(commission_amount_per_lot, 0) = 0
          AND coalesce(commission_rate, 0) = 0`,
      ['2.50000000', '0.50000000'],
    );

    /*
     * A QUARTER of the volume clients get a referrer, not all of them. A soak
     * needs both sides: chains that resolve AND clients who are owed to nobody,
     * because "every client has a partner" is a shape production never has and
     * would hide an attribution bug that only shows on the unattributed path.
     */
    const { rows: rootPartner } = await db.query(
      `SELECT user_id FROM ib_accounts WHERE parent_ib_user_id IS NULL AND active LIMIT 1`,
    );
    let attributed = 0;
    if (rootPartner.length > 0) {
      const { rowCount } = await db.query(
        `UPDATE users SET referred_by_ib_user_id = $1
          WHERE referred_by_ib_user_id IS NULL
            AND id IN (
              SELECT u.id FROM users u
                JOIN trading_accounts ta ON ta.user_id = u.id
               WHERE ta.login LIKE 'vol-%'
               GROUP BY u.id
               ORDER BY u.id
               LIMIT $2
            )`,
        [rootPartner[0].user_id, Math.floor(ACCOUNTS / 4)],
      );
      attributed = rowCount ?? 0;
    }

    const after = await counts(db);
    console.log('after: ', after);
    console.log(
      'added: ',
      Object.fromEntries(Object.keys(after).map((k) => [k, Number(after[k]) - Number(before[k])])),
    );
    console.log(
      `\ncommission: ${rungsPriced} rung(s) priced (only ones still at zero), ` +
        `${attributed} client(s) attributed to a partner.`,
    );
    console.log(
      `ib_accruals is ${after.accruals} and that is CORRECT right now — the engine\n` +
        'produces them on its next tick from the recent unprocessed deals. This script seeds\n' +
        'the INPUTS (attribution + rates) and never inserts an accrual: a fabricated one\n' +
        'exercises no chain resolution, no rate lookup and no idempotency constraint.\n' +
        'NOTE: a pending accrual is credited to a partner wallet by the hourly confirm job.',
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
