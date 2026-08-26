/**
 * A two-rung partner tree with clients and open trades beneath it.
 *
 * ## What it builds
 *
 *   hazimehussein43@gmail.com   level 1, already a partner
 *     └── hazimehsen1@gmail.com level 2, created here
 *           ├── client … ── trading account ── open positions
 *           ├── client … ── trading account ── open positions
 *           └── client … ── trading account ── open positions
 *
 * The clients hang off the LEVEL 2 partner, which is what makes the partner
 * dashboard show anything: `clientPositionsFor` reads positions belonging to
 * DIRECT referrals (`users.referred_by_ib_user_id`), so trades on the level 1
 * partner's own clients would leave hazimehsen1's screen empty.
 *
 * ## Why it goes through the services
 *
 * The same reason `verify-partner-journey.mjs` does, and it is not ceremony:
 * hand-written INSERTs produce rows that LOOK like a registered client while
 * skipping the wallet provisioning, the referral resolution, the KYC level bump
 * and the audit rows that make the state trustworthy. A fixture that fakes the
 * outcome is a fixture you cannot debug against.
 *
 * Two things are still written directly, each because the product genuinely
 * offers no path:
 *
 *  - TRADING ACCOUNTS. `Mt5AccountsService.open` calls `assertBridge()` and
 *    there is no MT5 bridge in dev. `seed-load-test.mjs` writes CRM rows the
 *    same way and says so.
 *  - POSITIONS. Nothing in this codebase writes them; see the note at the top
 *    of `simulate-positions.mjs`.
 *
 * ## Everything it writes is MARKED and removable
 *
 * Logins are `TREE-…` and tickets are `SIM-…`. Both are alphabetic where a real
 * MT5 value is numeric, so neither can collide with a live feed. `--purge`
 * removes exactly what this script created, and `simulate-positions.mjs --purge`
 * already removes the positions on its own.
 *
 * A DISTINCT login prefix from `seed-load-test.mjs`'s `SEED-` on purpose: that
 * script's own `--purge` deletes `SEED-%`, and a tree that vanished whenever
 * somebody cleared load-test data would be a confusing thing to debug.
 *
 * ## It is idempotent
 *
 * Every step checks for its own result first, so a partial run resumes rather
 * than duplicating. Re-running it is the supported way to top the tree up.
 *
 * Usage:
 *   node scripts/seed-partner-tree.mjs                      # report only
 *   node scripts/seed-partner-tree.mjs --apply
 *   node scripts/seed-partner-tree.mjs --apply --clients 5 --positions 3
 *   node scripts/seed-partner-tree.mjs --purge
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const arg = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const APPLY = has('--apply');
const PURGE = has('--purge');
const CLIENTS = Number.parseInt(arg('--clients', '3'), 10);
const POSITIONS = Number.parseInt(arg('--positions', '2'), 10);

const PARENT_EMAIL = 'hazimehussein43@gmail.com';
const PARTNER_EMAIL = 'hazimehsen1@gmail.com';
const PASSWORD = '12345678';

/**
 * Extra named clients to place under the partner, comma-separated.
 *
 * The generated `…-clientN` addresses are fine for filling a table, but a real
 * account somebody signs into needs a name they chose. Passed rather than
 * hard-coded so this stays a tool instead of a list that grows a line per
 * request.
 */
const NAMED_CLIENTS = arg('--client', '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

/** The clients under the new partner. Stable addresses, so re-runs resume. */
const CLIENT_EMAILS = (count) => [
  ...Array.from({ length: count }, (_, at) => `hazimehsen1-client${at + 1}@gmail.com`),
  ...NAMED_CLIENTS,
];

const LOGIN_PREFIX = 'TREE-';
const TICKET_PREFIX = 'SIM-';

/*
 * Instruments with a plausible price, matching `simulate-positions.mjs` so the
 * rows this writes are indistinguishable from the ones it ticks.
 */
const SYMBOLS = [
  { symbol: 'EURUSD', price: 1.085, digits: 5 },
  { symbol: 'GBPUSD', price: 1.271, digits: 5 },
  { symbol: 'XAUUSD', price: 2338.4, digits: 2 },
  { symbol: 'USDJPY', price: 157.42, digits: 3 },
];

const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? `  ${detail}` : ''}`);
const bad = (label, detail = '') => {
  console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  process.exitCode = 1;
};
const money = (value, dp) => Number(value).toFixed(dp);

async function main() {
  process.env.NODE_ENV ??= 'development';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const { DRIZZLE_DB } = await import('../dist/database/database.module.js');
    const db = app.get(DRIZZLE_DB);
    const { sql } = await import('drizzle-orm');
    const { UNRESTRICTED } = await import('../dist/common/security/client-scope.js');

    /*
     * Parameterised through drizzle's tagged template, NOT string-interpolated.
     * `verify-partner-journey.mjs` interpolates because every value it passes is
     * a uuid it just read; this script passes e-mail addresses and symbols, and
     * a fixture that concatenates those is a habit worth not forming.
     */
    const all = async (strings, ...values) =>
      (await db.execute(sql(strings, ...values))).rows ?? [];
    const one = async (strings, ...values) => (await all(strings, ...values))[0];

    if (PURGE) {
      await purge(db, sql);
      return;
    }

    const parent = await one`SELECT id, email FROM users WHERE email = ${PARENT_EMAIL}`;
    if (!parent) return bad('the parent partner exists', PARENT_EMAIL);

    const parentAccount =
      await one`SELECT user_id, level, referral_code, agency_id FROM ib_accounts WHERE user_id = ${parent.id}`;
    if (!parentAccount) return bad('the parent is a partner', PARENT_EMAIL);
    ok('parent partner', `${PARENT_EMAIL} — code ${parentAccount.referral_code}`);

    /*
     * There is no longer a rung to check for beneath the parent. `ib_levels`
     * bounded the hierarchy platform-wide and 0102 removed it, so nesting a
     * partner under another is always structurally possible — how far earnings
     * travel is the tier count on each earner's own programme.
     *
     * What IS worth reporting is the terms the parent is on, because that is
     * what decides whether they earn anything from the sub-tree this builds.
     */
    const parentTerms = await one`
      SELECT p.name, count(t.depth)::int AS depth
        FROM ib_programs p
        LEFT JOIN ib_program_tiers t ON t.program_id = p.id
       WHERE p.id = ${parentAccount.program_id}
       GROUP BY p.name`;
    if (!parentTerms || parentTerms.depth < 2) {
      ok(
        'note',
        `the parent is on "${parentTerms?.name ?? 'unknown'}", which reaches ` +
          `${parentTerms?.depth ?? 0} level(s) — they will earn nothing from the sub-partners ` +
          'below unless that programme gains a depth-2 tier',
      );
    } else {
      ok('parent terms', `${parentTerms.name}, reaching ${parentTerms.depth} level(s)`);
    }

    if (!APPLY) {
      console.log('\nReport only. Re-run with --apply to build the tree.');
      await report(all);
      return;
    }

    const admin =
      await one`SELECT id, email, role FROM admins WHERE role = 'master_admin' ORDER BY created_at LIMIT 1`;
    if (!admin) return bad('a master admin exists to act as');

    /* The real `UNRESTRICTED` shape — a hand-rolled scope throws deep in a store. */
    const actor = {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      permissions: ['*'],
      clientScope: UNRESTRICTED,
    };

    const auth = app.get((await import('../dist/modules/identity/auth.service.js')).AuthService);
    const kyc = app.get((await import('../dist/modules/compliance/kyc.service.js')).KycService);
    const ib = app.get(
      (await import('../dist/modules/ib/ib-applications.service.js')).IbApplicationsService,
    );

    /*
     * An agency, before anything applies. Required on both apply and approve
     * now — a partner without one would have clients offered the entire
     * catalogue — so this has to exist before step 2 rather than being
     * discovered there.
     */
    const agency = await ensureAgency({ db, sql, one });
    ok('agency', `${agency.name}`);

    // ── 1. The new partner ────────────────────────────────────────────────
    console.log('\n=== 1. create hazimehsen1 and verify them ===');
    const partnerId = await ensureVerifiedUser(
      { db, sql, one, auth, kyc, admin },
      {
        email: PARTNER_EMAIL,
        firstName: 'Hazime',
        lastName: 'Hsen',
        referralCode: parentAccount.referral_code,
      },
    );

    // ── 2. Appoint them beneath the parent ────────────────────────────────
    console.log('\n=== 2. appoint them under the parent ===');
    let account =
      await one`SELECT user_id, level, referral_code FROM ib_accounts WHERE user_id = ${partnerId}`;

    if (account) {
      ok('already a partner', `level ${account.level}, code ${account.referral_code}`);
    } else {
      /* Resume a half-finished run rather than being unrunnable until somebody
         clears the pending row by hand — `apply` refuses a second one. */
      let applicationId = (
        await one`SELECT id FROM ib_applications WHERE user_id = ${partnerId} AND status = 'pending' LIMIT 1`
      )?.id;

      if (applicationId) {
        ok('resuming the pending application', applicationId);
      } else {
        applicationId = (
          await ib.apply(partnerId, {
            agencyId: agency.id,
            motivation: 'Created by seed-partner-tree.',
          })
        ).id;
        ok('application submitted', applicationId);
      }

      /*
       * The LEVEL is left to the service. Passing `parentIbUserId` alone makes
       * `resolveLevel` derive "one enabled rung below the parent", which is the
       * rule this tree is meant to demonstrate — pinning `level: 2` here would
       * hard-code today's ladder into a fixture and quietly stop agreeing with
       * it the day a rung is inserted.
       */
      account = await ib.approve(applicationId, actor, UNRESTRICTED, {
        agencyId: agency.id,
        parentIbUserId: parentAccount.user_id,
      });
      ok('approved', `level ${account.level}, code ${account.referralCode}`);
    }

    const partnerCode = account.referral_code ?? account.referralCode;
    const partnerLevel = account.level;

    // ── 3. Clients beneath them, each with a trade ────────────────────────
    console.log(`\n=== 3. ${CLIENTS} client(s) under them, with open positions ===`);

    for (const [at, email] of CLIENT_EMAILS(CLIENTS).entries()) {
      /*
       * A NAMED client keeps its own address as its display name rather than
       * being labelled "Client Hsen 4" — it is an account somebody signs into,
       * and the generated numbering is only meaningful for the generated ones.
       */
      const named = NAMED_CLIENTS.includes(email);
      const clientId = await ensureVerifiedUser(
        { db, sql, one, auth, kyc, admin },
        {
          email,
          firstName: named ? (email.split('@')[0] ?? 'Client') : 'Client',
          lastName: named ? 'Client' : `Hsen ${at + 1}`,
          referralCode: partnerCode,
        },
      );

      const attributed = await one`SELECT referred_by_ib_user_id FROM users WHERE id = ${clientId}`;
      if (attributed.referred_by_ib_user_id !== partnerId) {
        /*
         * DIRECT WRITE, and the only one on a user row here.
         *
         * `referred_by_ib_user_id` is written once at registration from the
         * referral code and the product offers no way to change it — a mutable
         * attribution is a route for one partner's earnings to move to another.
         * This only fires for a client that already existed from an earlier run
         * before the partner did; a freshly registered one arrives correct.
         */
        await db.execute(
          sql`UPDATE users SET referred_by_ib_user_id = ${partnerId} WHERE id = ${clientId}`,
        );
        ok(`${email} attributed (direct write — see the note)`);
      }

      const accountId = await ensureTradingAccount({ db, sql, one }, clientId, at);
      const opened = await ensurePositions({ db, sql, one }, clientId, accountId, at);
      ok(
        email,
        `account ${LOGIN_PREFIX}${String(at + 1).padStart(4, '0')} · ${opened} open position(s)`,
      );
    }

    const refloated = await refloatOpenPositions({ db, sql, all });
    ok('floating P/L refreshed', `${refloated} open position(s)`);

    console.log('\n=== the tree ===');
    await report(all);

    console.log(
      `\nSign in as ${PARTNER_EMAIL} / ${PASSWORD} — level ${partnerLevel}, code ${partnerCode}.`,
    );
    console.log(
      `Their clients are ineligible to become partners: level ${partnerLevel} is the deepest enabled rung.`,
    );
  } finally {
    await app.close();
  }
}

/**
 * A registered, e-mail-verified, KYC-approved user — through the real services.
 *
 * Each of the three steps checks its own outcome first, so this is safe to call
 * for somebody who already exists at any stage of the journey.
 */
async function ensureVerifiedUser({ db, sql, one, auth, kyc, admin }, input) {
  let user =
    await one`SELECT id, email, email_verified, verification_level FROM users WHERE email = ${input.email}`;

  if (!user) {
    /*
     * `register` and not an INSERT: it resolves the referral code to the
     * partner, provisions a wallet in every enabled currency, and hashes the
     * password the way a real signup does. The verification e-mail it sends
     * fails harmlessly — `EmailService.send` swallows and logs.
     */
    await auth.register({
      email: input.email,
      password: PASSWORD,
      firstName: input.firstName,
      lastName: input.lastName,
      referralCode: input.referralCode,
    });
    user =
      await one`SELECT id, email, email_verified, verification_level FROM users WHERE email = ${input.email}`;
    if (!user) throw new Error(`register() did not create ${input.email}`);
    ok('registered', input.email);
  }

  if (!user.email_verified) {
    /*
     * Through the token the registration just minted, so the same code path a
     * client's click takes. Writing `email_verified = true` would leave the
     * token live and the account in a state the real flow never produces.
     */
    const token = (await one`SELECT email_verification_token AS t FROM users WHERE id = ${user.id}`)
      ?.t;
    if (token) await auth.verifyEmail(token);
    else await db.execute(sql`UPDATE users SET email_verified = true WHERE id = ${user.id}`);
    ok('e-mail verified', input.email);
  }

  if ((user.verification_level ?? 0) < 1) {
    /*
     * A submission has to EXIST before it can be approved, and nothing in a
     * fixture submits one. The row is created directly and then decided through
     * `KycService.approve`, which is what bumps the level, writes the audit row
     * and notifies the client.
     */
    const submission = await one`SELECT status FROM kyc_submissions WHERE user_id = ${user.id}`;
    if (!submission) {
      await db.execute(sql`
        INSERT INTO kyc_submissions (user_id, status, personal_info, submitted_at)
        VALUES (${user.id}, 'submitted', ${JSON.stringify({ note: 'created by seed-partner-tree' })}::jsonb, now())
        ON CONFLICT (user_id) DO UPDATE SET status = 'submitted', submitted_at = now()`);
    } else if (submission.status !== 'submitted' && submission.status !== 'under_review') {
      await db.execute(
        sql`UPDATE kyc_submissions SET status = 'submitted', submitted_at = now() WHERE user_id = ${user.id}`,
      );
    }
    await kyc.approve(user.id, admin.id);
    ok('KYC approved', input.email);
  }

  return user.id;
}

/** A CRM-side trading account. The bridge is never called — see the header. */
async function ensureTradingAccount({ db, sql, one }, userId, at) {
  const login = `${LOGIN_PREFIX}${String(at + 1).padStart(4, '0')}`;

  const existing = await one`SELECT id FROM trading_accounts WHERE login = ${login}`;
  if (existing) return existing.id;

  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO trading_accounts
      (id, user_id, login, mt5_group, environment, currency, balance, leverage, status, created_at)
    VALUES (${id}, ${userId}, ${login}, 'tree\\live\\standard', 'live', 'USD',
            ${money(5000 + at * 1500, 2)}, 200, 'active', now())`);
  return id;
}

/**
 * Open positions on an account, up to `--positions`.
 *
 * Counts what is already open rather than inserting blindly: the unique index
 * on (account, ticket) would refuse a duplicate, but a re-run should top the
 * account up to the requested number, not fail.
 */
async function ensurePositions({ db, sql, one }, userId, tradingAccountId, at) {
  const open =
    await one`SELECT count(*)::int AS n FROM positions WHERE trading_account_id = ${tradingAccountId} AND status = 'open'`;
  let have = open?.n ?? 0;

  for (let index = have; index < POSITIONS; index += 1) {
    const instrument = SYMBOLS[(at + index) % SYMBOLS.length];
    const side = (at + index) % 2 === 0 ? 'buy' : 'sell';
    const volume = 0.1 * (1 + ((at + index) % 5));
    /* Drifted a little off the reference price so the rows are not identical. */
    const openPrice = instrument.price * (1 + ((index % 3) - 1) * 0.0015);

    await db.execute(sql`
      INSERT INTO positions
        (id, user_id, trading_account_id, ticket, symbol, side, volume, open_price,
         profit, swap, commission, currency, status, opened_at)
      VALUES (${randomUUID()}, ${userId}, ${tradingAccountId},
              ${`${TICKET_PREFIX}${Date.now()}${at}${index}`},
              ${instrument.symbol}, ${side}, ${money(volume, 2)},
              ${money(openPrice, instrument.digits)},
              ${floatingFor(volume, at + index)},
              '0', ${money(volume * 3.5, 2)}, 'USD', 'open', now())`);
    have += 1;
  }

  return have;
}

/**
 * The FLOATING result on an open trade — `positions.profit` while status is
 * 'open'.
 *
 * ## Why this is not zero, and why zero looked like a bug
 *
 * The column's own docblock calls `profit` "the REALISED result, written only at
 * close", which is true of a CLOSED row. While a position is open the same
 * column carries the unrealised figure — that is what `simulate-positions.mjs`
 * ticks, and what the partner screen labels "Floating".
 *
 * This script wrote `'0'`, so every row on that table read `0.00000000` in a
 * column headed Floating: a whole book of trades sitting at exactly break-even,
 * which is not a number any real feed produces and reads as the field being
 * unwired rather than as a fixture that never set it.
 *
 * ## Deterministic, and SIGNED
 *
 * Derived from the position's size and index rather than randomised, so a
 * re-run of the same fixture produces the same table and a screenshot stays
 * comparable. Roughly half are negative on purpose: a partner's clients lose
 * money, the commission is owed either way, and a table of uniformly green
 * numbers is a fixture nobody would trust.
 */
function floatingFor(volume, seed) {
  const magnitude = volume * 100 * (1 + (seed % 4)) + (seed % 7) * 1.37;
  return money(seed % 2 === 0 ? magnitude : -magnitude, 8);
}

/**
 * Re-float every OPEN position on the tree.
 *
 * Separate from the insert above because the rows this repairs already exist:
 * a fixture seeded before `floatingFor` was written is sitting at exactly zero,
 * and nothing else would ever move it — there is no price feed in dev, and
 * `simulate-positions.mjs` only touches tickets it opened itself in that run.
 *
 * Scoped to `status = 'open'`, so a CLOSED row's realised profit is never
 * rewritten. That figure settled against a balance and is not this script's to
 * revise.
 */
async function refloatOpenPositions({ db, sql, all }) {
  const open = await all`
    SELECT p.id, p.volume
      FROM positions p
      JOIN trading_accounts ta ON ta.id = p.trading_account_id
     WHERE ta.login LIKE ${`${LOGIN_PREFIX}%`} AND p.status = 'open'
     ORDER BY p.ticket`;

  for (const [at, row] of open.entries()) {
    await db.execute(
      sql`UPDATE positions SET profit = ${floatingFor(Number(row.volume), at)}, updated_at = now()
           WHERE id = ${row.id}`,
    );
  }
  return open.length;
}

/** Everything this script created, removed in foreign-key order. */
async function purge(db, sql) {
  console.log('=== purge ===');

  const positions = await db.execute(sql`
    DELETE FROM positions
     WHERE trading_account_id IN (SELECT id FROM trading_accounts WHERE login LIKE ${`${LOGIN_PREFIX}%`})`);
  console.log(`  positions        ${positions.rowCount ?? 0}`);

  const accounts = await db.execute(
    sql`DELETE FROM trading_accounts WHERE login LIKE ${`${LOGIN_PREFIX}%`}`,
  );
  console.log(`  trading accounts ${accounts.rowCount ?? 0}`);

  /*
   * The USERS are left alone, deliberately.
   *
   * They carry wallets, ledger entries, a KYC submission and an ib_account, and
   * `users.id` is `onDelete: 'restrict'` from most of them — so removing them is
   * a cascade this script has no business performing silently. Clear them by
   * hand if you mean to.
   */
  console.log('  users, wallets and partner rows left in place — see the note in purge()');
}

/** The tree as it stands, whether or not this run changed anything. */
async function report(all) {
  const rows = await all`
    SELECT parent.email                       AS parent_email,
           child.email                        AS partner_email,
           account.level                      AS level,
           account.referral_code              AS code,
           (SELECT count(*) FROM users c WHERE c.referred_by_ib_user_id = account.user_id) AS clients,
           (SELECT count(*) FROM positions p
              JOIN users c ON c.id = p.user_id
             WHERE c.referred_by_ib_user_id = account.user_id AND p.status = 'open')       AS open_positions
      FROM ib_accounts account
      JOIN users child  ON child.id  = account.user_id
      LEFT JOIN users parent ON parent.id = account.parent_ib_user_id
     ORDER BY account.level, child.email`;

  for (const row of rows) {
    const under = row.parent_email ? ` under ${row.parent_email}` : ' (top of a chain)';
    console.log(
      `  L${row.level}  ${row.partner_email}${under}\n` +
        `        code ${row.code} · ${row.clients} client(s) · ${row.open_positions} open position(s)`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * The agency to appoint partners under, created if the platform has none.
 *
 * An agency is REQUIRED on both apply and approve now — a partner without one
 * would have clients offered the entire catalogue — so a fixture that omits it
 * fails at the first application. Reuses an enabled agency when one exists
 * rather than adding a second every run.
 */
async function ensureAgency({ db, sql, one }) {
  const existing =
    await one`SELECT id, name FROM agencies WHERE enabled = true ORDER BY sort_order, name LIMIT 1`;
  if (existing) return existing;

  const created = await one`
    INSERT INTO agencies (name, description, enabled)
    VALUES ('Default Agency', 'Created by a seeding script — an agency is required to appoint a partner.', true)
    RETURNING id, name`;
  return created;
}
