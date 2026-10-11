/**
 * A load smoke test against a RUNNING, NON-PRODUCTION API. Three phases:
 *
 *  1. ADMIN READS — the heaviest console screens (client list and search, the
 *     money desks, the KYC queue, the audit log, the dashboard) hammered by
 *     CONCURRENCY workers for DURATION seconds.
 *  2. PORTAL READS — a signed-in client's screens, the same way.
 *  3. MONEY UNDER CONTENTION — many credits racing on ONE wallet, then many
 *     copies of ONE credit racing on the same idempotency key. The wallet must
 *     move by exactly the sum of the distinct credits, and the ledger must
 *     still reconcile to the balance (ARCHITECTURE §6: the lock and the
 *     database constraints, under load rather than in a unit test).
 *
 * It PASSES only with no 5xx anywhere, reads within the latency budget, and the
 * money exact. Run it with the API started as `RELAX_RATE_LIMITS=1 npm run dev`
 * — otherwise the throttler answers 429 and this measures the throttler.
 *
 *   node scripts/load-smoke.mjs
 *   CONCURRENCY=50 DURATION=60 P95_BUDGET_MS=400 node scripts/load-smoke.mjs
 *
 * ⚠️ Phase 3 writes REAL rows in the database it points at: credits of 0.01
 * USD to the seeded client (`client@oxshare.com`). The ledger is append-only,
 * so they stay. It refuses to run against anything but localhost.
 */
import 'dotenv/config';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';

const API = process.env.API ?? 'http://localhost:3001';
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@oxshare.com',
  password: process.env.ADMIN_PASSWORD ?? 'admin123',
};
const CLIENT = {
  email: process.env.CLIENT_EMAIL ?? 'client@oxshare.com',
  password: process.env.CLIENT_PASSWORD ?? 'client123',
};
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY ?? '25', 10);
const DURATION_MS = Number.parseInt(process.env.DURATION ?? '30', 10) * 1000;
const P95_BUDGET_MS = Number.parseInt(process.env.P95_BUDGET_MS ?? '500', 10);
const RACERS = Number.parseInt(process.env.RACERS ?? '50', 10);

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(API)) {
  console.error(`Refusing: ${API} is not localhost. Phase 3 writes money rows.`);
  process.exit(2);
}

/** A signed-in session: its cookie jar and anti-forgery token. */
async function signIn(surface, credentials) {
  const origin = surface === 'admin' ? 'http://localhost:3002' : 'http://localhost:3000';
  const path = surface === 'admin' ? '/v1/admin/auth/login' : '/v1/auth/login';
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(credentials),
  });
  if (!res.ok) throw new Error(`${surface} sign-in answered ${res.status}: ${await res.text()}`);
  // An administrator's password is half a sign-in (0191): finish the authenticator step.
  const session = surface === 'admin' ? await finishAuthenticator(res, origin) : res;
  return jarOf(session, origin);
}

/** RFC 6238 (SHA-1, 6 digits, 30 s) — what the API checks. */
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/[\s=]+/g, '').toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Enrols the load test's own administrator afresh and answers the code. Only an
 * `e2e-*@oxshare.com` test account is ever reset — never a person's.
 */
async function finishAuthenticator(login, origin) {
  const body = await login
    .clone()
    .json()
    .catch(() => ({}));
  if (!body.challengeToken) return login;
  if (body.step !== 'totp_setup') {
    throw new Error(
      `${ADMIN.email} already has an authenticator. Run with ADMIN_EMAIL=e2e-admin@oxshare.com ` +
        '(a test account this script resets), never a real administrator.',
    );
  }
  const post = (path, data) =>
    fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(data),
    });
  const setup = await post('/v1/admin/auth/totp/setup', { challengeToken: body.challengeToken });
  if (!setup.ok) throw new Error(`authenticator setup answered ${setup.status}`);
  const { secret } = await setup.json();
  const verify = await post('/v1/admin/auth/totp/verify', {
    challengeToken: body.challengeToken,
    code: totp(secret),
  });
  if (!verify.ok) throw new Error(`authenticator code answered ${verify.status}`);
  return verify;
}

function jarOf(res, origin) {
  const jar = new Map();
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const at = pair.indexOf('=');
    const value = pair.slice(at + 1);
    if (value) jar.set(pair.slice(0, at), value);
  }
  return {
    origin,
    csrf: res.headers.get('x-oxshare-csrf') ?? '',
    cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

async function call(session, method, path, body, extra = {}) {
  const started = performance.now();
  const res = await fetch(API + path, {
    method,
    headers: {
      origin: session.origin,
      cookie: session.cookie(),
      ...(body ? { 'content-type': 'application/json', 'x-oxshare-csrf': session.csrf } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - started, text };
}

const pct = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

/** CONCURRENCY workers cycling through `paths` for DURATION; per-path latency and statuses. */
async function hammer(label, session, paths) {
  const stats = new Map(paths.map((p) => [p, { ms: [], statuses: {} }]));
  const deadline = Date.now() + DURATION_MS;
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const path = paths[next++ % paths.length];
        const r = await call(session, 'GET', path).catch((e) => ({
          status: 'ERR ' + e.code,
          ms: 0,
        }));
        const s = stats.get(path);
        s.ms.push(r.ms);
        s.statuses[r.status] = (s.statuses[r.status] ?? 0) + 1;
      }
    }),
  );
  let total = 0;
  let failures = 0;
  console.log(`\n── ${label}: ${CONCURRENCY} concurrent, ${DURATION_MS / 1000}s`);
  console.log('   n      p50    p95    p99    max   statuses   path');
  for (const [path, s] of stats) {
    const sorted = [...s.ms].sort((a, b) => a - b);
    total += sorted.length;
    const bad = Object.entries(s.statuses).filter(([code]) => !code.startsWith('2'));
    const slow = pct(sorted, 95) > P95_BUDGET_MS;
    if (bad.length > 0 || slow) failures++;
    const f = (v) => String(Math.round(v)).padStart(5);
    console.log(
      `${String(sorted.length).padStart(5)} ${f(pct(sorted, 50))}  ${f(pct(sorted, 95))}  ${f(pct(sorted, 99))}  ${f(sorted.at(-1))}   ${JSON.stringify(s.statuses)}${slow ? ' SLOW' : ''}   ${path}`,
    );
  }
  console.log(`   ${total} requests, ${(total / (DURATION_MS / 1000)).toFixed(0)} req/s`);
  return failures;
}

/** Decimal strings as integer units of 1e-8 — never floats (§6.1). */
const units = (s) => {
  const [whole, frac = ''] = s.split('.');
  return (
    BigInt(whole) * 100_000_000n +
    BigInt((frac + '00000000').slice(0, 8)) * (whole.startsWith('-') ? -1n : 1n)
  );
};

async function money(admin, db) {
  const {
    rows: [target],
  } = await db.query(
    `SELECT u.id AS user_id, w.id AS wallet_id, w.balance::text AS balance
       FROM users u JOIN wallets w ON w.user_id = u.id AND w.currency = 'USD' AND w.kind = 'main'
      WHERE u.email = $1`,
    [CLIENT.email],
  );
  if (!target) throw new Error(`${CLIENT.email} has no USD main wallet`);
  const credit = (key) =>
    call(
      admin,
      'POST',
      '/v1/admin/wallets/credit',
      { userId: target.user_id, amount: '0.01', currency: 'USD', reason: 'load smoke test' },
      { 'idempotency-key': key },
    );

  console.log(
    `\n── money: ${RACERS} distinct credits of 0.01 racing on one wallet, then ${RACERS} copies of one`,
  );
  const distinct = await Promise.all(Array.from({ length: RACERS }, () => credit(randomUUID())));
  const sameKey = randomUUID();
  const copies = await Promise.all(Array.from({ length: RACERS }, () => credit(sameKey)));

  const tally = (list) =>
    list.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(`   distinct keys: ${JSON.stringify(tally(distinct))}`);
  console.log(`   one key:       ${JSON.stringify(tally(copies))}`);

  const {
    rows: [after],
  } = await db.query(
    `SELECT w.balance::text AS balance,
            (SELECT balance_after::text FROM ledger_entries WHERE wallet_id = w.id
              ORDER BY created_at DESC, id DESC LIMIT 1) AS last_after,
            (SELECT count(*)::int FROM transactions t WHERE t.provider_ref = $2) AS same_key_rows
       FROM wallets w WHERE w.id = $1`,
    [target.wallet_id, sameKey],
  );
  const moved = units(after.balance) - units(target.balance);
  const credited = distinct.filter((r) => r.status === 201).length;
  const problems = [];
  if (distinct.some((r) => r.status >= 500) || copies.some((r) => r.status >= 500))
    problems.push('a 5xx under contention');
  if (credited !== RACERS) problems.push(`${RACERS - credited} distinct credit(s) not accepted`);
  if (after.same_key_rows !== 1)
    problems.push(`one key made ${after.same_key_rows} credits, not 1`);
  const expected = BigInt(credited + 1) * 1_000_000n; // 0.01 = 1,000,000 units
  if (moved !== expected) problems.push(`the wallet moved ${moved} units, expected ${expected}`);
  if (after.last_after !== after.balance)
    problems.push(`ledger balance_after ${after.last_after} ≠ wallet ${after.balance}`);
  console.log(
    `   wallet ${target.balance} → ${after.balance}; ledger last balance_after ${after.last_after}`,
  );
  console.log(problems.length === 0 ? '   money exact ✓' : `   ✗ ${problems.join('; ')}`);
  return problems.length;
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  if (/^e2e-[a-z0-9-]+@oxshare\.com$/i.test(ADMIN.email)) {
    // A test account enrols afresh each run; a real administrator is never reset.
    await db.query(
      'UPDATE admins SET totp_secret=NULL, totp_pending_secret=NULL, totp_enabled_at=NULL, ' +
        'totp_last_step=NULL WHERE email=$1',
      [ADMIN.email],
    );
  }
  const admin = await signIn('admin', ADMIN);
  const client = await signIn('portal', CLIENT);
  let failures = 0;
  failures += await hammer('admin reads', admin, [
    '/v1/admin/clients?limit=25',
    '/v1/admin/clients?limit=25&q=smith',
    '/v1/admin/clients?limit=25&sort=email&order=asc',
    '/v1/admin/transactions?limit=25',
    '/v1/admin/withdrawals?limit=25',
    '/v1/admin/wallets?limit=25',
    '/v1/admin/kyc?limit=25',
    '/v1/admin/deposits?limit=25&state=pending',
    '/v1/admin/trading-accounts?limit=25',
    '/v1/admin/clients?limit=500',
    '/v1/admin/transactions?limit=25&dir=last',
    '/v1/admin/transactions?limit=25&state=success&direction=deposit',
    '/v1/admin/transactions?limit=25&q=1500000',
    '/v1/admin/withdrawals?limit=25&state=pending',
    '/v1/admin/deposits?limit=25&state=success',
    '/v1/admin/audit-log?limit=25',
    '/v1/admin/ledger?limit=25',
    '/v1/admin/ib/accruals?limit=25',
    '/v1/admin/ib/accruals?limit=25&status=pending',
    '/v1/admin/ib/applications?limit=25',
    '/v1/admin/ib/applications?limit=25&status=pending',
    '/v1/admin/ib/partners?limit=25',
    '/v1/admin/tags',
    '/v1/admin/signup-links',
    '/v1/admin/stats/overview',
    '/v1/admin/notifications?limit=20',
  ]);
  failures += await hammer('portal reads', client, [
    '/v1/auth/me',
    '/v1/dashboard',
    '/v1/wallet',
    '/v1/kyc/status',
    '/v1/notifications?limit=20',
    '/v1/trading/accounts',
  ]);
  failures += await money(admin, db);
  console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s) above`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await db.end();
}
