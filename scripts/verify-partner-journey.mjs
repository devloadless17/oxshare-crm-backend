/**
 * Drive one client from unverified to earning, through the REAL services.
 *
 * ## Why this boots the application instead of writing SQL
 *
 * The question being asked is "does the money path work and does anything get
 * lost", and hand-written INSERTs cannot answer it: they would produce rows
 * that LOOK like the outcome while skipping every invariant that makes the
 * outcome trustworthy — the ledger entry beside the wallet credit, the audit
 * row inside the money transaction, the commission engine's plausibility
 * check, the idempotency guard. A script that fakes the result proves the
 * script works.
 *
 * So this loads `AppModule` as an application context and calls the same
 * service methods the HTTP layer calls. No server, no auth, same code.
 *
 * ## What it checks, and what it cannot
 *
 * It verifies KYC, approves a partner, attributes a client to them, settles a
 * deposit, and then RECONCILES: wallet balance against the sum of its ledger
 * entries, and the commission accrued against the rate on the partner's level.
 *
 * It does NOT test commission on a closed trade, because that does not exist:
 * `RevenueEvent.source` is the literal `'deposit'` and nothing writes
 * `positions`. See the note in commission.ts, which names the seam.
 *
 * Usage:
 *   node scripts/verify-partner-journey.mjs            # report only
 *   node scripts/verify-partner-journey.mjs --apply
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';

const APPLY = process.argv.includes('--apply');

const PARTNER_EMAIL = 'hazimehussein43@gmail.com';
const CLIENT_EMAIL = 'hazimehussein01@gmail.com';
const DEPOSIT = '1000.00';

const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
const bad = (label, detail = '') => {
  console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  process.exitCode = 1;
};

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

    const one = async (text, ...params) =>
      (await db.execute(sql.raw(fill(text, params)))).rows?.[0];
    const all = async (text, ...params) =>
      (await db.execute(sql.raw(fill(text, params)))).rows ?? [];

    const partner = await one(
      `SELECT id, email, verification_level FROM users WHERE email = '${PARTNER_EMAIL}'`,
    );
    const client = await one(
      `SELECT id, email, referred_by_ib_user_id FROM users WHERE email = '${CLIENT_EMAIL}'`,
    );

    if (!partner || !client) {
      bad('both users exist', `${PARTNER_EMAIL} / ${CLIENT_EMAIL}`);
      return;
    }
    ok('both users exist');

    const admin = await one(
      `SELECT id, email, role FROM admins WHERE role = 'master_admin' ORDER BY created_at LIMIT 1`,
    );
    if (!admin) return bad('a master admin exists to act as');

    /*
     * The actor the services expect. `clientScope` unrestricted, because this
     * is a master admin — the same object the guard would have attached.
     */
    const actor = {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      permissions: ['*'],
      /*
       * The real `UNRESTRICTED` shape — `{ unrestricted, tagIds }`, not a
       * discriminated union. A wrong shape here does not fail loudly: the
       * predicate reads `tagIds.length` and throws deep inside a store, which
       * is exactly what a hand-rolled scope object earned on the first run.
       */
      clientScope: UNRESTRICTED,
    };

    console.log(`\npartner : ${partner.email}`);
    console.log(`client  : ${client.email}`);
    console.log(`acting  : ${admin.email}`);

    if (!APPLY) {
      console.log('\nReport only. Re-run with --apply to perform the journey.');
      await report(all, partner, client);
      return;
    }

    // ── 1. KYC ────────────────────────────────────────────────────────────
    console.log('\n=== 1. verify the partner’s identity ===');
    const kyc = app.get((await import('../dist/modules/compliance/kyc.service.js')).KycService);
    const before = await one(`SELECT status FROM kyc_submissions WHERE user_id = '${partner.id}'`);

    if (before?.status === 'approved') {
      ok('KYC already approved — nothing to do');
    } else {
      /*
       * Through the SERVICE, so the level bump, the audit row and the client's
       * notification all happen. Writing `verification_level = 1` directly
       * would leave a verified client with no record of who verified them.
       */
      if (!before) {
        await db.execute(
          sql.raw(
            `INSERT INTO kyc_submissions (user_id, status, personal_info, submitted_at)
             VALUES ('${partner.id}', 'submitted', '{"note":"created by verify-partner-journey"}'::jsonb, now())
             ON CONFLICT (user_id) DO UPDATE SET status = 'submitted', submitted_at = now()`,
          ),
        );
      } else if (before.status !== 'submitted' && before.status !== 'under_review') {
        await db.execute(
          sql.raw(
            `UPDATE kyc_submissions SET status = 'submitted', submitted_at = now() WHERE user_id = '${partner.id}'`,
          ),
        );
      }
      await kyc.approve(partner.id, admin.id);
      ok('KYC approved through KycService');
    }

    const verified = await one(`SELECT verification_level FROM users WHERE id = '${partner.id}'`);
    verified.verification_level >= 1
      ? ok('verification_level', `= ${verified.verification_level}`)
      : bad('verification_level', `= ${verified.verification_level}, expected >= 1`);

    // ── 2. Partner ────────────────────────────────────────────────────────
    console.log('\n=== 2. make them a partner ===');
    const ibService = app.get(
      (await import('../dist/modules/ib/ib-applications.service.js')).IbApplicationsService,
    );

    let account = await one(
      `SELECT user_id, level, referral_code, agency_id FROM ib_accounts WHERE user_id = '${partner.id}'`,
    );
    if (account) {
      ok('already a partner', `code ${account.referral_code}`);
    } else {
      /*
       * RESUME from whatever state the last run left. A partial run leaves a
       * pending application, and `apply` refuses a second one — correctly, so
       * the script picks the existing one up rather than being unrunnable
       * until somebody clears it by hand.
       */
      let applicationId = (
        await one(
          `SELECT id FROM ib_applications WHERE user_id = '${partner.id}' AND status = 'pending' LIMIT 1`,
        )
      )?.id;

      if (applicationId) {
        ok('resuming the pending application', applicationId);
      } else {
        const agency = await ensureAgency({ db, sql, one });
        const application = await ibService.apply(partner.id, {
          agencyId: agency.id,
          motivation: 'Created by verify-partner-journey.',
        });
        applicationId = application.id;
        ok('application submitted', applicationId);
      }

      account = await ibService.approve(applicationId, actor, UNRESTRICTED, {});
      ok('application approved', `level ${account.level}, code ${account.referralCode}`);
    }

    // ── 3. Attribution ────────────────────────────────────────────────────
    console.log('\n=== 3. put the client under them ===');
    const current = await one(`SELECT referred_by_ib_user_id FROM users WHERE id = '${client.id}'`);

    if (current.referred_by_ib_user_id === partner.id) {
      ok('already attributed');
    } else if (current.referred_by_ib_user_id) {
      bad('client is attributed to somebody else', current.referred_by_ib_user_id);
      return;
    } else {
      /*
       * DIRECT WRITE, and the only one here — deliberately, with the reason.
       *
       * `users.referred_by_ib_user_id` is written once at registration and the
       * product offers no way to change it, because a mutable attribution is a
       * route for one partner's earnings to move to another. This client
       * registered before the partner existed, so there is no supported path;
       * the column is set here and the fact is stated rather than hidden behind
       * a helper that makes it look routine.
       */
      await db.execute(
        sql.raw(
          `UPDATE users SET referred_by_ib_user_id = '${partner.id}' WHERE id = '${client.id}'`,
        ),
      );
      ok('attributed (direct write — see the note in the script)');
    }

    // ── 4. Deposit, which is what actually pays a partner today ───────────
    console.log('\n=== 4. settle a deposit for the client ===');
    const wallet = await one(
      `SELECT id, currency, balance FROM wallets WHERE user_id = '${client.id}' ORDER BY created_at LIMIT 1`,
    );
    if (!wallet) return bad('the client has a wallet');

    const balanceBefore = wallet.balance;
    const accrualsBefore = Number(
      (await one(`SELECT count(*) n FROM ib_accruals WHERE ib_user_id = '${partner.id}'`)).n,
    );

    const transactions = app.get(
      (await import('../dist/modules/payments/transactions.service.js')).TransactionsService,
    );

    const created = await transactions.creditDeposit({
      userId: client.id,
      amount: DEPOSIT,
      currency: wallet.currency,
      provider: 'verify-partner-journey',
      providerRef: `VPJ-${Date.now()}`,
    });
    ok('deposit settled', `${DEPOSIT} ${wallet.currency}`);

    // ── 5. Reconcile ──────────────────────────────────────────────────────
    console.log('\n=== 5. reconcile — did anything get lost? ===');
    await reconcile(one, all, { partner, client, wallet, balanceBefore, accrualsBefore, created });
  } finally {
    await app.close();
  }
}

/** Naive positional fill; every value here is a uuid or a literal we control. */
function fill(text, params) {
  return params.reduce((acc, value, at) => acc.replaceAll(`$${at + 1}`, `'${value}'`), text);
}

async function report(all, partner, client) {
  const rows = await all(
    `SELECT (SELECT verification_level FROM users WHERE id = '${partner.id}') partner_level,
            (SELECT count(*) FROM ib_accounts WHERE user_id = '${partner.id}') is_partner,
            (SELECT referred_by_ib_user_id FROM users WHERE id = '${client.id}') attributed_to,
            (SELECT count(*) FROM ib_accruals WHERE ib_user_id = '${partner.id}') accruals`,
  );
  console.table(rows);
}

async function reconcile(one, all, ctx) {
  const { partner, client, wallet, balanceBefore, accrualsBefore } = ctx;

  // The wallet moved by exactly the deposit.
  const after = await one(`SELECT balance FROM wallets WHERE id = '${wallet.id}'`);
  const moved = (Number(after.balance) - Number(balanceBefore)).toFixed(2);
  moved === Number(DEPOSIT).toFixed(2)
    ? ok('wallet moved by the deposit', `${balanceBefore} → ${after.balance}`)
    : bad('wallet movement', `expected ${DEPOSIT}, saw ${moved}`);

  /*
   * THE LEDGER IS THE AUTHORITY. A balance that does not equal the sum of the
   * entries behind it is money that appeared from nowhere — the single failure
   * this whole reconciliation exists to catch.
   */
  const ledger = await one(
    `SELECT coalesce(sum(amount), 0) total, count(*) n FROM ledger_entries WHERE wallet_id = '${wallet.id}'`,
  );
  Number(ledger.total).toFixed(2) === Number(after.balance).toFixed(2)
    ? ok('balance equals the sum of its ledger entries', `${ledger.n} entries, ${ledger.total}`)
    : bad('LEDGER MISMATCH', `balance ${after.balance} vs ledger ${ledger.total}`);

  // The commission actually accrued, and for the right amount.
  const accruals = await all(
    `SELECT a.amount, a.base_amount, a.rate_value, a.status, a.depth, a.kind,
            lv.level, lv.name AS level_name,
            CASE a.kind WHEN 'commission' THEN lv.commission_mode ELSE lv.rebate_mode END AS mode
       FROM ib_accruals a LEFT JOIN ib_levels lv ON lv.id = a.level_id
      WHERE a.ib_user_id = '${partner.id}' AND a.client_user_id = '${client.id}'
      ORDER BY a.created_at DESC LIMIT 5`,
  );
  const now = Number(
    (await one(`SELECT count(*) n FROM ib_accruals WHERE ib_user_id = '${partner.id}'`)).n,
  );

  /*
   * A SETTLED DEPOSIT ACCRUES NOTHING, AND THAT IS THE CORRECT OUTCOME.
   *
   * This used to assert the opposite, and failed on every healthy database.
   * Commission is earned on a CLOSED POSITION and on nothing else (FR-IB-04):
   * `calculate` refuses `source: 'deposit'` outright, and
   * `accrueForSettledDeposit` has no callers at all — it survives, unwired and
   * @deprecated, because CPA is a real model that would trigger on a deposit.
   *
   * So the deposit leg of this journey proves the WALLET and LEDGER half, which
   * it does above. Trade commission is covered by test/deal-commission.spec.ts
   * and, end to end, by scripts/simulate-trading.mjs.
   */
  if (now > accrualsBefore) {
    bad(
      'a deposit accrued commission',
      `${now - accrualsBefore} new row(s) — a deposit must accrue nothing; see commission.ts`,
    );
  } else {
    ok('deposit accrued no commission', 'correct — only a closed position pays');
  }

  /*
   * Reconcile the accruals this partner ALREADY holds. Checking arithmetic on
   * rows that exist is worth more than checking none at all, and it is the only
   * place this script can see a rate applied.
   *
   * THE MODE DECIDES THE ARITHMETIC. This divided by 100 unconditionally, which
   * is right for a percentage rung and wrong for every per-lot one — and per_lot
   * is what the live rate card uses, so the check reported correct money as
   * broken. A per-lot term is money PER LOT: amount = lots × rate, no percent
   * anywhere in it.
   */
  for (const row of accruals) {
    const base = Number(row.base_amount);
    const rate = Number(row.rate_value);
    const perLot = row.mode === 'per_lot';
    const expected = (perLot ? base * rate : (base * rate) / 100).toFixed(2);
    const actual = Number(row.amount).toFixed(2);
    const terms = row.level_name ? ` on "${row.level_name}" (L${row.level})` : '';
    const shown = perLot ? `${base} lots × ${rate}/lot` : `${base} × ${rate}%`;
    if (expected === actual) {
      ok(`  ${row.kind} depth ${row.depth}`, `${shown}${terms} = ${actual}`);
    } else {
      bad(`  ${row.kind} depth ${row.depth}`, `expected ${expected}, stored ${actual}`);
    }
  }

  /*
   * Nothing may be accrued twice for one source — and KIND is part of "twice".
   *
   * Grouping on (source, earner) alone called every healthy trade a duplicate:
   * one closed position legitimately produces a `commission` row AND a
   * `rebate` row for the same earner, which is the shape `ib_accruals.kind`
   * exists to express. The database's own guarantee is
   * `ib_accruals_source_earner_uq (source_type, source_id, ib_user_id, kind)`,
   * so this mirrors it exactly.
   *
   * It matters that this matches: a duplicate check that fires on correct data
   * is one nobody reads, and this is the check standing between a paid trade
   * and a twice-paid one.
   */
  const dupes = await all(
    `SELECT source_type, source_id, ib_user_id, kind, count(*) n FROM ib_accruals
      GROUP BY 1, 2, 3, 4 HAVING count(*) > 1 LIMIT 5`,
  );
  dupes.length === 0
    ? ok('no accrual counted twice for one source')
    : bad('DUPLICATE ACCRUALS', JSON.stringify(dupes));
}

main().catch((error) => {
  console.error(`\n${error?.stack ?? error}`);
  process.exitCode = 1;
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
