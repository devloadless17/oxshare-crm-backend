/**
 * The money rails, end to end, against a LOCAL Rival — a repeatable smoke test.
 *
 * Answers the question you actually want answered before testing by hand: is the
 * whole chain live right now?
 *
 *   client → CRM → Rival → (webhook back) → CRM ledger
 *
 * It funds a wallet, requests a withdrawal, approves it, watches the CRM submit
 * it to Rival, and reports where it got to. Nothing here is mocked: every hop is
 * a real HTTP call against the running stack.
 *
 *   node scripts/rival-rail-smoke.mjs
 *
 * NOT a test-suite member and not in CI — it needs the whole stack up (CRM API,
 * Rival API, and the tunnel if you want the inbound webhook). `npm test` covers
 * the same rules against real Postgres without any of that.
 *
 * ## What "approved" proves
 *
 * With the payout rail enabled, approval must leave the row in `approved` with a
 * null `settledAt`, and a `rivalWithdrawalId` must appear moments later. That is
 * the two-lifecycle rule from DECISIONS D-66: a rail-backed withdrawal is
 * AUTHORISED by approval and only settled when the provider says the money left.
 * If this ever prints `success` straight after approval, the rail has been
 * bypassed and the client has been told they were paid before anybody paid them.
 */
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';

loadEnv();

const CRM = process.env.SMOKE_CRM ?? 'http://localhost:3001/v1';
const CLIENT = {
  email: process.env.SMOKE_CLIENT_EMAIL ?? 'client@oxshare.com',
  password: process.env.SMOKE_CLIENT_PASSWORD ?? 'client123',
};
const ADMIN = {
  email: process.env.SMOKE_ADMIN_EMAIL ?? 'admin@oxshare.com',
  password: process.env.SMOKE_ADMIN_PASSWORD ?? 'admin123',
};
const AMOUNT = process.env.SMOKE_AMOUNT ?? '25';
const FUND = process.env.SMOKE_FUND ?? '500';

/** Every money write needs one — §6.3: idempotency belongs in the request. */
const idem = () => ({ 'idempotency-key': randomUUID() });

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
        // Login CLEARS a pile of legacy cookie names by re-setting them expired.
        // A jar that ignores expiry keeps the empty ones and sends the wrong CSRF.
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

let failures = 0;
const ok = (m) => console.log(`    ✔ ${m}`);
const bad = (m) => { failures += 1; console.log(`    ✖ ${m}`); };
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const brief = (b) => JSON.stringify(b).slice(0, 220);

const portal = makeJar();
const admin = makeJar();

console.log(`\nRival rail smoke — CRM ${CRM}`);

step(1, 'Sign in');
const clientLogin = await call(portal, 'portal', '/auth/login', { method: 'POST', body: JSON.stringify(CLIENT) });
clientLogin.status < 400 ? ok(`client ${CLIENT.email}`) : bad(`client login → ${clientLogin.status} ${brief(clientLogin.body)}`);
const adminLogin = await call(admin, 'admin', '/admin/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) });
adminLogin.status < 400 ? ok(`admin ${ADMIN.email}`) : bad(`admin login → ${adminLogin.status} ${brief(adminLogin.body)}`);
if (failures) process.exit(1);

const me = await call(portal, 'portal', '/auth/me');
const userId = me.body?.id;

step(2, 'The Rival connection is live');
const test = await call(admin, 'admin', '/admin/settings/rival/test', { method: 'POST', body: JSON.stringify({}) });
test.body?.ok ? ok('CRM reached Rival and the key was accepted') : bad(`test → ${test.status} ${brief(test.body)}`);
const railOn = Boolean(test.body?.ok && test.body?.rivalCrmConfig?.enabled);
console.log(`      webhook target: ${test.body?.rivalCrmConfig?.apiUrl ?? '(none)'}`);

step(3, `Fund the wallet (+${FUND} USD, admin credit)`);
const credit = await call(admin, 'admin', '/admin/wallets/credit', {
  method: 'POST', headers: idem(),
  body: JSON.stringify({ userId, currency: 'USD', amount: FUND, reason: 'Local rail smoke' }),
});
credit.status < 400 ? ok('credited') : bad(`credit → ${credit.status} ${brief(credit.body)}`);

const balance = async () => {
  const w = await call(portal, 'portal', '/wallet');
  return (w.body ?? []).find((x) => x.currency === 'USD')?.balance ?? '0';
};
const before = await balance();
console.log(`      balance: ${before}`);

step(4, `Client requests a ${AMOUNT} USD withdrawal (debits on request)`);
const wd = await call(portal, 'portal', '/payments/withdrawals', {
  method: 'POST', headers: idem(),
  body: JSON.stringify({ amount: AMOUNT, currency: 'USD', methodKey: 'whish', destination: '+96170123456' }),
});
if (wd.status >= 400) { bad(`withdrawal → ${wd.status} ${brief(wd.body)}`); process.exit(1); }
const txId = wd.body.id;
ok(`pending, id ${txId}`);
const afterDebit = await balance();
afterDebit !== before ? ok(`balance moved ${before} → ${afterDebit}`) : bad('balance did not move — the debit did not post');

step(5, 'Admin approves');
const approve = await call(admin, 'admin', `/admin/withdrawals/${txId}/approve`, {
  method: 'PATCH', headers: idem(), body: JSON.stringify({}),
});
if (approve.status >= 400) { bad(`approve → ${approve.status} ${brief(approve.body)}`); process.exit(1); }
const state = approve.body?.state;
console.log(`      state=${state}  settledAt=${approve.body?.settledAt ?? 'null'}`);

if (railOn) {
  // D-66: the rail lifecycle. Anything else means the payout was skipped.
  state === 'approved'
    ? ok('AUTHORISED, not paid — the rail lifecycle (D-66)')
    : bad(`expected 'approved' with the rail on, got '${state}' — the payout rail was BYPASSED`);
} else {
  state === 'success'
    ? ok('paid in one step — the desk lifecycle, correct with the rail off')
    : bad(`expected 'success' with the rail off, got '${state}'`);
}

step(6, 'The CRM submits to Rival (post-commit, so give it a moment)');
let row = null;
for (let i = 0; i < 10 && !row?.rivalWithdrawalId; i += 1) {
  await new Promise((r) => setTimeout(r, 1500));
  const q = await call(admin, 'admin', '/admin/withdrawals?limit=10');
  row = (q.body?.items ?? []).find((r) => r.id === txId) ?? row;
}
if (!railOn) {
  ok('skipped — the rail is off');
} else if (row?.rivalWithdrawalId) {
  ok(`Rival has it: ${row.rivalWithdrawalId}`);
} else {
  bad(`no rivalWithdrawalId after 15s — check needsAttention: ${brief(row ?? {})}`);
}

console.log(`\n${'═'.repeat(62)}`);
if (failures === 0) {
  console.log('✔ The rail is live end to end.');
  console.log(`\n  transaction : ${txId}`);
  if (row?.rivalWithdrawalId) {
    console.log(`  in Rival    : ${row.rivalWithdrawalId}`);
    console.log('\n  Finish it from Rival (localhost:4000) — approving or rejecting there');
    console.log('  delivers the webhook that settles or refunds this row.');
  }
} else {
  console.log(`✖ ${failures} check(s) failed.`);
}
console.log('');
process.exit(failures === 0 ? 0 : 1);
