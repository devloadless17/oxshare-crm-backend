/**
 * Remove trading accounts that were never on MT5.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * A dev database can hold `trading_accounts` rows created before the MT5 bridge
 * existed — fixtures with logins like `MT5-49878`, all marked `live`, all with a
 * balance of zero because there was never an account on the broker's server for
 * them to have a balance on. They are indistinguishable from real accounts on
 * the console, which is the whole problem: an operator sees ten live accounts
 * holding nothing and reasonably concludes the integration is broken.
 *
 * A REAL MT5 login is digits only. That is the test used here, and it is the
 * only reliable one — every fixture prefix ever used is a guess, but "the broker
 * issued this number" is a fact about the shape of the value.
 *
 * ── Why it is a script and not a migration ──────────────────────────────────
 *
 * Migrations run everywhere, including production. This deletes rows on the
 * judgement that they are junk, and that judgement is only safe on a database
 * whose contents somebody can vouch for. Run it deliberately, on a dev box,
 * having read the dry run.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *     node scripts/purge-fake-trading-accounts.mjs            # dry run
 *     node scripts/purge-fake-trading-accounts.mjs --apply    # delete
 *
 * Reads DATABASE_URL from .env, like every other script here.
 */
import 'dotenv/config';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const FAKE = `login IS NOT NULL AND login !~ '^[0-9]+$'`;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const { rows: accounts } = await client.query(`
    SELECT ta.id, ta.login, ta.environment, ta.balance, u.email
    FROM trading_accounts ta JOIN users u ON u.id = ta.user_id
    WHERE ${FAKE} ORDER BY ta.login`);

  if (accounts.length === 0) {
    console.log('No trading accounts with a non-numeric MT5 login. Nothing to do.');
    process.exit(0);
  }

  console.log(`${accounts.length} trading account(s) with a login MT5 never issued:\n`);
  for (const a of accounts) {
    console.log(`   ${a.login.padEnd(12)} ${a.environment.padEnd(5)} balance ${a.balance}  ${a.email}`);
  }

  /*
   * The transfers are the reason a plain DELETE fails, and the reason this
   * script has to be careful rather than clever.
   *
   * A `pending` wallet_to_account transfer is HOLDING money in the client's
   * wallet. Deleting the row without releasing the hold strands that amount:
   * the client can never spend it and nothing is left to explain why. Releasing
   * it is exactly what `TransfersService.fail` does — that service is
   * unreachable from a script, so the same two effects happen below inside one
   * transaction.
   */
  const { rows: transfers } = await client.query(`
    SELECT t.id, t.user_id, t.currency, t.amount, t.state, t.direction
    FROM transfers t JOIN trading_accounts ta ON ta.id = t.trading_account_id
    WHERE ${FAKE} ORDER BY t.created_at`);

  const holding = transfers.filter(
    (t) => t.state === 'pending' && t.direction === 'wallet_to_account',
  );

  console.log(`\n${transfers.length} transfer(s) reference them, ${holding.length} still holding wallet funds:`);
  for (const t of transfers) {
    console.log(`   ${t.state.padEnd(8)} ${t.direction.padEnd(18)} ${t.amount} ${t.currency}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN. Re-run with --apply to release those holds and delete the rows.');
    process.exit(0);
  }

  await client.query('BEGIN');
  try {
    for (const t of holding) {
      await client.query(
        `UPDATE wallets SET on_hold = on_hold - $1::numeric, updated_at = now()
         WHERE user_id = $2 AND currency = $3`,
        [t.amount, t.user_id, t.currency],
      );
    }

    const del = await client.query(
      `DELETE FROM transfers
       WHERE trading_account_id IN (SELECT id FROM trading_accounts WHERE ${FAKE})`,
    );
    const purged = await client.query(`DELETE FROM trading_accounts WHERE ${FAKE}`);

    /*
     * A hold released twice, or against the wrong wallet, shows up as a
     * negative. Checked INSIDE the transaction so it can still be rolled back —
     * a negative balance discovered afterwards is a data-repair job.
     */
    const { rows: bad } = await client.query(
      `SELECT count(*) AS n FROM wallets WHERE on_hold::numeric < 0 OR balance::numeric < 0`,
    );
    if (Number(bad[0].n) > 0) {
      throw new Error(`${bad[0].n} wallet(s) would be left negative — refusing`);
    }

    await client.query('COMMIT');
    console.log(`\nReleased ${holding.length} hold(s).`);
    console.log(`Deleted ${del.rowCount} transfer(s) and ${purged.rowCount} trading account(s).`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\nROLLED BACK, nothing changed:', error.message);
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
