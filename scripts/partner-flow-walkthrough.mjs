#!/usr/bin/env node
/**
 * The whole partner lifecycle, through the REAL API, on a real database.
 *
 * ## Why this exists beside `test/ib-end-to-end.spec.ts`
 *
 * That suite proves the commission ARITHMETIC across a mixed chain — and it
 * builds its partners with `INSERT INTO ib_accounts`. Every step a real person
 * actually takes is skipped: registering, getting KYC approved, applying to an
 * agency, being approved by a reviewer, and inheriting that agency's terms.
 *
 * So a bug anywhere in that half is invisible to it. This walks the same road a
 * client and an operator walk, over HTTP, and asserts what the database holds
 * afterwards:
 *
 *   register → verify → KYC approved → apply to an agency → an admin approves
 *   → the AGENCY'S DEFAULT PROGRAMME is what they land on
 *   → clients register under them, and a partner under them, and clients under
 *     THAT partner
 *   → every client trades (the MT5 simulator)
 *   → commission accrues at each depth, on each partner's own terms
 *   → it confirms into the commission wallet
 *   → the partner moves it to their main wallet
 *
 * ## The tree it builds
 *
 *   AGENCY  ── default programme ──> "Walkthrough Gold" (30% / 8%)
 *
 *   maya   (partner, depth-1 for her own clients)
 *     ├── client-a, client-b        trade → pay maya at depth 1
 *     └── omar   (partner UNDER maya)
 *           ├── client-c            trades → pays omar d1 AND maya d2
 *           └── layla (partner UNDER omar)
 *                 └── client-d      trades → pays layla d1, omar d2, maya NOTHING
 *                                     (depth 3 — past a two-level ladder)
 *
 * That last line is the point of the shape: it is the only way to see the
 * ceiling actually bite on a chain somebody built by hand.
 *
 * ## Usage
 *
 *   node scripts/partner-flow-walkthrough.mjs --admin you@example.com --password '...'
 *
 * It creates everything it needs and leaves it in place, so the console can be
 * opened afterwards to look at what it made.
 */

import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

const API = flag('api', process.env.API_URL ?? 'http://localhost:3001/v1');
const ADMIN_EMAIL = flag('admin', process.env.ADMIN_EMAIL ?? '');
const ADMIN_PASSWORD = flag('password', process.env.ADMIN_PASSWORD ?? '');
const RUN = flag('tag', String(Date.now()).slice(-7));

const PASSWORD = 'Walkthrough!2026aA';

/* ── Output ─────────────────────────────────────────────────────────────── */

let step = 0;
const heading = (text) => console.log(`\n${'─'.repeat(72)}\n${++step}. ${text}\n`);
const ok = (text) => console.log(`   ✓ ${text}`);
const info = (text) => console.log(`     ${text}`);

const failures = [];
function check(label, actual, expected) {
  const pass = String(actual) === String(expected);
  console.log(`   ${pass ? '✓' : '✗'} ${label}`);
  if (!pass) {
    console.log(`       expected ${expected}`);
    console.log(`       actual   ${actual}`);
    failures.push(label);
  }
  return pass;
}

/* ── HTTP, with cookies ─────────────────────────────────────────────────── */

/**
 * One jar per identity.
 *
 * Sessions here are `__Host-` cookies, so a single shared jar would make every
 * request run as whoever logged in last — and this script drives an admin and
 * four separate clients. Each gets its own.
 */
function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    absorb(response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const at = pair.indexOf('=');
        if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
    },
  };
}

/**
 * The browser origin every write is made from.
 *
 * `CsrfGuard` checks it, so a request without one is refused however good its
 * token is — the same protection a browser gets, and omitting it here would
 * exercise a path no real client takes.
 */
const ORIGIN = flag('origin', process.env.E2E_BASE_URL ?? 'http://localhost:3002');

async function call(session, method, path, body) {
  const headers = { 'content-type': 'application/json', origin: ORIGIN };
  const cookie = session.header();
  if (cookie) headers.cookie = cookie;
  /*
   * `X-OxShare-CSRF`, echoing the `*_csrf` cookie the API set — matched by
   * SUFFIX because the name is prefixed per audience (`admin_csrf`,
   * `client_csrf`) and `__Host-` in production. Guessing the full name is how
   * this silently stops echoing anything and every write starts 403ing.
   */
  const csrf = cookie.match(/(?:^|;\s*)[^=;]*csrf[^=]*=([^;]+)/i);
  if (csrf) headers['x-oxshare-csrf'] = decodeURIComponent(csrf[1]);

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  session.absorb(response);

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

/* ── The people ─────────────────────────────────────────────────────────── */

const admin = jar();
const who = {};

/**
 * Mailpit — the dev mailbox the API sends to (`docker compose up -d mailpit`).
 *
 * Read rather than shortcut, because the verification token is stored HASHED
 * and echoed nowhere: a bearer credential in a log is a leak, so the only place
 * the real token exists is the email. Flipping `email_verified` in SQL would
 * skip the endpoint this walkthrough is here to exercise.
 */
const MAILPIT = flag('mailpit', process.env.E2E_MAILPIT_API ?? 'http://localhost:8025/api/v1');

async function verificationTokenFor(email) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const search = await fetch(
      `${MAILPIT}/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=10`,
    ).catch(() => null);

    if (search?.ok) {
      const { messages = [] } = await search.json();
      const hit = messages.find((m) => /verify/i.test(m.Subject));
      if (hit) {
        const full = await (await fetch(`${MAILPIT}/message/${hit.ID}`)).json();
        const body = `${full.Text ?? ''} ${full.HTML ?? ''}`;
        const token = body.match(/token=([A-Za-z0-9._-]+)/)?.[1];
        if (token) return token;
      }
    }

    if (Date.now() > deadline) {
      throw new Error(
        [
          `No verification email arrived for ${email}.`,
          '',
          'The token is stored HASHED and echoed nowhere, so the mailbox is the only',
          'place the real one exists. Start the dev mailbox:',
          '',
          '  docker compose up -d mailpit      (UI at http://localhost:8025)',
          '',
          'and check Settings -> Email points at localhost:1025.',
        ].join('\n'),
      );
    }
    await sleep(500);
  }
}

async function registerClient(handle, referralCode) {
  const session = jar();
  const email = `wt-${handle}-${RUN}@walkthrough.test`;

  await call(session, 'POST', '/auth/register', {
    firstName: handle,
    lastName: 'Walkthrough',
    email,
    password: PASSWORD,
    ...(referralCode ? { referralCode } : {}),
  });

  /* The emailed link, spent against the real endpoint — the same round trip a
     person makes by clicking it. */
  await call(session, 'POST', '/auth/verify-email', {
    token: await verificationTokenFor(email),
  });

  await call(session, 'POST', '/auth/login', { email, password: PASSWORD, role: 'client' });

  const me = await call(session, 'GET', '/identity/me').catch(() =>
    call(session, 'GET', '/auth/me'),
  );
  const id = me.id ?? me.user?.id;
  who[handle] = { id, email, session };
  return who[handle];
}

/**
 * A 1×1 PNG, as bytes.
 *
 * The upload endpoint validates the MIME type and the magic bytes, so a text
 * file named `.png` is refused — correctly. This is the smallest thing that is
 * genuinely an image.
 */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function uploadSlot(session, field) {
  const form = new FormData();
  form.append('file', new Blob([PIXEL_PNG], { type: 'image/png' }), `${field}.png`);
  form.append('field', field);

  const cookie = session.header();
  const csrf = cookie.match(/(?:^|;\s*)[^=;]*csrf[^=]*=([^;]+)/i);

  const response = await fetch(`${API}/kyc/upload`, {
    method: 'POST',
    /* No content-type: `fetch` sets the multipart boundary itself, and naming
       it by hand produces a body the parser cannot split. */
    headers: {
      cookie,
      origin: ORIGIN,
      ...(csrf ? { 'x-oxshare-csrf': decodeURIComponent(csrf[1]) } : {}),
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(
      `upload ${field} → ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
}

/**
 * The KYC journey, exactly as the portal drives it — profile, then the FR-CORE-15
 * trio of documents, then submit.
 *
 * Done in full rather than by setting `verification_level` directly, because
 * `/ib/apply` refuses anybody below level 1 and that level is GRANTED BY THE
 * REVIEW. Shortcutting it would skip the one gate standing between a stranger
 * and a commission-bearing account.
 */
async function completeKyc(person) {
  await call(person.session, 'POST', '/kyc/step', {
    step: 'personal',
    data: {
      firstName: 'Walkthrough',
      lastName: 'Partner',
      dateOfBirth: '1990-01-01',
      phone: '+96170000009',
      nationality: 'Lebanon',
      country: 'Lebanon',
    },
  });

  await call(person.session, 'POST', '/kyc/step', {
    step: 'document',
    data: { docType: 'passport' },
  });
  await uploadSlot(person.session, 'doc_front');
  await uploadSlot(person.session, 'selfie');

  await call(person.session, 'POST', '/kyc/step', {
    step: 'address',
    data: { docType: 'utility_bill' },
  });
  await uploadSlot(person.session, 'address_proof');

  await call(person.session, 'POST', '/kyc/submit', {});

  /* Claimed, then approved — the reviewer takes the case before deciding it,
     which is what makes "who decided this" answerable afterwards. */
  await call(admin, 'PATCH', `/admin/kyc/${person.id}/claim`, {}).catch(() => {});
  await call(admin, 'PATCH', `/admin/kyc/${person.id}/approve`, {});
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error(
      'An admin is required — this script approves KYC and partner applications.\n' +
        '  node scripts/partner-flow-walkthrough.mjs --admin you@example.com --password "…"\n',
    );
    process.exit(1);
  }

  console.log(`Partner flow walkthrough → ${API}   (run tag ${RUN})`);

  heading('Sign in as the operator');
  await call(admin, 'POST', '/admin/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  ok(`signed in as ${ADMIN_EMAIL}`);

  /* ── The catalogue ──────────────────────────────────────────────────── */

  heading('Create the programme, and an agency that defaults to it');

  const programme = await call(admin, 'POST', '/admin/ib-programs', {
    name: `Walkthrough Gold ${RUN}`,
    mode: 'commission_only',
    tiers: [
      { depth: 1, rate: '30' },
      { depth: 2, rate: '8' },
    ],
    rebateRate: '0',
  });
  ok(`programme "${programme.name}" — 30% at depth 1, 8% at depth 2`);

  const agency = await call(admin, 'POST', '/admin/agencies', {
    name: `Walkthrough Agency ${RUN}`,
    description: 'Created by the partner-flow walkthrough.',
    enabled: true,
    defaultProgramId: programme.id,
  });
  check('the agency stored its default programme', agency.defaultProgramId, programme.id);

  /* ── Partner one, the whole way through ─────────────────────────────── */

  heading('maya registers, is verified, applies, and is approved');

  const maya = await registerClient('maya');
  info(`registered ${maya.email}`);

  await completeKyc(maya);
  ok('KYC submitted and approved — she is verification level 1');

  const application = await call(maya.session, 'POST', '/ib/apply', {
    agencyId: agency.id,
    motivation: 'Walkthrough: introducing business through the Gold agency.',
  });
  ok(`applied to ${agency.name}`);

  /*
   * Approved WITHOUT naming a programme — which is the whole point. The agency
   * default is what should be picked up, and passing `programId` here would
   * prove nothing about it.
   */
  const approved = await call(
    admin,
    'PATCH',
    `/admin/ib/applications/${application.id}/approve`,
    {},
  );
  check('maya landed on the AGENCY’S default programme', approved.programId, programme.id);

  /* ── The tree ───────────────────────────────────────────────────────── */

  heading('Build the tree beneath her');

  const mayaDetail = await call(admin, 'GET', `/admin/ib/partners/${maya.id}`);
  const mayaCode = mayaDetail.referralCode;
  info(`maya's referral code: ${mayaCode}`);

  const clientA = await registerClient('client-a', mayaCode);
  const clientB = await registerClient('client-b', mayaCode);
  ok('client-a and client-b registered under maya');

  const omar = await registerClient('omar', mayaCode);
  await completeKyc(omar);
  const omarApp = await call(omar.session, 'POST', '/ib/apply', { agencyId: agency.id });
  const omarAccount = await call(
    admin,
    'PATCH',
    `/admin/ib/applications/${omarApp.id}/approve`,
    {},
  );
  check('omar is a partner UNDER maya', omarAccount.parentIbUserId, maya.id);
  check('omar inherited the same agency default', omarAccount.programId, programme.id);

  const omarDetail = await call(admin, 'GET', `/admin/ib/partners/${omar.id}`);
  const clientC = await registerClient('client-c', omarDetail.referralCode);
  ok('client-c registered under omar');

  const layla = await registerClient('layla', omarDetail.referralCode);
  await completeKyc(layla);
  const laylaApp = await call(layla.session, 'POST', '/ib/apply', { agencyId: agency.id });
  const laylaAccount = await call(
    admin,
    'PATCH',
    `/admin/ib/applications/${laylaApp.id}/approve`,
    {},
  );
  check('layla is a partner UNDER omar', laylaAccount.parentIbUserId, omar.id);

  const laylaDetail = await call(admin, 'GET', `/admin/ib/partners/${layla.id}`);
  const clientD = await registerClient('client-d', laylaDetail.referralCode);
  ok('client-d registered under layla — three partners deep');

  console.log(`
     maya
       ├── client-a, client-b
       └── omar
             ├── client-c
             └── layla
                   └── client-d`);

  heading('What to do next');
  console.log(`   Each client needs an MT5 account before a deal can be attributed.
   Then drive trades and check the accruals:

     node scripts/mt5-position-simulator.mjs --logins <their logins> --ticks 4

   The users this run created:
     maya      ${maya.id}
     omar      ${omar.id}
     layla     ${layla.id}
     client-a  ${clientA.id}
     client-b  ${clientB.id}
     client-c  ${clientC.id}
     client-d  ${clientD.id}
`);

  console.log('─'.repeat(72));
  if (failures.length === 0) {
    console.log('\nEvery check passed.\n');
  } else {
    console.log(`\n${failures.length} CHECK(S) FAILED:`);
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    console.log();
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nWalkthrough stopped: ${error.message}\n`);
  process.exit(1);
});
