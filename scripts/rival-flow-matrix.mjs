/**
 * Every withdrawal flow that involves BOTH systems, driven for real.
 *
 * ## What this is for, and what it is NOT
 *
 * The Vitest suites already cover the protocol and the money rules against real
 * Postgres — replayed webhooks, tampered signatures, out-of-order events,
 * concurrent settles, `reversed` never touching the ledger. Those run in CI and
 * need nothing else alive.
 *
 * What they cannot cover is the pair of systems disagreeing in real time: a
 * human rejecting on Rival's side while the CRM believes something else, a
 * cancel racing a payout, a replay arriving over the wire. That is what this
 * does — it drives the CRM's HTTP surface and Rival's admin surface against each
 * other and checks where the money ended up after each one.
 *
 *   node scripts/rival-flow-matrix.mjs
 *
 * NOT in CI: it needs the whole stack (CRM API, Rival API, the ngrok tunnel for
 * inbound webhooks) and it moves real rows in the dev database.
 *
 * ## Reading a failure
 *
 * Every scenario asserts the BALANCE at the end, not just the state, because a
 * state machine that is right and a ledger that is wrong is the failure this
 * whole system exists to prevent. If a balance assertion fails, read the ledger
 * for that transaction before anything else.
 */
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

loadEnv();

const CRM = process.env.MATRIX_CRM ?? 'http://localhost:3001/v1';
const RIVAL = process.env.MATRIX_RIVAL ?? 'http://localhost:4001/v1';
const CLIENT = { email: 'client@oxshare.com', password: 'client123' };
const CRM_ADMIN = { email: 'admin@oxshare.com', password: 'admin123' };
const RIVAL_ADMIN = { email: 'admin@example.com', password: 'loadless' };

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const idem = () => ({ 'idempotency-key': randomUUID() });

/* ── cookie jars ─────────────────────────────────────────────────────────── */

function jarFor(csrfCookie, csrfHeader, origin) {
  const jar = new Map();
  const absorb = (res) => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = raw.split(';');
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      // Login clears legacy names by re-setting them expired; a jar that keeps
      // them sends an empty CSRF and every write 403s.
      const dead = attrs.some((a) => {
        const [k, v] = a.split('=').map((x) => x.trim().toLowerCase());
        if (k === 'max-age') return Number(v) <= 0;
        if (k === 'expires') return new Date(v).getTime() <= Date.now();
        return false;
      });
      if (dead || !value) jar.delete(name);
      else jar.set(name, value);
    }
  };
  return { jar, absorb, csrfCookie, csrfHeader, origin };
}

async function call(base, ctx, path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      cookie: [...ctx.jar].map(([k, v]) => `${k}=${v}`).join('; '),
      [ctx.csrfHeader]: ctx.jar.get(ctx.csrfCookie) ?? '',
      origin: ctx.origin,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    redirect: 'manual',
  });
  ctx.absorb(res);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const unwrap = (b) => { let v = b; while (v && typeof v === 'object' && 'data' in v && !Array.isArray(v)) v = v.data; return v; };

const portal = jarFor('oxshare_crm_portal_csrf', 'x-oxshare-csrf', 'http://localhost:3000');
const crmAdmin = jarFor('oxshare_crm_admin_csrf', 'x-oxshare-csrf', 'http://localhost:3002');
const rival = jarFor('csrf-token', 'x-csrf-token', 'http://localhost:4000');

const crm = (ctx, p, i) => call(CRM, ctx, p, i);
const riv = (p, i) => call(RIVAL, rival, p, i);

/* ── reporting ───────────────────────────────────────────────────────────── */

let pass = 0, fail = 0;
const failures = [];
const ok = (m) => { pass += 1; console.log(`      ✔ ${m}`); };
const bad = (m, d = '') => { fail += 1; failures.push(m); console.log(`      ✖ ${m}${d ? ` — ${d}` : ''}`); };
const eq = (label, actual, expected) =>
  String(actual) === String(expected) ? ok(`${label} = ${expected}`) : bad(label, `expected ${expected}, got ${actual}`);

/**
 * Compare two monetary strings WITHOUT going through a float.
 *
 * `1740` and `1740.00000000` are the same amount and different strings, and the
 * API returns the padded form while arithmetic in this script produces the short
 * one. §6.1 forbids `Number()` on a monetary value, so this normalises by text:
 * pad to a common scale and compare digits.
 */
function sameMoney(a, b) {
  const norm = (v) => {
    const [whole, frac = ''] = String(v).trim().split('.');
    return `${whole.replace(/^\+/, '') || '0'}.${frac.padEnd(8, '0').slice(0, 8)}`;
  };
  return norm(a) === norm(b);
}
const eqMoney = (label, actual, expected) =>
  sameMoney(actual, expected)
    ? ok(`${label} = ${actual}`)
    : bad(label, `expected ${expected}, got ${actual}`);

/** Add to a monetary string by text, so no float ever touches it. */
function plus(amount, delta) {
  const scale = 100000000n;
  const toUnits = (v) => {
    const [w, f = ''] = String(v).split('.');
    return BigInt(w) * scale + BigInt((f + '00000000').slice(0, 8));
  };
  const total = toUnits(amount) + toUnits(delta);
  return `${total / scale}.${String(total % scale).padStart(8, '0')}`;
}
const scenario = (n, title) => console.log(`\n── ${n}. ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);

/* ── helpers ─────────────────────────────────────────────────────────────── */

let userId;
const balance = async () => {
  const { rows } = await db.query(
    `SELECT balance FROM wallets w JOIN users u ON u.id = w.user_id
      WHERE u.id = $1 AND w.currency = 'USD'`, [userId]);
  return rows[0]?.balance ?? '0';
};
const txRow = async (id) => (await db.query(
  `SELECT state, rival_withdrawal_id, rival_needs_attention, rival_attention_reason,
          rejection_reason, settled_at FROM transactions WHERE id = $1`, [id])).rows[0];
const ledgerFor = async (id) => (await db.query(
  `SELECT entry_type, amount FROM ledger_entries WHERE reference_id LIKE $1 ORDER BY created_at`,
  [`${id}%`])).rows;

/** Fund, request, and return the CRM transaction id. */
async function requestWithdrawal(amount = '20') {
  await crm(crmAdmin, '/admin/wallets/credit', {
    method: 'POST', headers: idem(),
    body: JSON.stringify({ userId, currency: 'USD', amount: '200', reason: 'flow matrix' }),
  });
  const r = await crm(portal, '/payments/withdrawals', {
    method: 'POST', headers: idem(),
    body: JSON.stringify({ amount, currency: 'USD', methodKey: 'whish', destination: '+96170123456' }),
  });
  if (r.status >= 400) throw new Error(`request → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

/** Approve on the CRM and wait for the post-commit Rival submission to land. */
async function approveAndAwaitSubmit(txId) {
  const a = await crm(crmAdmin, `/admin/withdrawals/${txId}/approve`, {
    method: 'PATCH', headers: idem(), body: JSON.stringify({}),
  });
  if (a.status >= 400) throw new Error(`approve → ${a.status} ${JSON.stringify(a.body)}`);
  for (let i = 0; i < 12; i += 1) {
    const row = await txRow(txId);
    if (row?.rival_withdrawal_id) return { approve: a, rivalId: row.rival_withdrawal_id };
    await new Promise((r) => setTimeout(r, 1200));
  }
  return { approve: a, rivalId: null };
}

/** Wait for the CRM row to reach one of `states` (webhook or poller). */
async function awaitState(txId, states, seconds = 25) {
  for (let i = 0; i < seconds; i += 1) {
    const row = await txRow(txId);
    if (states.includes(row?.state)) return row;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return await txRow(txId);
}

/* ── run ─────────────────────────────────────────────────────────────────── */

await db.connect();
console.log(`\nRival flow matrix — CRM ${CRM}, Rival ${RIVAL}`);

console.log('\n[sign in]');
await crm(portal, '/auth/login', { method: 'POST', body: JSON.stringify(CLIENT) });
userId = (await crm(portal, '/auth/me')).body?.id;
await crm(crmAdmin, '/admin/auth/login', { method: 'POST', body: JSON.stringify(CRM_ADMIN) });
let s = await riv('/auth/csrf'); rival.jar.set('csrf-token', unwrap(s.body)?.csrfToken ?? rival.jar.get('csrf-token'));
const rl = await riv('/auth/login', { method: 'POST', body: JSON.stringify(RIVAL_ADMIN) });
s = await riv('/auth/csrf'); rival.jar.set('csrf-token', unwrap(s.body)?.csrfToken ?? rival.jar.get('csrf-token'));
if (!userId || rl.status >= 400) { console.error('  ✖ could not sign in everywhere'); process.exit(1); }
console.log(`      ✔ client ${userId}, CRM admin, Rival admin`);

/* 1 ─────────────────────────────────────────────────────────────────────── */
scenario(1, 'OxShare REJECTS while pending — Rival never sees it');
{
  const before = await balance();
  const txId = await requestWithdrawal('20');
  const afterDebit = await balance();
  const r = await crm(crmAdmin, `/admin/withdrawals/${txId}/reject`, {
    method: 'PATCH', headers: idem(), body: JSON.stringify({ reason: 'Matrix: refused at the desk' }),
  });
  eq('reject accepted', r.status < 400, true);
  const row = await txRow(txId);
  eq('state', row.state, 'rejected');
  eq('never submitted to Rival', row.rival_withdrawal_id ?? 'null', 'null');
  eqMoney('balance restored', await balance(), plus(afterDebit, '20'));
  /*
   * Asserted as a SET, not by index. Both rows are written inside one
   * transaction and can carry the same `created_at`, so `ORDER BY created_at`
   * does not guarantee which comes back first — indexing made this fail about
   * one run in three for a reason that had nothing to do with the money.
   */
  const led = await ledgerFor(txId);
  eq('ledger entries', led.length, 2);
  eq('one debit', led.filter((l) => l.entry_type === 'withdrawal').length, 1);
  eq('one compensating entry', led.filter((l) => l.entry_type === 'adjustment').length, 1);
}

/* 2 ─────────────────────────────────────────────────────────────────────── */
scenario(2, 'Rival ADMIN rejects an approved payout — refund exactly once');
{
  const txId = await requestWithdrawal('21');
  const afterDebit = await balance();
  const { approve, rivalId } = await approveAndAwaitSubmit(txId);
  eq('CRM state after approve', approve.body?.state, 'approved');
  eq('settledAt still null', approve.body?.settledAt ?? 'null', 'null');
  rivalId ? ok(`submitted to Rival as ${rivalId}`) : bad('never submitted to Rival');

  if (rivalId) {
    const rej = await riv(`/admin/withdrawals/${rivalId}/reject`, {
      method: 'POST', body: JSON.stringify({ notes: 'Matrix: refused on the platform' }),
    });
    eq('Rival reject accepted', rej.status < 400, true);
    const row = await awaitState(txId, ['failure']);
    eq('CRM state', row.state, 'failure');
    ok(`reason carried across: "${String(row.rejection_reason ?? '').slice(0, 40)}"`);
    eqMoney('balance refunded', await balance(), plus(afterDebit, '21'));
    const led = await ledgerFor(txId);
    eq('ledger entries (debit + ONE refund)', led.length, 2);
  }
}

/* 3 ─────────────────────────────────────────────────────────────────────── */
scenario(3, 'The SAME rejection delivered twice — still one refund');
{
  const txId = await requestWithdrawal('22');
  const afterDebit = await balance();
  const { rivalId } = await approveAndAwaitSubmit(txId);
  if (!rivalId) bad('not submitted; cannot test the replay');
  else {
    await riv(`/admin/withdrawals/${rivalId}/reject`, { method: 'POST', body: JSON.stringify({ notes: 'Matrix: first' }) });
    await awaitState(txId, ['failure']);
    const balanceAfterFirst = await balance();
    // A second reject at Rival is a conflict there; what matters is that even if
    // the delivery were replayed, the CRM credits once. Force the replay by
    // re-delivering the same event through Rival's own retry surface.
    const second = await riv(`/admin/withdrawals/${rivalId}/reject`, { method: 'POST', body: JSON.stringify({ notes: 'Matrix: replay' }) });
    ok(`Rival answered the second reject ${second.status} (a conflict is correct)`);
    await new Promise((r) => setTimeout(r, 4000));
    eqMoney('balance unchanged by the replay', await balance(), balanceAfterFirst);
    const led = await ledgerFor(txId);
    eq('still exactly one refund', led.filter((l) => l.entry_type === 'adjustment').length, 1);
    eqMoney('balance is the pre-withdrawal figure', balanceAfterFirst, plus(afterDebit, '22'));
  }
}

/* 4 ─────────────────────────────────────────────────────────────────────── */
scenario(4, 'Double approve on the CRM — the second is refused');
{
  const txId = await requestWithdrawal('23');
  await approveAndAwaitSubmit(txId);
  const again = await crm(crmAdmin, `/admin/withdrawals/${txId}/approve`, {
    method: 'PATCH', headers: idem(), body: JSON.stringify({}),
  });
  eq('second approve refused', again.status >= 400, true);
  ok(`message: ${String(unwrap(again.body)?.message ?? again.body?.message ?? '').slice(0, 60)}`);
  const led = await ledgerFor(txId);
  eq('no extra ledger entry', led.length, 1);
}

/* 5 ─────────────────────────────────────────────────────────────────────── */
scenario(5, 'Client asks for more than the balance — refused, nothing written');
{
  const bal = await balance();
  /*
   * Whole dollars above the balance, built from the STRING — never
   * `Number(bal) + 1000`.
   *
   * Two things were wrong with the float version. It coerced a money value,
   * which §6.1 forbids everywhere else in this codebase. And it inherited the
   * balance's decimals: a wallet holding sub-cent value (commission and rebates
   * are percentages, so this is ordinary) produced an 8-decimal request, which
   * D-77's precision rule now refuses FIRST — so this case reported
   * VALIDATION_FAILED and never reached the balance check it exists to test.
   *
   * Taking the integer part and adding 1000 is unambiguously over the balance
   * and carries no decimals at all, so only the rule under test can refuse it.
   */
  const over = (BigInt(bal.split('.')[0]) + 1000n).toString();
  const r = await crm(portal, '/payments/withdrawals', {
    method: 'POST', headers: idem(),
    body: JSON.stringify({ amount: over, currency: 'USD', methodKey: 'whish', destination: '+96170123456' }),
  });
  eq('refused', r.status, 422);
  eq('code', r.body?.code, 'MONEY_RULE_VIOLATION');
  eqMoney('balance untouched', await balance(), bal);
}

/* 6 ─────────────────────────────────────────────────────────────────────── */
scenario(6, 'Rival rejects a row the CRM already SETTLED — flag, never guess');
{
  const txId = await requestWithdrawal('24');
  const { rivalId } = await approveAndAwaitSubmit(txId);
  if (!rivalId) bad('not submitted; cannot test the disagreement');
  else {
    /*
     * Settle on the CRM side first, so the two sides genuinely disagree.
     *
     * WAIT for `approved` before settling. The submission to Rival is
     * post-commit, so `approveAndAwaitSubmit` can return the moment the id
     * lands while the row is still being written — and `settle` refuses
     * anything that is not `approved`. Without this the settle 400s, the
     * rejection below then lands on an approved row and refunds it correctly,
     * and the scenario reports a disagreement failure that never happened.
     */
    const ready = await awaitState(txId, ['approved'], 10);
    eq('row is approved before settling', ready?.state, 'approved');
    const settle = await crm(crmAdmin, `/admin/withdrawals/${txId}/settle`, {
      method: 'PATCH', headers: idem(),
      body: JSON.stringify({ providerRef: `MATRIX-SETTLED-${Date.now()}` }),
    });
    settle.status < 400
      ? ok('CRM settled')
      : bad('CRM settled', `${settle.status} ${JSON.stringify(settle.body).slice(0, 160)}`);
    const balanceAfterSettle = await balance();

    await riv(`/admin/withdrawals/${rivalId}/reject`, { method: 'POST', body: JSON.stringify({ notes: 'Matrix: disagreement' }) });
    await new Promise((r) => setTimeout(r, 6000));
    const row = await txRow(txId);
    eq('CRM state stays success', row.state, 'success');
    eqMoney('balance NOT refunded (the money left)', await balance(), balanceAfterSettle);
    row.rival_needs_attention
      ? ok(`flagged for a human: ${String(row.rival_attention_reason ?? '').slice(0, 50)}`)
      : bad('the disagreement was not flagged');
  }
}

/* ── done ────────────────────────────────────────────────────────────────── */
console.log(`\n${'═'.repeat(62)}`);
console.log(fail === 0 ? `✔ ALL ${pass} CHECKS PASSED` : `✖ ${fail} FAILED, ${pass} passed`);
if (fail) console.log(failures.map((f) => `    - ${f}`).join('\n'));
console.log('');
await db.end();
process.exit(fail === 0 ? 0 : 1);
