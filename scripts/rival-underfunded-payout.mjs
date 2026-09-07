/**
 * "The client withdraws $100, the admin approves — but OxShare's Rival wallet is empty."
 *
 * This is the one failure on the payout rail where doing nothing is expensive, because
 * the client's money is ALREADY GONE by the time it happens: the CRM debits the wallet
 * at REQUEST time, not at settlement. So between approval and a refused payout there is
 * a window where the client has been told "approved", their balance is down, and no
 * money is moving anywhere. What the system does in that window is the whole question.
 *
 *   node scripts/rival-underfunded-payout.mjs
 *
 * NOT in CI: it needs the whole stack up (see docs/RUNNING-LOCALLY.md).
 *
 * ## How the shortfall is produced — no balances are harmed
 *
 * Rival checks the company wallet at CREATE time (`assertSufficient`, called before
 * anything is reserved) and answers 409 INSUFFICIENT_BALANCE. So asking for MORE than
 * OxShare's Rival wallet holds reproduces the scenario exactly, and because the refusal
 * happens before the reserve, nothing at Rival is created, moved, or left behind. The
 * amount is read from Rival's live balance rather than hardcoded.
 *
 * ## What SHOULD happen, and why each half is deliberate
 *
 * The designed answer is: the row stays `approved`, flagged for a human, and the client
 * is NOT auto-refunded.
 *
 * The refund is withheld ON PURPOSE, and it is worth being clear about why, because
 * "refuse the payout, give the money back" sounds obviously right. The desk's usual fix
 * is to TOP UP the Rival wallet and retry the same row — the client asked to withdraw
 * and still wants to. Auto-refunding would cancel a withdrawal the client never
 * cancelled, and the "retry" would then have to become a fresh request they have to
 * make again. So the money stays debited, the row stays live, and a human chooses:
 * top up and retry, or reject and refund. Both paths are exercised below.
 *
 * The part that MUST hold for that choice to be safe is that the failure is LOUD.
 * A silently stuck `approved` row with the client's money inside it is the shape of
 * bug this file exists to catch.
 */
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

loadEnv();

const CRM = process.env.SMOKE_CRM ?? 'http://localhost:3001/v1';
const CLIENT = { email: 'client@oxshare.com', password: 'client123' };
const ADMIN = { email: 'admin@oxshare.com', password: 'admin123' };
/*
 * Read Rival's database as the OWNER (`txn_app`), NOT the app's `txn_app_rls`
 * role: Rival enforces row-level security, so the app role would return an empty
 * company/withdrawal set here and every "nothing at Rival" assertion below would
 * pass by seeing nothing at all — the worst way for a verification script to be
 * green. Credentials are the docker-compose defaults.
 */
const RIVAL_DB =
  process.env.RIVAL_DATABASE_URL ??
  'postgres://txn_app:txn_app_dev_password@localhost:5444/txn_system';

const idem = () => ({ 'idempotency-key': randomUUID() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── money comparison, per §6.1: strings and integers, never a float ──────── */
const scaled = (s) => {
  const [w, f = ''] = String(s ?? '0').split('.');
  return BigInt(w + (f + '00000000').slice(0, 8));
};
const eqMoney = (a, b) => scaled(a) === scaled(b);
const minusMoney = (a, b) => {
  const d = scaled(a) - scaled(b);
  const neg = d < 0n;
  const abs = (neg ? -d : d).toString().padStart(9, '0');
  return `${neg ? '-' : ''}${abs.slice(0, -8)}.${abs.slice(-8)}`;
};

function makeJar() {
  const jar = new Map();
  return {
    ck: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    csrf: (kind) => jar.get(`oxshare_crm_${kind}_csrf`) ?? '',
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair, ...attrs] = raw.split(';');
        const i = pair.indexOf('=');
        if (i <= 0) continue;
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        const dead = attrs.some((a) => {
          const [k, v] = a.split('=').map((x) => x.trim().toLowerCase());
          if (k === 'max-age') return Number(v) <= 0;
          if (k === 'expires') return new Date(v).getTime() <= Date.now();
          return false;
        });
        if (dead || !value) jar.delete(name);
        else jar.set(name, value);
      }
    },
  };
}

async function call(jar, kind, path, init = {}) {
  const res = await fetch(`${CRM}${path}`, {
    ...init,
    headers: {
      cookie: jar.ck(),
      'x-oxshare-csrf': jar.csrf(kind),
      origin: kind === 'admin' ? 'http://localhost:3002' : 'http://localhost:3000',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    redirect: 'manual',
  });
  jar.absorb(res);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/* ── a session against RIVAL's own API (different CSRF convention) ────────── */
const RIVAL_API = process.env.RIVAL_API ?? 'http://localhost:4001/v1';
function rivalSession() {
  const jar = makeJar();
  return {
    jar,
    async call(path, init = {}) {
      const res = await fetch(`${RIVAL_API}${path}`, {
        ...init,
        headers: {
          cookie: jar.ck(),
          // Rival names its anti-forgery header/cookie differently from the CRM.
          'x-csrf-token': jar.ck().match(/(?:^|; )csrf-token=([^;]*)/)?.[1] ?? '',
          origin: process.env.RIVAL_WEB ?? 'http://localhost:4000',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        redirect: 'manual',
      });
      jar.absorb(res);
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      // Rival wraps everything in {success, statusCode, data}.
      return { status: res.status, body: body?.data ?? body, raw: body };
    },
  };
}

let failures = 0;
const ok = (m) => console.log(`    ✔ ${m}`);
const bad = (m) => { failures += 1; console.log(`    ✖ ${m}`); };
const check = (cond, good, badMsg) => (cond ? ok(good) : bad(badMsg));
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const brief = (b) => JSON.stringify(b).slice(0, 260);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const rival = new pg.Client({ connectionString: RIVAL_DB });
await db.connect();
await rival.connect();

const portal = makeJar();
const admin = makeJar();

console.log('\nUnderfunded payout — what happens when Rival cannot cover the withdrawal');
console.log(`CRM ${CRM}`);

/* ── 1. sign in ───────────────────────────────────────────────────────────── */
step(1, 'Sign in');
const cl = await call(portal, 'portal', '/auth/login', { method: 'POST', body: JSON.stringify(CLIENT) });
check(cl.status < 400, `client ${CLIENT.email}`, `client login -> ${cl.status} ${brief(cl.body)}`);
const ad = await call(admin, 'admin', '/admin/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) });
check(ad.status < 400, `admin ${ADMIN.email}`, `admin login -> ${ad.status} ${brief(ad.body)}`);
if (failures) process.exit(1);
const userId = (await call(portal, 'portal', '/auth/me')).body?.id;

/* ── 2. read Rival's real company balance ─────────────────────────────────── */
step(2, "OxShare's wallet AT RIVAL — the money the payout would come from");
const companyName = process.env.RIVAL_COMPANY ?? 'OxShare CRM';
const w = await rival.query(
  `SELECT w.available_balance, w.reserved_balance, w.company_id
     FROM wallets w JOIN companies c ON c.id = w.company_id
    WHERE c.name = $1 AND w.currency = 'USD' LIMIT 1`,
  [companyName],
);
if (w.rows.length === 0) { bad(`no USD wallet at Rival for company "${companyName}"`); process.exit(1); }
const rivalAvailable = w.rows[0].available_balance;
const companyId = w.rows[0].company_id;
console.log(`      available ${rivalAvailable} USD   (reserved ${w.rows[0].reserved_balance})`);

// Ask for more than Rival can cover. The refusal lands BEFORE the reserve, so
// this costs Rival nothing and leaves no row behind.
const AMOUNT = (BigInt(scaled(rivalAvailable) / 100000000n) + 100n).toString();
console.log(`      requesting ${AMOUNT} USD — deliberately above it`);

/* ── 3. the client must be able to afford it locally ──────────────────────── */
step(3, 'Fund the CLIENT wallet so the CRM itself has no objection');
const balance = async () => {
  const r = await call(portal, 'portal', '/wallet');
  return (r.body ?? []).find((x) => x.currency === 'USD')?.balance ?? '0';
};
if (scaled(await balance()) < scaled(AMOUNT)) {
  const top = await call(admin, 'admin', '/admin/wallets/credit', {
    method: 'POST', headers: idem(),
    body: JSON.stringify({ userId, currency: 'USD', amount: AMOUNT, reason: 'Underfunded-payout test' }),
  });
  check(top.status < 400, 'topped up', `credit -> ${top.status} ${brief(top.body)}`);
}
const beforeRequest = await balance();
console.log(`      client balance: ${beforeRequest}`);

/* ── 4. request ───────────────────────────────────────────────────────────── */
step(4, `Client requests ${AMOUNT} USD (the CRM debits at REQUEST time)`);
const wd = await call(portal, 'portal', '/payments/withdrawals', {
  method: 'POST', headers: idem(),
  body: JSON.stringify({ amount: AMOUNT, currency: 'USD', methodKey: 'whish', destination: '+96170123456' }),
});
if (wd.status >= 400) { bad(`withdrawal -> ${wd.status} ${brief(wd.body)}`); process.exit(1); }
const txId = wd.body.id;
ok(`pending, id ${txId}`);
const afterRequest = await balance();
check(
  eqMoney(minusMoney(beforeRequest, afterRequest), AMOUNT),
  `client debited ${AMOUNT}: ${beforeRequest} -> ${afterRequest}`,
  `expected a ${AMOUNT} debit, saw ${beforeRequest} -> ${afterRequest}`,
);

/* ── 5. approve ───────────────────────────────────────────────────────────── */
step(5, 'Admin approves — the submission to Rival happens post-commit');
const ap = await call(admin, 'admin', `/admin/withdrawals/${txId}/approve`, {
  method: 'PATCH', headers: idem(), body: JSON.stringify({}),
});
check(ap.status < 400, `approve accepted (state=${ap.body?.state})`, `approve -> ${ap.status} ${brief(ap.body)}`);

const rowOf = async () => {
  const q = await call(admin, 'admin', '/admin/withdrawals?limit=25');
  return (q.body?.items ?? []).find((r) => r.id === txId) ?? null;
};
let row = null;
for (let i = 0; i < 12; i += 1) {
  await sleep(1200);
  row = await rowOf();
  if (row?.rivalNeedsAttention || row?.rivalWithdrawalId) break;
}

/* ── 6. THE ASSERTIONS ────────────────────────────────────────────────────── */
step(6, 'What the CRM did with the refusal');

check(
  row?.state === 'approved',
  `the row stayed 'approved' — not paid, not silently failed`,
  `expected 'approved', got '${row?.state}'`,
);
check(
  !row?.settledAt,
  'settledAt is null — nobody was told the money left',
  `settledAt is ${row?.settledAt} — a payout that never happened was recorded as settled`,
);
check(
  row?.rivalNeedsAttention === true,
  'flagged NEEDS ATTENTION — the desk sees it',
  'NOT flagged — an approved row is stuck holding the client’s money with nothing pointing at it',
);
check(
  /insufficient|balance/i.test(row?.rivalAttentionReason ?? ''),
  `the reason names the cause: "${row?.rivalAttentionReason}"`,
  `the reason does not mention the balance: "${row?.rivalAttentionReason}"`,
);
check(
  !row?.rivalWithdrawalId,
  'no Rival id — nothing was created there',
  `a Rival id exists (${row?.rivalWithdrawalId}) — the refusal was not clean`,
);

// The claim must be RELEASED for a definite refusal, or the desk's retry is dead.
const claim = await db.query(
  `SELECT rival_submitted_at, rival_withdrawal_id, state FROM transactions WHERE id = $1`,
  [txId],
);
check(
  claim.rows[0]?.rival_submitted_at === null,
  'the submission claim was released — retry is possible',
  'the claim is still held — the desk’s retry button will refuse (that is only correct for an UNKNOWN outcome, not a definite refusal)',
);

/* nothing at Rival */
const atRival = await rival.query(
  `SELECT count(*)::int AS n FROM withdrawals WHERE company_id = $1 AND amount = $2::numeric`,
  [companyId, AMOUNT],
);
check(atRival.rows[0].n === 0, 'Rival holds no withdrawal for this amount', `Rival has ${atRival.rows[0].n} row(s) at ${AMOUNT} — the refusal was not clean`);

/* the client's money is still debited, deliberately */
const afterFailure = await balance();
check(
  eqMoney(afterFailure, afterRequest),
  `client balance unchanged at ${afterFailure} — NOT auto-refunded (deliberate: the desk tops up and retries)`,
  `balance moved to ${afterFailure} — something refunded automatically`,
);

/* the ledger must show exactly one debit and no refund */
/*
 * `reference_id LIKE '<txId>%'`, not `= $1`: the refund is deliberately booked
 * under a DIFFERENT reference (`<txId>:refund`) so it cannot collide with the
 * debit on `ledger_entries_wallet_reference_uq` and be silently dropped as a
 * replay — the same rule the accrual reversal follows. An exact match here
 * would report "no refund" on a refund that happened.
 */
const legsOf = async () =>
  (await db.query(
    `SELECT entry_type, amount, reference_id FROM ledger_entries
      WHERE reference_id LIKE $1 || '%' ORDER BY created_at`,
    [txId],
  )).rows;
const led = { rows: await legsOf() };
// The debit is stored SIGNED (-808.00000000), so compare magnitude — and assert
// the sign separately, because a withdrawal booked positive would be a credit.
const kinds = led.rows.map((r) => r.entry_type).sort();
const one = led.rows[0];
check(
  led.rows.length === 1 && one?.entry_type === 'withdrawal' &&
    scaled(one.amount) < 0n && eqMoney(one.amount.replace('-', ''), AMOUNT),
  `ledger holds exactly one entry, a ${one?.amount} ${kinds.join('')} debit — no phantom refund`,
  `ledger holds ${led.rows.length} entries: ${JSON.stringify(led.rows)}`,
);

/*
 * Somebody was told — POLLED, not read once.
 *
 * The attention flag is committed BEFORE these two land: the notification is
 * awaited after the UPDATE, and the audit row is deliberately detached
 * (`recordSystemAction` is fire-and-forget, so an audit-write failure cannot
 * fail the money action it describes). Reading them the instant the flag
 * appears is a race in the TEST, and it fails intermittently — which is worse
 * than failing always, because it teaches you to re-run until green.
 */
const until = async (fn, ms = 8000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = await fn();
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await sleep(400);
  }
};

const note = await until(async () =>
  (await db.query(
    `SELECT kind FROM notifications
      WHERE kind = 'withdrawal.rival_submit_failed' AND params->>'transactionId' = $1`,
    [txId],
  )).rows,
);
check(note.length > 0, `${note.length} admin notification(s) raised`, 'NO admin was notified — the failure is silent');

const audit = await until(async () =>
  (await db.query(
    `SELECT action, actor_kind, details FROM audit_log
      WHERE subject_id = $1 AND action = 'withdrawal.rival.submit'
      ORDER BY created_at DESC LIMIT 1`,
    [txId],
  )).rows,
);
check(
  audit.length > 0 && audit[0].details?.failed === true,
  `the failed attempt is on the audit trail (actor_kind=${audit[0]?.actor_kind})`,
  `no audit row recording the failure: ${brief(audit)}`,
);

/* ── 7. recovery A: retry while still underfunded must fail the SAME way ──── */
step(7, 'The desk retries while the wallet is STILL empty (must fail identically, not double up)');
const retry1 = await call(admin, 'admin', `/admin/withdrawals/${txId}/rival-submit`, {
  method: 'POST', headers: idem(), body: JSON.stringify({}),
});
await sleep(2500);
const afterRetry = await rowOf();
check(
  afterRetry?.state === 'approved' && afterRetry?.rivalNeedsAttention === true && !afterRetry?.rivalWithdrawalId,
  `still approved + flagged, nothing created (retry HTTP ${retry1.status})`,
  `retry left it at state=${afterRetry?.state} attention=${afterRetry?.rivalNeedsAttention} rivalId=${afterRetry?.rivalWithdrawalId}`,
);
const atRival2 = await rival.query(
  `SELECT count(*)::int AS n FROM withdrawals WHERE company_id = $1 AND amount = $2::numeric`,
  [companyId, AMOUNT],
);
check(atRival2.rows[0].n === 0, 'still nothing at Rival after the retry — no duplicate payout', `Rival now has ${atRival2.rows[0].n} row(s)`);
const balAfterRetry = await balance();
check(eqMoney(balAfterRetry, afterRequest), 'the retry did not touch the client balance', `balance moved to ${balAfterRetry}`);

/* ── 8. recovery B: TOP UP at Rival, then retry the same row ──────────────── */
step(8, 'The desk tops up the Rival wallet and retries — the PRIMARY fix');

const rivalAdmin = rivalSession();
const superLogin = await rivalAdmin.call('/auth/login', {
  method: 'POST',
  body: JSON.stringify({
    email: process.env.RIVAL_SUPER_EMAIL ?? 'admin@example.com',
    password: process.env.RIVAL_SUPER_PASSWORD ?? 'loadless',
  }),
});
let toppedUp = false;
if (superLogin.status >= 400) {
  console.log(`    ⚠ cannot sign in to Rival as super admin (${superLogin.status}) — skipping the top-up path`);
} else {
  ok('signed in to Rival as super admin');
  // Cover the shortfall with room to spare, through Rival's OWN money-in flow
  // (admin load = "the company handed us funds off-platform"), not a DB write:
  // a hand-written balance would prove the CRM works against a state Rival's
  // own ledger never produces.
  /*
   * Cover the shortfall PLUS the payout fee, which is charged ON TOP and scales
   * with the amount (~5%), so a flat margin silently stops being enough as the
   * wallet — and therefore the test's amount — grows. A 20% buffer keeps this
   * repeatable at any balance; the earlier flat +50 worked at $808 and failed
   * at $2,533 for exactly this reason.
   */
  const shortfall = BigInt(scaled(AMOUNT) / 100000000n) - BigInt(scaled(rivalAvailable) / 100000000n);
  const topUp = (shortfall + BigInt(scaled(AMOUNT) / 100000000n) / 5n + 50n).toString();
  const load = await rivalAdmin.call('/admin/loads', {
    method: 'POST',
    body: JSON.stringify({
      companyId,
      amount: topUp,
      currency: 'USD',
      notes: 'CRM underfunded-payout test: covering the shortfall.',
      // A CASH "payout" here records HOW the money arrived, per the load schema.
      payout: {
        method: 'CASH',
        recipientName: 'OxShare CRM',
        recipientPhone: '+96170123456',
      },
      externalReference: `oxshare-test-${Date.now()}`,
    }),
  });
  if (load.status >= 400) {
    console.log(`    ⚠ admin load refused (${load.status} ${brief(load.raw)}) — skipping the top-up path`);
  } else {
    toppedUp = true;
    const nowAvail = (await rival.query(
      `SELECT available_balance FROM wallets WHERE company_id = $1 AND currency = 'USD'`,
      [companyId],
    )).rows[0].available_balance;
    ok(`topped up +${topUp} USD — Rival available is now ${nowAvail}`);
    check(
      scaled(nowAvail) >= scaled(AMOUNT),
      'the wallet can now cover the payout',
      `still short: ${nowAvail} < ${AMOUNT}`,
    );
  }
}

let settled = false;
if (toppedUp) {
  step(9, 'Retry the SAME withdrawal — it must now go through');
  const retry2 = await call(admin, 'admin', `/admin/withdrawals/${txId}/rival-submit`, {
    method: 'POST', headers: idem(), body: JSON.stringify({}),
  });
  let after = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(1200);
    after = await rowOf();
    if (after?.rivalWithdrawalId) break;
  }
  check(
    Boolean(after?.rivalWithdrawalId),
    `submitted to Rival as ${after?.rivalWithdrawalId} (retry HTTP ${retry2.status})`,
    `still not submitted after the top-up: ${brief(after ?? {})}`,
  );
  check(
    after?.rivalNeedsAttention === false,
    'the needs-attention flag CLEARED on the successful retry',
    `flag still set: ${after?.rivalAttentionReason}`,
  );
  check(
    after?.state === 'approved' && !after?.settledAt,
    'still approved and unsettled — submission is not payment (D-66)',
    `state=${after?.state} settledAt=${after?.settledAt}`,
  );
  check(
    eqMoney(await balance(), afterRequest),
    'the client was not debited a second time by the retry',
    `balance moved to ${await balance()} — the retry double-charged`,
  );

  /* ── 10. Rival pays it, and the webhook settles the CRM row ──────────────── */
  step(10, 'Rival pays out — the webhook must settle the CRM row');
  const payout = await rivalAdmin.call(`/admin/withdrawals/${after.rivalWithdrawalId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ externalReference: `oxshare-test-paid-${Date.now()}`, notes: 'Underfunded-payout test.' }),
  });
  check(payout.status < 400, `Rival marked it paid (HTTP ${payout.status})`, `Rival approve -> ${payout.status} ${brief(payout.raw)}`);

  let final = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(1500);
    final = await rowOf();
    if (final?.state === 'success') break;
  }
  settled = final?.state === 'success';
  check(settled, `the CRM row is 'success' with settledAt ${final?.settledAt}`, `expected 'success', got '${final?.state}' after 30s`);
  check(
    eqMoney(await balance(), afterRequest),
    `client stays debited at ${afterRequest} — they were paid, so no refund`,
    `balance is ${await balance()} — a paid withdrawal was also refunded`,
  );
  const paidLegs = await legsOf();
  const paidNet = paidLegs.reduce((acc, r) => acc + scaled(r.amount), 0n);
  check(
    paidLegs.length === 1 && paidNet === -scaled(AMOUNT),
    `ledger still holds ONE debit (${paidLegs.map((r) => r.entry_type).join(', ')}) — paid once, never refunded`,
    `expected one debit, found ${paidLegs.length}: ${JSON.stringify(paidLegs)}`,
  );
}

/*
 * Leave no stranded row behind, whatever happened above.
 *
 * An `approved` row holding a client's money is exactly the state this script
 * exists to DETECT; it must never be the state it LEAVES. Keying the cleanup on
 * `!toppedUp` was not enough — when the top-up succeeded but the retry or the
 * settlement then failed, the row fell through every branch and stayed
 * approved, and repeated runs quietly accumulated them.
 *
 * So the condition is the row's ACTUAL state, read back now, rather than an
 * assumption about which path ran.
 */
{
  const still = await rowOf();
  if (still?.state === 'approved') {
    await call(admin, 'admin', `/admin/withdrawals/${txId}/cancel`, {
      method: 'PATCH', headers: idem(),
      body: JSON.stringify({ reason: 'Cleanup: verification run did not settle this row.' }),
    });
    console.log('    ⚠ refunded the first withdrawal so the run leaves no stranded row');
  }
}

/* ── 11. recovery C: the alternative — reject and make the client whole ───── */
step(11, 'The OTHER fix: a second underfunded payout the desk REJECTS');

const avail2 = (await rival.query(
  `SELECT available_balance FROM wallets WHERE company_id = $1 AND currency = 'USD'`,
  [companyId],
)).rows[0].available_balance;
const AMOUNT2 = (BigInt(scaled(avail2) / 100000000n) + 100n).toString();
console.log(`      Rival available ${avail2} — requesting ${AMOUNT2}`);

if (scaled(await balance()) < scaled(AMOUNT2)) {
  await call(admin, 'admin', '/admin/wallets/credit', {
    method: 'POST', headers: idem(),
    body: JSON.stringify({ userId, currency: 'USD', amount: AMOUNT2, reason: 'Underfunded-payout test (reject path)' }),
  });
}
const beforeB = await balance();
const wdB = await call(portal, 'portal', '/payments/withdrawals', {
  method: 'POST', headers: idem(),
  body: JSON.stringify({ amount: AMOUNT2, currency: 'USD', methodKey: 'whish', destination: '+96170123456' }),
});
if (wdB.status >= 400) {
  bad(`second withdrawal -> ${wdB.status} ${brief(wdB.body)}`);
} else {
  const txB = wdB.body.id;
  const afterB = await balance();
  ok(`requested ${AMOUNT2}, client debited ${beforeB} -> ${afterB}`);
  await call(admin, 'admin', `/admin/withdrawals/${txB}/approve`, {
    method: 'PATCH', headers: idem(), body: JSON.stringify({}),
  });
  let rowB = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(1200);
    const q = await call(admin, 'admin', '/admin/withdrawals?limit=25');
    rowB = (q.body?.items ?? []).find((r) => r.id === txB) ?? rowB;
    if (rowB?.rivalNeedsAttention || rowB?.rivalWithdrawalId) break;
  }
  check(
    rowB?.state === 'approved' && rowB?.rivalNeedsAttention === true && !rowB?.rivalWithdrawalId,
    'refused again and flagged, exactly as the first one',
    `state=${rowB?.state} attention=${rowB?.rivalNeedsAttention} rivalId=${rowB?.rivalWithdrawalId}`,
  );

  const cancel = await call(admin, 'admin', `/admin/withdrawals/${txB}/cancel`, {
    method: 'PATCH', headers: idem(),
    body: JSON.stringify({ reason: 'Company payout wallet could not fund this payout.' }),
  });
  check(cancel.status < 400, `desk cancelled it (HTTP ${cancel.status})`, `cancel -> ${cancel.status} ${brief(cancel.body)}`);
  await sleep(1500);
  const q2 = await call(admin, 'admin', '/admin/withdrawals?limit=25');
  const finalB = (q2.body?.items ?? []).find((r) => r.id === txB);
  const finalBal = await balance();
  check(finalB?.state === 'failure', `the row is now 'failure'`, `expected 'failure', got '${finalB?.state}'`);
  check(
    eqMoney(finalBal, beforeB),
    `client made whole: ${afterB} -> ${finalBal} (back to ${beforeB})`,
    `client NOT made whole: expected ${beforeB}, got ${finalBal}`,
  );
  const legsB = (await db.query(
    `SELECT entry_type, amount FROM ledger_entries WHERE reference_id LIKE $1 || '%'`,
    [txB],
  )).rows;
  const netB = legsB.reduce((acc, r) => acc + scaled(r.amount), 0n);
  check(
    legsB.length === 2 && netB === 0n,
    `ledger holds the debit and its compensating refund (${legsB.map((r) => `${r.entry_type} ${r.amount}`).join(' + ')}), netting to zero`,
    `expected 2 entries netting to zero, found ${legsB.length} netting ${netB}: ${JSON.stringify(legsB)}`,
  );
}

console.log(`\n${'═'.repeat(66)}`);
console.log(failures === 0
  ? '✔ An underfunded payout is handled correctly at every step.'
  : `✖ ${failures} check(s) failed.`);
console.log(`\n  transaction : ${txId}\n`);
await db.end();
await rival.end();
process.exit(failures === 0 ? 0 : 1);
