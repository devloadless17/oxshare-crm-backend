/**
 * Mark a client as KYC verified, for local testing.
 *
 * ── This is a DEVELOPMENT shortcut and it skips real machinery ──────────────
 *
 * The honest path is the KYC queue: the client submits documents, a reviewer
 * with `kyc.review` approves them, and that writes an audit row naming who
 * decided and when. This writes `verification_level` directly and records
 * nothing, so on any database whose history matters it is the wrong tool.
 *
 * It exists because `verification_level >= 1` gates the money endpoints —
 * transfers, withdrawals, opening a live account — and getting a test client
 * past that gate should not require uploading a passport scan.
 *
 * It REFUSES to run against a database that looks like production, on the
 * simple test that a production database has more than a handful of clients.
 * That is a blunt instrument and deliberately so: the failure it prevents is
 * somebody marking a real client verified with no reviewer and no audit trail.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *     node scripts/verify-client.mjs someone@example.com            # dry run
 *     node scripts/verify-client.mjs someone@example.com --apply
 */
import 'dotenv/config';
import pg from 'pg';

const email = process.argv[2];
const APPLY = process.argv.includes('--apply');

if (!email || email.startsWith('--')) {
  console.error('Usage: node scripts/verify-client.mjs <email> [--apply]');
  process.exit(1);
}

/** Above this many clients, assume it is not a dev box and refuse. */
const DEV_CLIENT_CEILING = 100;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const { rows: counted } = await client.query('SELECT count(*)::int AS n FROM users');
  if (counted[0].n > DEV_CLIENT_CEILING) {
    console.error(
      `This database holds ${counted[0].n} clients, which does not look like a dev box.\n` +
        'Refusing: use the KYC review queue, which records who approved what.',
    );
    process.exit(1);
  }

  const { rows } = await client.query(
    `SELECT id, email, verification_level, email_verified, status FROM users WHERE email = $1`,
    [email],
  );

  const user = rows[0];
  if (!user) {
    console.error(`No client with email ${email}.`);
    process.exit(1);
  }

  console.log(`  ${user.email}`);
  console.log(`    verification_level : ${user.verification_level ?? 0}`);
  console.log(`    email_verified     : ${user.email_verified}`);
  console.log(`    status             : ${user.status}`);

  /*
   * Worth saying, because it is the more common reason a client cannot reach
   * these screens. `/trading/*`, `/wallet/*` and the payments routes sit behind
   * EmailVerifiedGuard, which runs BEFORE any KYC check — so a client with an
   * unverified address gets a 403 that has nothing to do with KYC, and raising
   * verification_level will not move them one step closer.
   */
  if (!user.email_verified) {
    console.log(
      '\n  NOTE: this address is not verified. EmailVerifiedGuard runs before the KYC check,\n' +
        '  so this client will still be refused. Verify the address as well.',
    );
  }

  if ((user.verification_level ?? 0) >= 1) {
    console.log('\nAlready verified. Nothing to do.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\nDRY RUN. Re-run with --apply to set verification_level to 1.');
    process.exit(0);
  }

  await client.query(
    // No `updated_at` on this table — unlike most others here, `users` does not
    // carry one, and naming it fails the whole statement.
    `UPDATE users SET verification_level = 1 WHERE id = $1`,
    [user.id],
  );
  console.log('\nverification_level set to 1. No audit row was written — see the note above.');
} finally {
  await client.end();
}
