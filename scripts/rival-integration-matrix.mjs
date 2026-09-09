/**
 * The Rival + Whish integration, closed out: every amount that crosses the wire,
 * to the cent, in both directions.
 *
 *   node scripts/rival-integration-matrix.mjs
 *
 * NOT in CI — it needs the whole stack up (docs/RUNNING-LOCALLY.md) and it drives
 * BOTH systems, reading Rival's own database to check what it recorded rather
 * than trusting what the CRM believes it sent.
 *
 * ## What this covers that the other scripts do not
 *
 * `rival-flow-matrix` owns the STATE MACHINE (rejections, replays, disagreements)
 * and `rival-underfunded-payout` owns the empty-wallet path. Both check states.
 * Neither checks ARITHMETIC, and arithmetic is where a money integration fails
 * quietly: a state machine bug shows up as a stuck row somebody notices, while a
 * rounding bug pays the wrong amount and reconciles perfectly afterwards.
 *
 * So this file asks one question in many forms: **is the number the same
 * everywhere it appears?** The client's debit, the row at Rival, the fee, the
 * company wallet movement, the ledger, and the refund.
 *
 * ## Why it reads Rival's database directly
 *
 * The CRM's view of a payout is a claim. Rival's row is the fact. Checking the
 * CRM against itself would pass on a system that never sent anything at all.
 *
 * ## Money comparison
 *
 * BigInt over the decimal STRINGS, scaled to 8 places — never `Number()`.
 * §6.1 forbids the coercion everywhere else, and a fee comparison is exactly
 * where a float rounds the discrepancy away to nothing. `rival-flow-matrix`
 * carried that bug for months and passed while testing the wrong rule.
 */
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

loadEnv();

const CRM = process.env.SMOKE_CRM ?? 'http://localhost:3001/v1';
const RIVAL_API = process.env.RIVAL_API ?? 'http://localhost:4001/v1';
const COMPANY = process.env.RIVAL_COMPANY_ID ?? '6ff18a2b-5d47-4ae7-a9c0-3d82ef7d522a';
const RIVAL_DB =
  process.env.RIVAL_DATABASE_URL ??
  'postgres://txn_app:txn_app_dev_password@localhost:5444/txn_system';

/* ── money: strings and BigInt, never a float ─────────────────────────────── */
const SCALE = 8n;
function scaled(s) {
  const [whole, frac = ''] = String(s ?? '0').replace('+', '').split('.');
  const neg = whole.startsWith('-');
  const w = neg ? whole.slice(1) : whole;
  const v = BigInt((w || '0') + (frac + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE)));
  return neg ? -v : v;
}
const fmt = (v) => {
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(9, '0');
  return `${neg ? '-' : ''}${a.slice(0, -8)}.${a.slice(-8)}`;
};
const eqM = (a, b) => scaled(a) === scaled(b);
const subM = (a, b) => fmt(scaled(a) - scaled(b));
const addM = (a, b) => fmt(scaled(a) + scaled(b));
/** Percent of an amount, rounded HALF-UP at 2dp — Rival's observed rule. */
function pctHalfUp(amount, percent) {
  const raw = (scaled(amount) * BigInt(Math.round(percent * 100))) / 10000n; // still 8dp
  const cents = raw / 1000000n;
  const rem = raw % 1000000n;
  const rounded = rem >= 500000n ? cents + 1n : cents;
  return fmt(rounded * 1000000n);
}

/* ── harness ──────────────────────────────────────────────────────────────── */
function jarOf() {
  const j = new Map();
  return {
    ck: () => [...j].map(([k, v]) => `${k}=${v}`).join('; '),
    csrf: (k) => j.get(`oxshare_crm_${k}_csrf`) ?? '',
    absorb(r) {
      for (const raw of r.headers.getSetCookie?.() ?? []) {
        const [p, ...a] = raw.split(';');
        const i = p.indexOf('=');
        if (i <= 0) continue;
        const n = p.slice(0, i).trim();
        const v = p.slice(i + 1).trim();
        const dead = a.some((x) => {
          const [k, y] = x.split('=').map((z) => z.trim().toLowerCase());
          if (k === 'max-age') return Number(y) <= 0;
          if (k === 'expires') return new Date(y).getTime() <= Date.now();
          return false;
        });
        if (dead || !v) j.delete(n);
        else j.set(n, v);
      }
    },
  };
}
const mk = (base, kind) => {
  const jar = jarOf();
  return {
    jar,
    call: async (path, init = {}) => {
      const r = await fetch(base + path, {
        ...init,
        headers: {
          cookie: jar.ck(),
          ...(kind === 'rival'
            ? { 'x-csrf-token': jar.ck().match(/(?:^|; )csrf-token=([^;]*)/)?.[1] ?? '' }
            : { 'x-oxshare-csrf': jar.csrf(kind) }),
          origin:
            kind === 'admin'
              ? 'http://localhost:3002'
              : kind === 'rival'
                ? 'http://localhost:4000'
                : 'http://localhost:3000',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        redirect: 'manual',
      });
      jar.absorb(r);
      const t = await r.text();
      let b;
      try {
        b = JSON.parse(t);
      } catch {
        b = t;
      }
      return { status: r.status, body: b?.data ?? b, raw: b };
    },
  };
};
const idem = () => ({ 'idempotency-key': randomUUID() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, detail = '') {
  pass += 1;
  console.log(`      ✔ ${name}${detail ? ` = ${detail}` : ''}`);
}
function bad(name, detail = '') {
  fail += 1;
  failures.push(name);
  console.log(`      ✖ ${name}${detail ? ` — ${detail}` : ''}`);
}
const check = (c, n, d = '') => (c ? ok(n, d) : bad(n, d));
const eqCheck = (name, actual, expected) =>
  eqM(actual, expected)
    ? ok(name, String(actual))
    : bad(name, `expected ${expected}, got ${actual}`);
const section = (n, t) => console.log(`\n── ${n}. ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const rdb = new pg.Client({ connectionString: RIVAL_DB });
await db.connect();
await rdb.connect();

const portal = mk(CRM, 'portal');
const admin = mk(CRM, 'admin');
const rival = mk(RIVAL_API, 'rival');

console.log('\nRival + Whish integration matrix — every amount, to the cent');
console.log(`CRM ${CRM}   Rival ${RIVAL_API}`);

await portal.call('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'client@oxshare.com', password: 'client123' }),
});
await admin.call('/admin/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'admin@oxshare.com', password: 'admin123' }),
});
await rival.call('/auth/login', {
  method: 'POST',
  body: JSON.stringify({
    email: process.env.RIVAL_SUPER_EMAIL ?? 'admin@example.com',
    password: process.env.RIVAL_SUPER_PASSWORD ?? 'loadless',
  }),
});
const userId = (await portal.call('/auth/me')).body?.id;

const balance = async () => {
  const w = await portal.call('/wallet');
  return (w.body ?? []).find((x) => x.currency === 'USD')?.balance ?? '0';
};
const companyAvailable = async () =>
  (
    await rdb.query(
      `SELECT available_balance FROM wallets WHERE company_id = $1 AND currency = 'USD'`,
      [COMPANY],
    )
  ).rows[0].available_balance;

/** Make sure the client and the company can both afford what follows. */
async function ensureFunds(clientNeed, companyNeed) {
  if (scaled(await balance()) < scaled(clientNeed)) {
    await admin.call('/admin/wallets/credit', {
      method: 'POST',
      headers: idem(),
      body: JSON.stringify({
        userId,
        currency: 'USD',
        amount: clientNeed,
        reason: 'integration matrix',
      }),
    });
  }
  if (scaled(await companyAvailable()) < scaled(companyNeed)) {
    await rival.call('/admin/loads', {
      method: 'POST',
      body: JSON.stringify({
        companyId: COMPANY,
        amount: companyNeed,
        currency: 'USD',
        notes: 'integration matrix top-up',
        payout: { method: 'CASH', recipientName: 'OxShare CRM', recipientPhone: '+96170123456' },
        externalReference: `matrix-${Date.now()}`,
      }),
    });
  }
}

const created = [];
async function requestWithdrawal(amount) {
  const r = await portal.call('/payments/withdrawals', {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({ amount, currency: 'USD', methodKey: 'whish', destination: '+96170123456' }),
  });
  if (r.status < 400) created.push(r.body.id);
  return r;
}
async function approveAndAwait(txId) {
  await admin.call(`/admin/withdrawals/${txId}/approve`, {
    method: 'PATCH',
    headers: idem(),
    body: JSON.stringify({}),
  });
  for (let i = 0; i < 14; i += 1) {
    await sleep(1100);
    const q = await admin.call('/admin/withdrawals?limit=40');
    const row = (q.body?.items ?? []).find((x) => x.id === txId);
    if (row?.rivalWithdrawalId || row?.rivalNeedsAttention) return row;
  }
  return null;
}
const rivalRow = async (id) =>
  (await rdb.query(`SELECT amount, fee_amount, net_amount, fee_application, status
                      FROM withdrawals WHERE id = $1`, [id])).rows[0];

await ensureFunds('20000', '8000');

/* ═══ A. the door refuses what the rail cannot settle ═════════════════════ */
section('A', 'Decimal discipline — Rival settles to 2 places');
for (const amt of ['50.123456789', '50.001', '50.005', '10.999']) {
  const r = await requestWithdrawal(amt);
  check(
    r.status === 400 && /2 decimal places/i.test(String(r.body?.message)),
    `withdrawal ${amt} refused`,
    r.status === 400 ? String(r.body?.message).slice(0, 60) : `got ${r.status}`,
  );
}
for (const amt of ['25.123456789', '25.001']) {
  const r = await portal.call('/payments/deposits', {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({ amount: amt, currency: 'USD', method: 'whish' }),
  });
  check(
    r.status === 400 && /2 decimal places/i.test(String(r.body?.message)),
    `deposit ${amt} refused`,
    r.status === 400 ? String(r.body?.message).slice(0, 60) : `got ${r.status}`,
  );
}
// Everything the currency CAN express must still go through — the guard must not
// become "round numbers only". Cents are money.
for (const amt of ['12.34', '12.3', '12', '12.30000000']) {
  const r = await requestWithdrawal(amt);
  check(r.status === 201, `withdrawal ${amt} accepted`, r.status === 201 ? '201' : String(r.body?.message).slice(0, 50));
}

/* ═══ B. the number that crosses the wire is the number debited ═══════════ */
section('B', 'The amount is IDENTICAL on both sides');
const AMOUNTS = ['10.00', '10.01', '99.99', '100.00', '100.01', '123.45', '999.99', '1000.01'];
for (const amt of AMOUNTS) {
  const before = await balance();
  const req = await requestWithdrawal(amt);
  if (req.status >= 400) {
    bad(`${amt} requested`, `${req.status} ${String(req.body?.message).slice(0, 50)}`);
    continue;
  }
  const afterDebit = await balance();
  eqCheck(`${amt} debited from the client exactly`, subM(before, afterDebit), amt);

  const row = await approveAndAwait(req.body.id);
  if (!row?.rivalWithdrawalId) {
    bad(`${amt} reached Rival`, row?.rivalAttentionReason ?? 'never submitted');
    continue;
  }
  const rv = await rivalRow(row.rivalWithdrawalId);
  eqCheck(`${amt} recorded at Rival`, rv.amount, amt);
  eqCheck(`${amt} NET to the client (never short)`, rv.net_amount, amt);
}

/* ═══ C. the fee, computed from first principles ══════════════════════════ */
section('C', 'Fee arithmetic — ON_TOP, so OxShare pays it, not the client');
for (const amt of ['10.00', '99.99', '100.00', '100.01', '100.99', '123.45']) {
  const expectedFee = scaled(amt) < scaled('100') ? '1.00' : pctHalfUp(amt, 5);
  const companyBefore = await companyAvailable();
  const req = await requestWithdrawal(amt);
  if (req.status >= 400) {
    bad(`${amt} requested`, String(req.body?.message).slice(0, 50));
    continue;
  }
  const row = await approveAndAwait(req.body.id);
  if (!row?.rivalWithdrawalId) {
    bad(`${amt} reached Rival`, row?.rivalAttentionReason ?? 'never submitted');
    continue;
  }
  const rv = await rivalRow(row.rivalWithdrawalId);
  eqCheck(`${amt} fee`, rv.fee_amount, expectedFee);
  check(rv.fee_application === 'ON_TOP', `${amt} fee is ON_TOP`, rv.fee_application);
  // The company wallet is what actually pays: amount + fee, to the cent.
  const companyAfter = await companyAvailable();
  eqCheck(
    `${amt} company wallet moved by amount + fee`,
    subM(companyBefore, companyAfter),
    addM(amt, expectedFee),
  );
}

/* ═══ D. deposits — credited exactly what was asked for ═══════════════════ */
section('D', 'Deposits — the link, the credit and the ledger agree');
for (const amt of ['15.00', '15.01', '250.75']) {
  const dep = await portal.call('/payments/deposits', {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({ amount: amt, currency: 'USD', method: 'whish' }),
  });
  if (dep.status >= 400) {
    bad(`deposit ${amt} created`, `${dep.status} ${String(dep.body?.message).slice(0, 50)}`);
    continue;
  }
  const ref = dep.body.providerRef ?? dep.body.reference;
  const local = (
    await db.query(`SELECT amount, rival_external_id, state FROM transactions WHERE id = $1`, [
      dep.body.id,
    ])
  ).rows[0];
  eqCheck(`deposit ${amt} recorded locally`, local.amount, amt);
  if (!local.rival_external_id) {
    bad(`deposit ${amt} reached Rival`, 'no externalId');
    continue;
  }
  const wp = (
    await rdb.query(`SELECT amount, currency, status FROM whish_payments WHERE external_id = $1`, [
      local.rival_external_id,
    ])
  ).rows[0];
  eqCheck(`deposit ${amt} link amount at Rival`, wp.amount, amt);
  check(wp.currency === 'USD', `deposit ${amt} currency`, wp.currency);

  /*
   * Now SETTLE it and check the credit, which is the half that actually moves
   * money and the half nothing else here covers.
   *
   * The payment is marked PAID in Rival's own `whish_payments` row rather than
   * paid at Whish, because paying for real needs a human with a phone. What
   * that simulates is precisely and only "the provider says this was paid" —
   * the CRM then re-asks Rival through its ordinary `checkPayment` path and
   * credits on the answer, so every step AFTER the provider is the real one:
   * the amount cross-check, the wallet credit, the ledger row, the idempotency.
   *
   * Being explicit because it matters when reading a green run: this proves the
   * CRM's arithmetic and settlement, NOT that Whish collects correctly.
   */
  const balBefore = await balance();
  await rdb.query(
    `UPDATE whish_payments SET status = 'PAID', paid_at = now() WHERE external_id = $1`,
    [local.rival_external_id],
  );
  const settle = await portal.call(
    `/payments/deposits/${encodeURIComponent(ref)}/settle?method=whish`,
    { method: 'POST', headers: idem(), body: JSON.stringify({}) },
  );
  check(settle.status < 400, `deposit ${amt} settled`, `${settle.status} ${settle.body?.state ?? ''}`);
  eqCheck(`deposit ${amt} CREDITED exactly`, subM(await balance(), balBefore), amt);

  const legs = (
    await db.query(
      `SELECT entry_type, amount FROM ledger_entries WHERE reference_id = $1`,
      [dep.body.id],
    )
  ).rows;
  check(
    legs.length === 1 && legs[0].entry_type === 'deposit' && eqM(legs[0].amount, amt),
    `deposit ${amt} wrote ONE deposit ledger row`,
    `${legs.length} legs`,
  );

  // At-least-once delivery: a replayed settle must not credit twice.
  const balAfterFirst = await balance();
  await portal.call(`/payments/deposits/${encodeURIComponent(ref)}/settle?method=whish`, {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({}),
  });
  eqCheck(`deposit ${amt} replayed settle credits nothing`, await balance(), balAfterFirst);
}

/* ═══ D2. the platform and the CRM must AGREE on the amount ═══════════════ */
section('D2', 'A deposit the platform prices differently is NOT credited');
{
  /*
   * The guard that stops the CRM crediting money nobody paid in.
   *
   * The amount credited is `tx.amount`, recorded when the link was created —
   * correct, because a Whish link is fixed-amount. What this proves is that the
   * CRM also CHECKS the provider agrees, using the figure Rival returns on the
   * payment object. A mismatch leaves a perfectly self-consistent ledger
   * afterwards, so nothing would surface until somebody reconciled against the
   * provider's dashboard months later.
   */
  const amt = '80.00';
  const dep = await portal.call('/payments/deposits', {
    method: 'POST',
    headers: idem(),
    body: JSON.stringify({ amount: amt, currency: 'USD', method: 'whish' }),
  });
  if (dep.status >= 400) {
    bad('mismatch deposit created', String(dep.body?.message).slice(0, 50));
  } else {
    const ref = dep.body.providerRef ?? dep.body.reference;
    const local = (
      await db.query(`SELECT rival_external_id FROM transactions WHERE id = $1`, [dep.body.id])
    ).rows[0];
    const before = await balance();
    // The platform says it collected LESS than the link was created for.
    await rdb.query(
      `UPDATE whish_payments SET status = 'PAID', amount = '40.00', paid_at = now()
        WHERE external_id = $1`,
      [local.rival_external_id],
    );
    await portal.call(`/payments/deposits/${encodeURIComponent(ref)}/settle?method=whish`, {
      method: 'POST',
      headers: idem(),
      body: JSON.stringify({}),
    });

    eqCheck('nothing credited on a disputed amount', await balance(), before);
    const row = (
      await db.query(
        `SELECT state, rival_needs_attention, rival_attention_reason
           FROM transactions WHERE id = $1`,
        [dep.body.id],
      )
    ).rows[0];
    check(row.state === 'pending', 'the row stays settleable by hand', row.state);
    check(row.rival_needs_attention === true, 'flagged for a human', String(row.rival_needs_attention));
    check(
      /80/.test(String(row.rival_attention_reason)) && /40/.test(String(row.rival_attention_reason)),
      'the reason names BOTH figures',
      String(row.rival_attention_reason ?? '').slice(0, 70),
    );
    const legs = (
      await db.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE reference_id = $1`, [
        dep.body.id,
      ])
    ).rows[0];
    check(legs.n === 0, 'no ledger row was written', `${legs.n}`);

    // Put it back so the run leaves no flagged deposit behind.
    await db.query(
      `UPDATE transactions SET state = 'failure', rival_needs_attention = false,
              rival_attention_reason = null, settled_at = now() WHERE id = $1`,
      [dep.body.id],
    );
  }
}

/* ═══ E. the ledger tells the same story ══════════════════════════════════ */
section('E', 'Ledger integrity — the books, independently');
{
  const { rows: unbal } = await db.query(
    `SELECT count(*)::int AS n FROM wallets w
      WHERE w.balance <> (SELECT coalesce(sum(amount),0) FROM ledger_entries WHERE wallet_id = w.id)`,
  );
  check(unbal[0].n === 0, 'every wallet equals the sum of its ledger', `${unbal[0].n} unbalanced`);

  /*
   * `balance_after` is a running balance, so every entry must sit on the chain:
   * its `balance_after - amount` is some other entry's `balance_after`, unless
   * it is the wallet's first.
   *
   * ORDER-INDEPENDENT, and that is the whole point. The obvious version —
   * a window function ordered by `created_at` — reports FALSE BREAKS on a
   * perfectly sound ledger, and it took a real investigation to see why:
   * `created_at` defaults to `now()`, which in Postgres is TRANSACTION-START
   * time, not statement time. Under `SELECT … FOR UPDATE` the second writer
   * blocks until the first commits, so a transaction that STARTED earlier can
   * APPLY later and carry the earlier timestamp. Ten rows here looked broken
   * for exactly that reason and were provably fine —
   * `22575.43345678 − 100.01 = 22475.42345678` to the cent.
   *
   * Worth knowing beyond this script: anyone auditing this ledger by ordering
   * on `created_at` will see breaks that are not there. Sort by the CHAIN.
   */
  const { rows: chain } = await db.query(
    `WITH e AS (SELECT wallet_id, amount, balance_after FROM ledger_entries)
     SELECT count(*)::int AS n FROM e
      WHERE e.balance_after <> e.amount
        AND NOT EXISTS (
          SELECT 1 FROM e p
           WHERE p.wallet_id = e.wallet_id
             AND p.balance_after = e.balance_after - e.amount)`,
  );
  check(chain[0].n === 0, 'every balance_after sits on the chain', `${chain[0].n} orphans`);

  // And the chain ENDS at the wallet's balance — so no entry was applied after
  // the figure the client is shown.
  const { rows: tip } = await db.query(
    `SELECT count(*)::int AS n FROM wallets w
      WHERE EXISTS (SELECT 1 FROM ledger_entries WHERE wallet_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM ledger_entries l
                         WHERE l.wallet_id = w.id AND l.balance_after = w.balance)`,
  );
  check(tip[0].n === 0, 'each wallet balance is the tip of its chain', `${tip[0].n} adrift`);

  const { rows: overscale } = await db.query(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE amount <> round(amount, 8)`,
  );
  check(overscale[0].n === 0, 'no ledger amount exceeds the stored scale', `${overscale[0].n}`);
}

/* ═══ F. refunds return exactly what was taken ════════════════════════════ */
section('F', 'Refunds net to zero, to the cent');
for (const amt of ['33.33', '100.07']) {
  const before = await balance();
  const req = await requestWithdrawal(amt);
  if (req.status >= 400) {
    bad(`${amt} requested`, String(req.body?.message).slice(0, 50));
    continue;
  }
  const rej = await admin.call(`/admin/withdrawals/${req.body.id}/reject`, {
    method: 'PATCH',
    headers: idem(),
    body: JSON.stringify({ reason: 'matrix: refund exactness' }),
  });
  check(rej.status < 400, `${amt} rejected`, String(rej.status));
  eqCheck(`${amt} client made whole`, await balance(), before);
  const legs = (
    await db.query(
      `SELECT entry_type, amount FROM ledger_entries WHERE reference_id LIKE $1 || '%'`,
      [req.body.id],
    )
  ).rows;
  const net = legs.reduce((a, r) => a + scaled(r.amount), 0n);
  check(
    legs.length === 2 && net === 0n,
    `${amt} debit + refund net to zero`,
    `${legs.length} legs, net ${fmt(net)}`,
  );
}

/* ═══ cleanup ═════════════════════════════════════════════════════════════ */
section('G', 'Leaving nothing behind');
{
  const q = await admin.call('/admin/withdrawals?limit=100');
  let tidied = 0;
  for (const row of q.body?.items ?? []) {
    if (!created.includes(row.id)) continue;
    if (row.state === 'pending') {
      await admin.call(`/admin/withdrawals/${row.id}/reject`, {
        method: 'PATCH',
        headers: idem(),
        body: JSON.stringify({ reason: 'matrix cleanup' }),
      });
      tidied += 1;
    } else if (row.state === 'approved') {
      await admin.call(`/admin/withdrawals/${row.id}/cancel`, {
        method: 'PATCH',
        headers: idem(),
        body: JSON.stringify({ reason: 'matrix cleanup' }),
      });
      tidied += 1;
    }
  }
  console.log(`      tidied ${tidied} row(s)`);

  /*
   * Leave the company wallet USABLE.
   *
   * Cancelling a withdrawal releases its reserve, but anything under Rival's
   * auto-approval cap ($500) is completed by the poller before cleanup runs —
   * so a full pass genuinely SPENDS several thousand dollars of the company
   * balance. A run that drains it leaves every other suite failing for a reason
   * that has nothing to do with them: the payout rail refuses, correctly, and
   * two Playwright specs time out looking like product faults.
   *
   * Topping back up is part of finishing, not a courtesy.
   */
  const FLOOR = process.env.MATRIX_COMPANY_FLOOR ?? '4000';
  const left = await companyAvailable();
  if (scaled(left) < scaled(FLOOR)) {
    const top = subM(FLOOR, left);
    const r = await rival.call('/admin/loads', {
      method: 'POST',
      body: JSON.stringify({
        companyId: COMPANY,
        amount: top.split('.')[0],
        currency: 'USD',
        notes: 'integration matrix: restoring the company float',
        payout: { method: 'CASH', recipientName: 'OxShare CRM', recipientPhone: '+96170123456' },
        externalReference: `matrix-restore-${Date.now()}`,
      }),
    });
    check(r.status < 400, 'company wallet restored for the next run', await companyAvailable());
  } else {
    ok('company wallet still funded', left);
  }
  const { rows: stranded } = await db.query(
    `SELECT count(*)::int AS n FROM transactions
      WHERE state = 'approved' AND rival_needs_attention = true`,
  );
  check(stranded[0].n === 0, 'no row left approved-and-flagged', `${stranded[0].n}`);
  const { rows: unbal } = await db.query(
    `SELECT count(*)::int AS n FROM wallets w
      WHERE w.balance <> (SELECT coalesce(sum(amount),0) FROM ledger_entries WHERE wallet_id = w.id)`,
  );
  check(unbal[0].n === 0, 'books still balance after cleanup', `${unbal[0].n}`);
}

console.log(`\n${'═'.repeat(66)}`);
console.log(fail === 0 ? `✔ ALL ${pass} CHECKS PASSED` : `✖ ${fail} FAILED, ${pass} passed`);
if (fail) failures.forEach((f) => console.log(`    - ${f}`));
console.log('');
await db.end();
await rdb.end();
process.exit(fail === 0 ? 0 : 1);
