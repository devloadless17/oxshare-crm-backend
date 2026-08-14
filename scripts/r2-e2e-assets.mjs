/**
 * The three upload paths the KYC end-to-end script does NOT cover.
 *
 *   1. DUAL-READ of a genuinely pre-existing document — one written to this host's
 *      disk before the R2 move, with no row in `stored_objects` and no object in
 *      the bucket. This is the compatibility promise the migration rests on, and it
 *      is the one thing that cannot be simulated: it needs a real legacy file.
 *   2. AVATARS — client and admin, including the ownership check that stops one
 *      client fetching another's photo.
 *   3. PAYMENT LOGOS — including SVG, which is the only accepted type with no magic
 *      bytes, and the conditional (304) path that only these two buckets offer.
 *
 * Run with the backend up:  node scripts/r2-e2e-assets.mjs
 * Not in CI: it needs a running server and it bills the bucket.
 */

import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

loadEnv();

const API = process.env.E2E_API ?? 'http://localhost:3001/v1';
const CSRF_HEADER = 'x-oxshare-csrf';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
  responseChecksumValidation: 'WHEN_REQUIRED',
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
const BUCKET = process.env.R2_BUCKET;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
);

let pass = 0;
let fail = 0;
const failures = [];
const created = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`    ✔ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`    ✖ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

/** One cookie jar per identity, honouring expiry (login clears legacy names). */
function makeJar() {
  const jar = new Map();
  return {
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    csrf: (kind) => jar.get(`oxshare_crm_${kind}_csrf`) ?? '',
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair, ...attrs] = raw.split(';');
        const i = pair.indexOf('=');
        if (i <= 0) continue;
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        const expired = attrs.some((a) => {
          const [k, v] = a.split('=').map((x) => x.trim().toLowerCase());
          if (k === 'max-age') return Number(v) <= 0;
          if (k === 'expires') return new Date(v).getTime() <= Date.now();
          return false;
        });
        if (expired || value === '') jar.delete(name);
        else jar.set(name, value);
      }
    },
  };
}

async function call(jar, kind, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie: jar.header(),
      [CSRF_HEADER]: jar.csrf(kind),
      origin:
        kind === 'admin'
          ? (process.env.ADMIN_URL ?? 'http://localhost:3002')
          : (process.env.PORTAL_URL ?? 'http://localhost:3000'),
      ...(init.headers ?? {}),
    },
    redirect: 'manual',
  });
  jar.absorb(res);
  return res;
}

async function signIn(jar, kind, email, password) {
  const path = kind === 'admin' ? '/admin/auth/login' : '/auth/login';
  const res = await call(jar, kind, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res;
}

async function main() {
  await db.connect();
  console.log(`\nAssets & dual-read end-to-end — API ${API}, bucket ${BUCKET}`);

  // ═══ 1. DUAL-READ ════════════════════════════════════════════════════════
  section('dual-read: a document written BEFORE the R2 move');

  const legacy = await db.query(
    `SELECT u.id, u.email, s.document->>'frontFilePath' AS path
       FROM kyc_submissions s JOIN users u ON u.id = s.user_id
      WHERE s.document->>'frontFilePath' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stored_objects o
           WHERE o.storage_key = 'kyc/' || split_part(s.document->>'frontFilePath', '/', 3)
        )
      LIMIT 1`,
  );

  if (legacy.rows.length === 0) {
    console.log('    ⚠ no pre-R2 document found in this database — skipping');
  } else {
    const { email, path } = legacy.rows[0];
    const filename = path.split('/').pop();
    console.log(`    using ${email}'s ${filename}`);

    // It is genuinely NOT in the bucket — otherwise this proves nothing.
    const inBucket = await s3
      .send(new HeadObjectCommand({ Bucket: BUCKET, Key: `kyc/${filename}` }))
      .then(() => true)
      .catch(() => false);
    check('the legacy document is absent from R2 (so the fallback is what answers)', !inBucket);

    const jar = makeJar();
    const login = await signIn(
      jar,
      'portal',
      email,
      process.env.E2E_LEGACY_PASSWORD ?? 'client123',
    );

    if (!login.ok) {
      console.log(
        `    ⚠ cannot sign in as ${email} (${login.status}) — reading as an admin instead`,
      );
      const admin = makeJar();
      const adminLogin = await signIn(
        admin,
        'admin',
        process.env.E2E_ADMIN_EMAIL ?? 'admin@oxshare.com',
        process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
      );
      check('signed in as an admin reviewer', adminLogin.ok, String(adminLogin.status));

      const res = await call(admin, 'admin', `/uploads/kyc/${filename}`);
      const body = Buffer.from(await res.arrayBuffer());
      check(
        'the legacy document still opens for a reviewer',
        res.status === 200,
        String(res.status),
      );
      check('its bytes come back', body.length > 0, `${body.length} bytes`);
      check(
        'served with the same security headers as an R2-stored one',
        res.headers.get('x-content-type-options') === 'nosniff' &&
          (res.headers.get('cache-control') ?? '').includes('no-store'),
      );
    } else {
      const res = await call(jar, 'portal', `/uploads/kyc/${filename}`);
      const body = Buffer.from(await res.arrayBuffer());
      check(
        'the legacy document still opens for its owner',
        res.status === 200,
        String(res.status),
      );
      check('its bytes come back', body.length > 0, `${body.length} bytes`);
    }

    // And the read left no phantom row claiming R2 holds it.
    const phantom = await db.query(`SELECT 1 FROM stored_objects WHERE storage_key = $1`, [
      `kyc/${filename}`,
    ]);
    check('reading it did not invent a registry row', phantom.rows.length === 0);
  }

  // ═══ 2. CLIENT AVATAR ════════════════════════════════════════════════════
  section('client avatar');
  const portal = makeJar();
  const clientLogin = await signIn(
    portal,
    'portal',
    process.env.E2E_CLIENT_EMAIL ?? 'client@oxshare.com',
    process.env.E2E_CLIENT_PASSWORD ?? 'client123',
  );
  check('signed in as the client', clientLogin.ok, String(clientLogin.status));

  if (clientLogin.ok) {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'me.png');
    const up = await call(portal, 'portal', '/auth/me/avatar', { method: 'POST', body: form });
    const upBody = await up.json().catch(() => ({}));
    check('avatar uploaded', up.ok, `${up.status} ${JSON.stringify(upBody)}`);

    if (up.ok) {
      const url = String(upBody.avatarUrl ?? '');
      const filename = url.split('/').pop();
      created.push(`avatars/${filename}`);
      check(
        'the response is a PATH on our API, never an R2 URL',
        url.startsWith('/uploads/avatars/'),
        url,
      );

      const head = await s3
        .send(new HeadObjectCommand({ Bucket: BUCKET, Key: `avatars/${filename}` }))
        .catch(() => null);
      check('the avatar really is in R2', head !== null);
      check(
        'with a Cache-Control stored on the object',
        head?.CacheControl?.includes('private'),
        head?.CacheControl,
      );

      const get = await call(portal, 'portal', `/uploads/avatars/${filename}`);
      const bytes = Buffer.from(await get.arrayBuffer());
      check('the owner can fetch it', get.status === 200, String(get.status));
      check('the bytes match', bytes.equals(PNG));
      check(
        'private cache, not public',
        (get.headers.get('cache-control') ?? '').includes('private'),
      );

      /*
       * The conditional path — offered on avatars and logos, and deliberately NOT
       * on KYC documents (those are `no-store`). A 304 means a revalidation moved
       * no bytes at all, which is the whole point of caching a photo every screen
       * renders.
       */
      const etag = get.headers.get('etag');
      check('an ETag is offered', Boolean(etag), String(etag));
      if (etag) {
        const revalidate = await call(portal, 'portal', `/uploads/avatars/${filename}`, {
          headers: { 'if-none-match': etag },
        });
        check(
          'revalidating returns 304 Not Modified',
          revalidate.status === 304,
          String(revalidate.status),
        );
        check('and carries no body', (await revalidate.arrayBuffer()).byteLength === 0);
      }

      const anon = await fetch(`${API}/uploads/avatars/${filename}`, { redirect: 'manual' });
      check('an avatar is NOT public', anon.status === 401, String(anon.status));
    }
  }

  // ═══ 3. PAYMENT LOGO (admin, and the SVG case) ═══════════════════════════
  section('payment-method logo');
  const admin = makeJar();
  const adminLogin = await signIn(
    admin,
    'admin',
    process.env.E2E_ADMIN_EMAIL ?? 'admin@oxshare.com',
    process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
  );
  check('signed in as the admin', adminLogin.ok, String(adminLogin.status));

  if (adminLogin.ok) {
    for (const [label, bytes, mime, ext] of [
      ['PNG', PNG, 'image/png', 'png'],
      ['SVG', SVG, 'image/svg+xml', 'svg'],
    ]) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mime }), `logo.${ext}`);
      const up = await call(admin, 'admin', '/admin/payment-methods/logo', {
        method: 'POST',
        body: form,
      });
      const body = await up.json().catch(() => ({}));
      check(`${label} logo uploaded`, up.ok, `${up.status} ${JSON.stringify(body)}`);
      if (!up.ok) continue;

      const filename = String(body.logoUrl ?? '')
        .split('/')
        .pop();
      created.push(`payment-logos/${filename}`);

      const head = await s3
        .send(new HeadObjectCommand({ Bucket: BUCKET, Key: `payment-logos/${filename}` }))
        .catch(() => null);
      check(`${label} logo is in R2`, head !== null);
      check(
        `${label} logo cached publicly on the object`,
        head?.CacheControl?.includes('public'),
        head?.CacheControl,
      );

      // PUBLIC, unlike everything else — it is a brand mark on the deposit screen.
      const anon = await fetch(`${API}/uploads/payment-logos/${filename}`, { redirect: 'manual' });
      const anonBytes = Buffer.from(await anon.arrayBuffer());
      check(`${label} logo is served without a session`, anon.status === 200, String(anon.status));
      check(`${label} bytes match`, anonBytes.equals(bytes));

      /*
       * ⚠️ The SVG pair. An SVG is a DOCUMENT and can carry <script>; it is only
       * safe here because the Content-Type is declared AND the CSP sandboxes it.
       * Both halves are asserted, because dropping either silently reintroduces
       * stored XSS — and the last time the type was missing, the logo simply did
       * not render and nobody knew why.
       */
      check(
        `${label} Content-Type declared`,
        anon.headers.get('content-type') === mime,
        anon.headers.get('content-type'),
      );
      const csp = anon.headers.get('content-security-policy') ?? '';
      check(
        `${label} CSP sandboxed`,
        csp.includes("default-src 'none'") && csp.includes('sandbox'),
        csp,
      );
      if (label === 'SVG') {
        check(
          'the SVG CSP still permits its OWN stylesheet (colour survives)',
          csp.includes("style-src 'unsafe-inline'"),
          csp,
        );
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('cleanup');
  for (const key of created) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
  }
  await db.query(`DELETE FROM stored_objects WHERE storage_key = ANY($1)`, [created]);
  console.log(`    ✔ removed ${created.length} object(s) and their rows`);

  console.log(`\n${'═'.repeat(62)}`);
  console.log(fail === 0 ? `✔ ALL ${pass} CHECKS PASSED` : `✖ ${fail} FAILED, ${pass} passed`);
  if (fail > 0) console.log(failures.map((f) => `    - ${f}`).join('\n'));
  console.log('');
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`\n✖ ABORTED: ${e?.message ?? e}\n`);
  for (const key of created) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
  }
  await db.end().catch(() => {});
  process.exit(1);
});
