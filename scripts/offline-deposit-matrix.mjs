/**
 * OFFLINE DEPOSITS, end to end against the running stack — a repeatable matrix.
 *
 *   node scripts/offline-deposit-matrix.mjs
 *
 * The question it answers: is a deposit paid OUTSIDE the platform as solid as a
 * Whish one, in everything that is not the payment itself? Same bounds, same
 * decimals, same destinations, same ledger discipline, same idempotency — plus
 * the two things only this flow has: a receipt, and a person approving it.
 *
 * NOT a test-suite member and not in CI. It needs the whole stack up, and it
 * writes real rows to the dev database. `npm test` covers the same rules against
 * real Postgres in `test/offline-deposit-flow.spec.ts`; this proves the wiring
 * between the API, the guards and the two frontends' contracts.
 *
 * Every check prints the evidence it judged on, so a PASS can be disbelieved.
 */
import { randomUUID, createHash } from 'node:crypto';

const API = process.env.API ?? 'http://localhost:3001/v1';
const PORTAL = 'http://localhost:3000';
const ADMIN_ORIGIN = 'http://localhost:3002';
const OFFLINE_KEY = process.env.OFFLINE_METHOD ?? 'offline_receipt';

const results = [];
let failures = 0;
function record(name, ok, evidence) {
  results.push({ name, ok, evidence });
  if (!ok) failures += 1;
  const mark = ok === 'skip' ? '·' : ok ? '✔' : '✖';
  console.log(`  ${mark} ${name}`);
  if (evidence) console.log(`      ${evidence}`);
}

// ── a cookie jar per identity ───────────────────────────────────────────────
const jar = () => {
  const store = new Map();
  return {
    store,
    cookie: () => [...store].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
  };
};

async function call(who, path, { method = 'GET', body, origin = PORTAL, headers = {} } = {}) {
  const csrf =
    who.store.get('oxshare_crm_admin_csrf') ?? who.store.get('oxshare_crm_portal_csrf') ?? '';
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(API + path, {
    method,
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    headers: {
      cookie: who.cookie(),
      'x-oxshare-csrf': csrf,
      origin,
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
  });
  who.absorb(res);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    /*
     * The WHOLE body, not a slice. This used to truncate a non-JSON response to
     * 200 characters for readable logging, which meant the CSV-export check was
     * searching the header row for a reference that sits ~19 rows down — and it
     * reported a perfectly good export as MISSING. Truncation belongs at the
     * print, never at the parse.
     */
    parsed = text;
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

// ── fixtures ────────────────────────────────────────────────────────────────
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const HTML_PRETENDING_TO_BE_PNG = Buffer.from('<html><script>alert(1)</script></html>');
const PDF_WITH_AN_ACTION = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/OpenAction<</S/JavaScript/JS(app.alert\\(1\\))>>>>endobj\ntrailer<</Root 1 0 R>>',
);

function form(fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, String(v));
  if (file) fd.append('file', new Blob([file.bytes], { type: file.type }), file.name);
  return fd;
}

/*
 * ── THE RATE-LIMIT GOVERNOR ──────────────────────────────────────────────────
 *
 * `POST /payments/deposits/offline` carries `@Throttle 10/60s`, the same budget
 * as `POST /kyc/upload`, because both accept a file. A matrix that files more
 * than ten times a minute exhausts it and every later check fails for a reason
 * that has nothing to do with what it was testing.
 *
 * The first run of this script did exactly that, and it read as SEVEN product
 * bugs: a "broken" idempotency replay and a whole rejection flow that 400'd —
 * the latter because the throttled filing returned no id, so the next call went
 * to `/admin/deposits/undefined/reject`. Worth recording, because a rate limit
 * failing a test suite looks nothing like a rate limit.
 *
 * So the budget is tracked here rather than worked around: every filing is
 * spent, and the script waits out the window when it runs dry.
 */
const FILING_BUDGET = 10;
const WINDOW_MS = 60_000;
const spent = [];
async function spend() {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0] > WINDOW_MS) spent.shift();
    if (spent.length < FILING_BUDGET) {
      spent.push(now);
      return;
    }
    const waitMs = WINDOW_MS - (now - spent[0]) + 500;
    await pause(waitMs, 'rate-limit window');
  }
}

async function pause(ms, why) {
  process.stdout.write(`      (${why}: waiting ${Math.ceil(ms / 1000)}s)\n`);
  await new Promise((r) => setTimeout(r, ms));
}

/*
 * The local budget is an OPTIMISATION, not the authority: it starts empty on
 * every process, so running this script twice in a row spends a window the
 * second process knows nothing about — which is how a clean run became nine
 * false failures the moment it was re-run.
 *
 * So a real 429 is honoured too. The API states the wait in its own message,
 * and this obeys it rather than guessing.
 */
async function withBackoff(attempt, tries = 3) {
  let res = await attempt();
  for (let i = 1; i < tries && res.status === 429; i += 1) {
    const stated = /in (\d+) second/.exec(String(res.body?.message ?? ''))?.[1];
    const waitMs = (stated ? Number(stated) : 60) * 1000 + 1000;
    spent.length = 0;
    await pause(waitMs, 'the API said it is rate limited');
    res = await attempt();
  }
  return res;
}

const money = (s) => Number.parseFloat(String(s)); // display only — never for a decision

async function main() {
  const client = jar();
  const other = jar();
  const admin = jar();

  console.log('\n── Signing in ───────────────────────────────────────────────');
  /*
   * Through `withBackoff` because LOGIN is rate limited too, at 5 per window,
   * and this script signs in three identities. Re-run twice in a minute, the
   * third login 429s — and a 429 sets no cookie, so the request that check
   * actually cares about goes out ANONYMOUS.
   *
   * That mattered: "another client may not read this receipt" came back 401
   * instead of 403 and read as a regression. It was not one. But nor was it the
   * check passing — an anonymous refusal is a weaker claim wearing the same
   * label, and the assertion below now demands the session rather than trusting
   * the status code alone.
   */
  const signIn = (who, path, body, origin = PORTAL) =>
    withBackoff(() => call(who, path, { method: 'POST', body, origin }));

  const cl = await signIn(client, '/auth/login', {
    email: 'client@oxshare.com',
    password: 'client123',
  });
  const ad = await signIn(
    admin,
    '/admin/auth/login',
    { email: 'admin@oxshare.com', password: 'admin123' },
    ADMIN_ORIGIN,
  );
  const ot = await signIn(other, '/auth/login', {
    email: 'omar.haddad@oxtest.local',
    password: 'Client123!pass',
  });
  record(
    'client, admin and a second client can sign in',
    cl.status === 200 && ad.status === 200 && ot.status === 200,
    `client ${cl.status}, admin ${ad.status}, other ${ot.status}`,
  );
  if (cl.status !== 200 || ad.status !== 200) {
    console.log('\nCannot continue without sessions.\n');
    process.exit(1);
  }
  const otherIsSignedIn = ot.status === 200;

  console.log('\n── The method contract ──────────────────────────────────────');
  const methods = (await call(client, '/payments/methods')).body ?? [];
  const offline = methods.find((m) => m.key === OFFLINE_KEY);
  const gateway = methods.find((m) => m.requiresProof === false && m.key !== OFFLINE_KEY);
  record(
    'the offline method is offered and flagged',
    Boolean(offline?.requiresProof),
    offline
      ? `${offline.key} requiresProof=${offline.requiresProof}`
      : `no method keyed ${OFFLINE_KEY}`,
  );
  record(
    'a non-offline method is NOT flagged',
    Boolean(gateway) && gateway.requiresProof === false,
    gateway ? `${gateway.key} requiresProof=false` : 'none to compare against',
  );
  record(
    'both carry the SAME platform bounds as any deposit',
    Boolean(offline && gateway) &&
      offline.minAmount === gateway.minAmount &&
      offline.maxAmount === gateway.maxAmount,
    offline && gateway ? `min ${offline.minAmount} max ${offline.maxAmount} on both` : 'n/a',
  );
  if (!offline) {
    console.log('\nNo offline method configured — create one and re-run.\n');
    process.exit(1);
  }

  const startWallet = (await call(client, '/wallet')).body ?? [];
  const startBalance =
    (Array.isArray(startWallet) ? startWallet : (startWallet.items ?? [])).find(
      (w) => w.currency === offline.currency,
    )?.available ?? '0';

  console.log('\n── One door each: the routes refuse the wrong method ─────────');
  const jsonOffline = await call(client, '/payments/deposits', {
    method: 'POST',
    body: { amount: '50', currency: offline.currency, method: offline.key },
    headers: { 'idempotency-key': randomUUID() },
  });
  record(
    'the JSON route refuses a receipt method',
    jsonOffline.status === 400 && /receipt/i.test(String(jsonOffline.body?.message)),
    `${jsonOffline.status} ${String(jsonOffline.body?.message).slice(0, 70)}`,
  );

  if (gateway) {
    await spend();
    const key = randomUUID();
    const multiGateway = await withBackoff(() =>
      call(client, '/payments/deposits/offline', {
        method: 'POST',
        body: form(
          { amount: '50', currency: gateway.currency, method: gateway.key },
          { bytes: PNG, type: 'image/png', name: 'r.png' },
        ),
        headers: { 'idempotency-key': key },
      }),
    );
    record(
      'the offline route refuses a method that wants no receipt',
      multiGateway.status === 400,
      `${multiGateway.status} ${String(multiGateway.body?.message).slice(0, 70)}`,
    );
  }

  console.log('\n── Parity with every other deposit: the amount rules ─────────');
  const fileDeposit = async (
    amount,
    file = { bytes: PNG, type: 'image/png', name: 'receipt.png' },
    extra = {},
    key = randomUUID(),
  ) => {
    await spend();
    return withBackoff(() =>
      call(client, '/payments/deposits/offline', {
        method: 'POST',
        // Rebuilt per attempt: a FormData body is a stream and cannot be sent twice.
        body: form({ amount, currency: offline.currency, method: offline.key, ...extra }, file),
        headers: { 'idempotency-key': key },
      }),
    );
  };

  const tooSmall = await fileDeposit('1');
  record(
    'below the platform minimum is refused',
    tooSmall.status === 400,
    `${tooSmall.status} ${String(tooSmall.body?.message).slice(0, 70)}`,
  );
  const tooBig = await fileDeposit('9999999');
  record(
    'above the platform maximum is refused',
    tooBig.status === 400,
    `${tooBig.status} ${String(tooBig.body?.message).slice(0, 70)}`,
  );
  const tooPrecise = await fileDeposit('10.123456');
  record(
    'more decimals than the currency holds is refused',
    tooPrecise.status === 400,
    `${tooPrecise.status} ${String(tooPrecise.body?.message).slice(0, 70)}`,
  );
  const negative = await fileDeposit('-50');
  record(
    'a negative amount is refused',
    negative.status === 400,
    `${negative.status} ${String(negative.body?.message).slice(0, 60)}`,
  );

  console.log('\n── The receipt is checked, not trusted ──────────────────────');
  await spend();
  const noFileKey = randomUUID();
  const noFile = await withBackoff(() =>
    call(client, '/payments/deposits/offline', {
      method: 'POST',
      body: form({ amount: '50', currency: offline.currency, method: offline.key }),
      headers: { 'idempotency-key': noFileKey },
    }),
  );
  record(
    'no receipt at all is refused',
    noFile.status >= 400,
    `${noFile.status} ${String(noFile.body?.message).slice(0, 70)}`,
  );

  const htmlAsPng = await fileDeposit('50', {
    bytes: HTML_PRETENDING_TO_BE_PNG,
    type: 'image/png',
    name: 'evil.png',
  });
  record(
    'an HTML file declared image/png is refused',
    htmlAsPng.status === 400,
    `${htmlAsPng.status} — sniffed, not believed`,
  );

  const activePdf = await fileDeposit('50', {
    bytes: PDF_WITH_AN_ACTION,
    type: 'application/pdf',
    name: 'advice.pdf',
  });
  record(
    'a PDF carrying a launch action is refused',
    activePdf.status === 400,
    `${activePdf.status} — the hostile-advice case`,
  );

  const oversize = await fileDeposit('50', {
    bytes: Buffer.alloc(11 * 1024 * 1024, 1),
    type: 'image/png',
    name: 'huge.png',
  });
  record(
    'a file over the ceiling is refused',
    oversize.status === 413 || oversize.status === 400,
    `${oversize.status}`,
  );

  console.log('\n── Filing one, for real ─────────────────────────────────────');
  const idem = randomUUID();
  const filed = await fileDeposit('75', undefined, {}, idem);
  const ok = filed.status === 201;
  record(
    'a valid offline deposit is accepted',
    ok,
    ok
      ? `id ${filed.body.id} reference ${filed.body.reference}`
      : JSON.stringify(filed.body).slice(0, 120),
  );
  if (!ok) {
    summary();
    return;
  }
  const depositId = filed.body.id;

  const replay = await fileDeposit('75', undefined, {}, idem);
  record(
    'a replayed request files ONE deposit, not two',
    replay.status < 300 && replay.body?.id === depositId,
    `same id back: ${replay.body?.id === depositId}`,
  );

  const list = (await call(client, '/payments/transactions')).body ?? [];
  const rows = Array.isArray(list) ? list : (list.items ?? []);
  const mine = rows.find((r) => r.id === depositId);
  record(
    'it appears in the client history as a pending deposit',
    mine?.state === 'pending' && mine?.direction === 'deposit',
    mine ? `state=${mine.state} direction=${mine.direction} kind=${mine.kind}` : 'not in the list',
  );
  record(
    'the client can see WHICH receipt they sent',
    Boolean(mine?.proofFilename),
    mine?.proofFilename ?? 'no proofFilename on the row',
  );

  console.log('\n── Who may look at the receipt ──────────────────────────────');
  const proofPath = `/uploads/deposit-proofs/${mine?.proofFilename}`;
  const asOwner = await call(client, proofPath);
  const asAdmin = await call(admin, proofPath, { origin: ADMIN_ORIGIN });
  const asOther = await call(other, proofPath);
  const anon = await fetch(API + proofPath);
  record(
    'the owner may read their own receipt',
    asOwner.status === 200,
    `${asOwner.status} ${asOwner.headers.get('content-type')} ${asOwner.headers.get('cache-control')}`,
  );
  record('a deposits admin may read it', asAdmin.status === 200, `${asAdmin.status}`);
  record(
    'ANOTHER client may not',
    // The session is part of the claim. Without it a 401 would "pass" this while
    // proving only that anonymous readers are refused, which the next line covers.
    otherIsSignedIn ? asOther.status === 403 || asOther.status === 404 : 'skip',
    otherIsSignedIn
      ? `${asOther.status} as a signed-in client`
      : 'the second client has no session — inconclusive, not asserted',
  );
  record('nobody anonymous may', anon.status === 401, `${anon.status}`);
  record(
    'it is served no-store, so it cannot settle into a disk cache',
    /no-store/.test(asOwner.headers.get('cache-control') ?? ''),
    asOwner.headers.get('cache-control') ?? '(none)',
  );

  console.log('\n── The desk ────────────────────────────────────────────────');
  const queue = await call(admin, '/admin/transactions?direction=deposit&state=pending&limit=50', {
    origin: ADMIN_ORIGIN,
  });
  const queued = (queue.body?.items ?? []).find((r) => r.id === depositId);
  record(
    'it reaches the deposit queue with its receipt',
    Boolean(queued?.proofFilename),
    queued ? `receipt ${queued.proofFilename}` : 'not in the queue',
  );

  const adminBell = await call(admin, '/admin/notifications?limit=20', { origin: ADMIN_ORIGIN });
  const bellRows = adminBell.body?.items ?? adminBell.body ?? [];
  record(
    'the desk was rung when it was filed',
    bellRows.some((n) => n.kind === 'admin.deposit.submitted'),
    `kinds: ${[...new Set(bellRows.map((n) => n.kind))].slice(0, 4).join(', ')}`,
  );

  console.log('\n── Approving it ─────────────────────────────────────────────');
  const approve = await call(admin, `/admin/deposits/${depositId}/approve`, {
    method: 'PATCH',
    origin: ADMIN_ORIGIN,
    headers: { 'idempotency-key': `approve:${depositId}` },
  });
  record(
    'approval succeeds',
    approve.status === 200,
    `${approve.status} state=${approve.body?.state} settledAt=${approve.body?.settledAt ? 'set' : 'null'}`,
  );
  record(
    'the decided row carries the receipt path for the console',
    Boolean(approve.body?.proofPath),
    approve.body?.proofPath ?? '(none)',
  );

  const afterWallet = (await call(client, '/wallet')).body ?? [];
  const afterBalance =
    (Array.isArray(afterWallet) ? afterWallet : (afterWallet.items ?? [])).find(
      (w) => w.currency === offline.currency,
    )?.available ?? '0';
  const moved = (money(afterBalance) - money(startBalance)).toFixed(2);
  record(
    'the wallet moved by exactly the amount',
    moved === '75.00',
    `${startBalance} → ${afterBalance} (Δ ${moved})`,
  );

  const ledger = await call(client, '/wallet/ledger?limit=50');
  const entries = (ledger.body?.items ?? []).filter((e) => String(e.referenceId) === depositId);
  record(
    'exactly ONE ledger entry references this deposit',
    entries.length === 1,
    `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
  );

  const approveAgain = await call(admin, `/admin/deposits/${depositId}/approve`, {
    method: 'PATCH',
    origin: ADMIN_ORIGIN,
    headers: { 'idempotency-key': `approve-2:${depositId}` },
  });
  record(
    'a second approval is refused',
    approveAgain.status >= 400,
    `${approveAgain.status} ${String(approveAgain.body?.message).slice(0, 60)}`,
  );

  const rejectAfter = await call(admin, `/admin/deposits/${depositId}/reject`, {
    method: 'PATCH',
    origin: ADMIN_ORIGIN,
    body: { reason: 'too late' },
    headers: { 'idempotency-key': `late:${depositId}` },
  });
  record(
    'rejecting an approved deposit is refused',
    rejectAfter.status >= 400,
    `${rejectAfter.status} ${String(rejectAfter.body?.message).slice(0, 60)}`,
  );

  const balanceStill = (await call(client, '/wallet')).body;
  const stillBalance = (
    Array.isArray(balanceStill) ? balanceStill : (balanceStill.items ?? [])
  ).find((w) => w.currency === offline.currency)?.available;
  record('neither refusal moved the money', stillBalance === afterBalance, `${stillBalance}`);

  const clientBell = await call(client, '/notifications?limit=20');
  const clientKinds = (clientBell.body?.items ?? clientBell.body ?? []).map((n) => n.kind);
  record(
    'the client was told it was credited',
    clientKinds.includes('deposit.succeeded'),
    `kinds: ${[...new Set(clientKinds)].slice(0, 4).join(', ')}`,
  );

  console.log('\n── Rejecting a different one ────────────────────────────────');
  const second = await fileDeposit('60');
  const secondId = second.body?.id;
  const noReason = await call(admin, `/admin/deposits/${secondId}/reject`, {
    method: 'PATCH',
    origin: ADMIN_ORIGIN,
    body: {},
    headers: { 'idempotency-key': `none:${secondId}` },
  });
  record(
    'a rejection with no reason at all is refused',
    noReason.status === 400,
    `${noReason.status} ${String(noReason.body?.message).slice(0, 60)}`,
  );

  const reasons =
    (await call(admin, '/admin/rejection-reasons?context=deposit', { origin: ADMIN_ORIGIN }))
      .body ?? [];
  record(
    'the desk has configured deposit reasons to choose from',
    Array.isArray(reasons) && reasons.length > 0,
    `${reasons.length} reason(s), e.g. "${reasons[0]?.label ?? '—'}"`,
  );

  const beforeReject = (await call(client, '/wallet')).body;
  const beforeRejectBalance = (
    Array.isArray(beforeReject) ? beforeReject : (beforeReject.items ?? [])
  ).find((w) => w.currency === offline.currency)?.available;
  const rejected = await call(admin, `/admin/deposits/${secondId}/reject`, {
    method: 'PATCH',
    origin: ADMIN_ORIGIN,
    body: { reasonId: reasons[0]?.id, reason: 'the amount does not match' },
    headers: { 'idempotency-key': `reject:${secondId}` },
  });
  record(
    'rejection succeeds',
    rejected.status === 200 && rejected.body?.state === 'rejected',
    `${rejected.status} state=${rejected.body?.state}`,
  );
  record(
    'the stored reason joins the label and the note',
    /—/.test(String(rejected.body?.rejectionReason)),
    String(rejected.body?.rejectionReason).slice(0, 80),
  );
  record(
    'a rejected deposit settles nothing',
    rejected.body?.settledAt === null,
    `settledAt=${rejected.body?.settledAt}`,
  );

  const afterReject = (await call(client, '/wallet')).body;
  const afterRejectBalance = (
    Array.isArray(afterReject) ? afterReject : (afterReject.items ?? [])
  ).find((w) => w.currency === offline.currency)?.available;
  record(
    'NOTHING is refunded — the balance is untouched',
    afterRejectBalance === beforeRejectBalance,
    `${beforeRejectBalance} → ${afterRejectBalance}`,
  );

  const rejLedger = await call(client, '/wallet/ledger?limit=50');
  const rejEntries = (rejLedger.body?.items ?? []).filter((e) =>
    String(e.referenceId).startsWith(String(secondId)),
  );
  record(
    'and no ledger entry was written for it',
    rejEntries.length === 0,
    `${rejEntries.length} entries`,
  );

  const clientList = (await call(client, '/payments/transactions')).body ?? [];
  const rejRow = (Array.isArray(clientList) ? clientList : (clientList.items ?? [])).find(
    (r) => r.id === secondId,
  );
  record(
    'the client can read WHY on their own history',
    Boolean(rejRow?.rejectionReason),
    String(rejRow?.rejectionReason ?? '(none)').slice(0, 70),
  );

  const bell2 = await call(client, '/notifications?limit=20');
  const kinds2 = (bell2.body?.items ?? bell2.body ?? []).map((n) => n.kind);
  record(
    'the client was told it was refused',
    kinds2.includes('deposit.rejected'),
    `kinds: ${[...new Set(kinds2)].slice(0, 5).join(', ')}`,
  );

  console.log('\n── The audit trail ──────────────────────────────────────────');
  const audit = await call(admin, '/admin/audit-log?limit=50', { origin: ADMIN_ORIGIN });
  const actions = (audit.body?.items ?? []).map((a) => a.action);
  record(
    'the approval is on the audit log',
    actions.includes('deposit.approve'),
    `recent: ${[...new Set(actions)].slice(0, 6).join(', ')}`,
  );
  record('so is the rejection', actions.includes('deposit.reject'), '');
  record('and every read of a receipt', actions.includes('deposit.proof.view'), '');

  console.log('\n── Funding a TRADING ACCOUNT, exactly like a Whish deposit ───');
  const transferable = async () => {
    const res = (await call(client, '/trading/accounts/transferable')).body ?? [];
    return (Array.isArray(res) ? res : (res.items ?? [])).find(
      (a) => a.currency === offline.currency,
    );
  };
  /*
   * Opened through the REAL route if the client holds none, rather than skipped.
   * "Where does the money go" is the half of this feature that is supposed to be
   * identical to a Whish deposit, so leaving it unproven because a fixture was
   * missing would skip the most important parity check in the file.
   */
  let live = await transferable();
  if (!live) {
    const opened = await call(client, '/trading/accounts', {
      method: 'POST',
      // `environment` ONLY. The currency, group and leverage are the broker's
      // configuration rather than the client's choice, so the DTO does not
      // accept them and the whitelist refuses a request that sends one.
      body: { environment: 'live' },
      headers: { 'idempotency-key': randomUUID() },
    });
    console.log(`      (opened a live account for the test: ${opened.status})`);
    live = await transferable();
  }
  if (!live) {
    record(
      'a deposit aimed at a trading account chains a transfer',
      'skip',
      'could not obtain a live trading account',
    );
  } else {
    const countTransfers = async () => {
      const res = (await call(client, '/payments/transfers')).body ?? [];
      return (Array.isArray(res) ? res : (res.items ?? [])).filter(
        (t) => t.tradingAccountId === live.id,
      ).length;
    };
    // Counted BEFORE and AFTER. An absolute count passes on a transfer that was
    // already there, which is the assertion that proves nothing.
    const before = await countTransfers();
    const toAccount = await fileDeposit('30', undefined, { destinationTradingAccountId: live.id });
    const chainedId = toAccount.body?.id;
    record(
      'a deposit may name a trading account as its destination',
      toAccount.status === 201,
      `${toAccount.status} ${toAccount.body?.reference ?? ''}`,
    );
    const chainApprove = await call(admin, `/admin/deposits/${chainedId}/approve`, {
      method: 'PATCH',
      origin: ADMIN_ORIGIN,
      headers: { 'idempotency-key': `approve:${chainedId}` },
    });
    record(
      'approving it succeeds',
      chainApprove.status === 200,
      `${chainApprove.status} state=${chainApprove.body?.state}`,
    );
    // The chaining is post-commit and asynchronous, exactly as it is for a
    // gateway deposit — so this polls rather than sleeping a fixed guess.
    let after = before;
    for (let i = 0; i < 12 && after === before; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      after = await countTransfers();
    }
    record(
      'approval chains EXACTLY ONE transfer on to that account',
      after === before + 1,
      `${before} → ${after} transfer(s) on account ${live.login ?? live.id}`,
    );

    // And a replayed approval must not chain a second one.
    await call(admin, `/admin/deposits/${chainedId}/approve`, {
      method: 'PATCH',
      origin: ADMIN_ORIGIN,
      headers: { 'idempotency-key': `approve-replay:${chainedId}` },
    });
    await new Promise((r) => setTimeout(r, 2000));
    record(
      'a replayed approval chains no second transfer',
      (await countTransfers()) === after,
      `still ${after}`,
    );
  }

  console.log('\n── The rest of the system treats it as an ordinary deposit ──');
  /*
   * The point of this phase: the offline flow is supposed to differ from a Whish
   * one ONLY in how the money arrives. Everything downstream — the ledger's
   * integrity check, the finance export, the money list's filters — must not
   * know or care which door it came through.
   */
  const recon = await call(admin, '/admin/reconciliation', { origin: ADMIN_ORIGIN });
  const discrepancies = recon.body?.discrepancies ?? recon.body?.issues ?? [];
  record(
    'the ledger still reconciles against every wallet',
    recon.status === 200 && discrepancies.length === 0,
    `${recon.status}, ${discrepancies.length} discrepanc${discrepancies.length === 1 ? 'y' : 'ies'}`,
  );

  const csv = await call(admin, '/admin/transactions/export?format=csv&direction=deposit', {
    origin: ADMIN_ORIGIN,
  });
  const csvText = csv.text ?? '';
  record(
    'it exports in the finance CSV like any other deposit',
    csv.status === 200 && csvText.includes(filed.body.reference),
    `${csv.status}, reference ${filed.body.reference} ${csvText.includes(filed.body.reference) ? 'present' : 'MISSING'}`,
  );

  // The one route that is genuinely gateway-only: polling a provider for the
  // state of a redirect. An offline deposit has no provider to poll, and the
  // route must say so rather than answer about a row it cannot speak for.
  const pollOffline = await call(
    client,
    `/payments/deposits/${filed.body.reference}/status?method=${offline.key}`,
  );
  record(
    'the gateway status poll refuses an offline deposit',
    pollOffline.status >= 400,
    `${pollOffline.status} ${String(pollOffline.body?.message).slice(0, 60)}`,
  );

  /*
   * The money list calls it `providerRef`, and it must be the SAME string the
   * client was handed at submit — that reference is what a client quotes to
   * support and what an operator matches against a bank line. A deposit whose
   * console reference differs from the client's receipt is unreconcilable.
   *
   * NOT asserted through `?q=`: that search covers email and name only, for
   * gateway and offline deposits alike. See the note in the run summary.
   */
  const listed = await call(admin, `/admin/transactions?direction=deposit&limit=50`, {
    origin: ADMIN_ORIGIN,
  });
  const listedRow = (listed.body?.items ?? []).find((r) => r.id === depositId);
  record(
    'the money list carries the same reference the client was given',
    listedRow?.providerRef === filed.body.reference,
    `console ${listedRow?.providerRef ?? '(none)'} vs client ${filed.body.reference}`,
  );

  console.log('\n── Side by side with a REAL gateway deposit ─────────────────');
  /*
   * The acceptance criterion in the owner's own words: an offline deposit must
   * be "as if I'm depositing with the old method in everything in the whole
   * system — it just differs that it requires the proof of payment".
   *
   * So this compares a settled offline deposit against a settled GATEWAY one,
   * field by field, and asserts that the ONLY difference is the receipt. It
   * skips when the database holds no gateway deposit, because asserting parity
   * against nothing is how a parity claim becomes decoration.
   */
  const settled = await call(
    admin,
    '/admin/transactions?direction=deposit&state=success&limit=100',
    { origin: ADMIN_ORIGIN },
  );
  const settledRows = settled.body?.items ?? [];
  const gatewayRow = settledRows.find((r) => !String(r.provider ?? '').startsWith('manual_'));
  const offlineRow = settledRows.find((r) => r.provider === `manual_${offline.key}`);

  if (!gatewayRow || !offlineRow) {
    record(
      'the two deposits differ ONLY by the receipt',
      'skip',
      gatewayRow
        ? 'no settled offline deposit to compare'
        : 'no settled GATEWAY deposit in this database to compare against',
    );
  } else {
    // Shape, not values: the amount and the reference SHOULD differ. What must
    // match is which fields carry something at all.
    const shapeOf = (r) =>
      Object.fromEntries(
        Object.entries(r)
          .filter(
            ([k]) =>
              ![
                'id',
                'amount',
                'createdAt',
                'settledAt',
                'providerRef',
                'provider',
                'methodName',
                'user',
                'walletId',
                'rivalExternalId',
                'tradingAccountId',
                'destination',
              ].includes(k),
          )
          .map(([k, v]) => [k, v === null || v === undefined ? 'absent' : 'present']),
      );
    const a = shapeOf(gatewayRow);
    const b = shapeOf(offlineRow);
    const differing = Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
    record(
      'the two deposits differ ONLY by the receipt',
      differing.length === 1 && differing[0] === 'proofFilename',
      `gateway ${gatewayRow.provider} vs ${offlineRow.provider}; differing fields: ${differing.join(', ') || 'none'}`,
    );
    record(
      'both are the same kind, direction and state to every screen',
      gatewayRow.kind === offlineRow.kind &&
        gatewayRow.direction === offlineRow.direction &&
        gatewayRow.state === offlineRow.state,
      `kind=${offlineRow.kind} direction=${offlineRow.direction} state=${offlineRow.state} on both`,
    );
  }

  console.log('\n── The rate limit is real ───────────────────────────────────');
  /*
   * Deliberately spent, LAST, so the sixty seconds it costs are paid after every
   * other check has run. Eleven filings inside one window: the eleventh must be
   * refused. Asserted rather than assumed because a limit that silently stopped
   * applying would look exactly like a healthy route.
   *
   * The amount is BELOW the minimum on purpose, so each of the eleven is refused
   * on its merits and files nothing. The throttler runs before validation, so
   * the budget is spent either way — this proves the limit without leaving ten
   * junk deposits in the queue behind it.
   */
  // Waits for a clear window first, so the burst measures the limit rather than
  // whatever budget the rest of the matrix happened to leave behind. It does not
  // use `withBackoff` — a 429 is the ANSWER here, not an obstacle.
  const oldest = spent[0];
  if (spent.length && Date.now() - oldest < WINDOW_MS) {
    await pause(WINDOW_MS - (Date.now() - oldest) + 500, 'clearing the window before the burst');
  }
  const burst = [];
  for (let i = 0; i < FILING_BUDGET + 1; i += 1) {
    burst.push(
      await call(client, '/payments/deposits/offline', {
        method: 'POST',
        body: form(
          { amount: '1', currency: offline.currency, method: offline.key },
          { bytes: PNG, type: 'image/png', name: 'burst.png' },
        ),
        headers: { 'idempotency-key': randomUUID() },
      }),
    );
  }
  record(
    'the eleventh filing in one minute is refused',
    burst.some((r) => r.status === 429),
    `statuses: ${burst.map((r) => r.status).join(' ')}`,
  );

  summary();
}

function summary() {
  const ran = results.filter((r) => r.ok !== 'skip').length;
  const skipped = results.filter((r) => r.ok === 'skip').length;
  console.log('\n══════════════════════════════════════════════════════════════');
  if (failures === 0) {
    console.log(`  ALL ${ran} CHECKS PASSED${skipped ? ` (${skipped} skipped)` : ''}`);
  } else {
    console.log(`  ${failures} of ${ran} CHECKS FAILED`);
    for (const r of results.filter((x) => x.ok === false))
      console.log(`    ✖ ${r.name} — ${r.evidence}`);
  }
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(failures === 0 ? 0 : 1);
}

void createHash; // kept for parity with the sibling scripts' imports
main().catch((error) => {
  console.error('\nThe matrix could not finish:', error);
  process.exit(1);
});
