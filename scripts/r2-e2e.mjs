/**
 * End-to-end upload verification against the RUNNING system and the LIVE bucket.
 *
 * This is the check that no unit test can make. The suite runs against an in-memory
 * driver, `r2:verify` proves the credentials, and the driver contract spec proves the
 * driver — but none of them exercise the real chain:
 *
 *   browser → Next rewrite → Nest guards → CSRF → multer → magic-byte sniff →
 *   quota → R2 → stored_objects → authorization → audit → stream back
 *
 * Run it by hand, with the backend up (`npm run dev`) and Postgres running:
 *
 *   node scripts/r2-e2e.mjs
 *
 * It logs in as the seeded client, uploads every accepted type and every rejected
 * one, reads each back through the authenticated route, and checks the bytes against
 * both the live bucket and the registry. It cleans up after itself.
 *
 * NOT in CI. It needs a running server and it bills the bucket.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

loadEnv();

const API = process.env.E2E_API ?? 'http://localhost:3001/v1';
const CLIENT_EMAIL = process.env.E2E_CLIENT_EMAIL ?? 'client@oxshare.com';
const CLIENT_PASSWORD = process.env.E2E_CLIENT_PASSWORD ?? 'client123';
const CSRF_HEADER = 'x-oxshare-csrf';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  maxAttempts: 3,
  forcePathStyle: true,
  responseChecksumValidation: 'WHEN_REQUIRED',
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
const BUCKET = process.env.R2_BUCKET;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

// ── Fixtures: real files of every accepted type, and the ones that must fail ──

/** A genuine 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** A genuine 1x1 JPEG. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);
/** A genuine minimal WebP (RIFF....WEBP). */
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
/** A genuine minimal PDF, multi-object so a range read is meaningful. */
const PDF = Buffer.concat([
  Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n',
  ),
  Buffer.from('% padding '.repeat(400)),
  Buffer.from('\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
]);
/** HEIC: a real ftypheic box. Genuinely an image, and deliberately NOT accepted. */
const HEIC = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypheic'),
  Buffer.alloc(64, 0x11),
]);
const HTML = Buffer.from('<!DOCTYPE html><html><script>alert(document.cookie)</script></html>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 1)]);

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`    ✔ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`    ✖ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ── A cookie jar, because the whole point is to drive the real session ───────
const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Absorb Set-Cookie, HONOURING EXPIRY.
 *
 * Login deliberately clears a pile of legacy cookie names (`oxshare_portal_csrf`
 * and friends) by re-setting them with a 1970 expiry, alongside the real
 * `oxshare_crm_*` ones. A jar that ignores expiry keeps the cleared values, and
 * since they are set FIRST a loose name match then picks the empty one — which is
 * exactly how this script got a 403 on every upload while the browser worked fine.
 *
 * A real browser drops them. So does this.
 */
function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();

    const expired = attrs.some((a) => {
      const [k, v] = a.split('=').map((x) => x.trim().toLowerCase());
      if (k === 'max-age') return Number(v) <= 0;
      if (k === 'expires') return new Date(v).getTime() <= Date.now();
      return false;
    });

    if (expired || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

/** The EXACT cookie the portal's CsrfGuard reads — never a substring match. */
function csrfToken() {
  return jar.get('oxshare_crm_portal_csrf') ?? '';
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      cookie: cookieHeader(),
      [CSRF_HEADER]: csrfToken(),
      origin: process.env.PORTAL_URL ?? 'http://localhost:3000',
      ...(init.headers ?? {}),
    },
    redirect: 'manual',
  });
  absorb(res);
  return res;
}

/**
 * Upload one file to the KYC endpoint.
 *
 * The route is throttled to 10/min per client ON PURPOSE — it writes megabytes, and
 * the comment on that decorator explains why it is the tightest limit in the app. A
 * script driving ~20 uploads therefore has to pace itself, and a 429 here is the
 * throttle working rather than a failure. `waitForThrottle` retries once after the
 * window rolls, so a legitimate refusal is still distinguishable from a rate limit.
 */
async function upload(bytes, filename, contentType, field = 'doc_front') {
  const send = () => {
    const form = new FormData();
    form.append('field', field);
    form.append('file', new Blob([bytes], { type: contentType }), filename);
    return api('/kyc/upload', { method: 'POST', body: form });
  };

  let res = await send();
  if (res.status === 429) {
    process.stdout.write('      … throttled (10/min, by design); waiting for the window\n');
    await new Promise((r) => setTimeout(r, 61_000));
    res = await send();
  }
  return res;
}

const uploadedKeys = [];

async function main() {
  await db.connect();
  console.log(`\nUpload end-to-end — API ${API}, bucket ${BUCKET}`);

  // ── Sign in ───────────────────────────────────────────────────────────────
  section('session');
  const login = await api('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: CLIENT_EMAIL, password: CLIENT_PASSWORD }),
  });
  check(`logged in as ${CLIENT_EMAIL}`, login.ok, `${login.status} ${await login.text()}`);
  if (!login.ok) throw new Error('cannot continue without a session');

  const me = await api('/auth/me');
  const profile = await me.json();
  const userId = profile?.id ?? profile?.user?.id;
  check('resolved the client id', Boolean(userId), JSON.stringify(profile).slice(0, 200));

  // ── Every ACCEPTED type ───────────────────────────────────────────────────
  section('accepted types');
  /*
   * Each type goes to a DIFFERENT KYC field, and that detail is load-bearing.
   *
   * `attachFile` OVERWRITES the path for the field it is given, so four uploads to
   * `doc_front` leave only the last one referenced by the submission — and
   * `submissionReferencesFile` then correctly refuses the other three. That is the
   * ownership check doing its job, not a bug: a client may read the documents their
   * submission points at, and a replaced document is no longer one of them.
   *
   * (The first run of this script did exactly that and read the 403s as failures.
   * Worth keeping the note: it is the same shape as a real support report — "I
   * uploaded my passport and now I cannot open it" means it was replaced.)
   */
  const accepted = [
    {
      name: 'PNG',
      bytes: PNG,
      filename: 'id.png',
      declared: 'image/png',
      ext: '.png',
      field: 'doc_front',
    },
    {
      name: 'JPEG',
      bytes: JPEG,
      filename: 'id.jpg',
      declared: 'image/jpeg',
      ext: '.jpg',
      field: 'doc_back',
    },
    {
      name: 'WebP',
      bytes: WEBP,
      filename: 'selfie.webp',
      declared: 'image/webp',
      ext: '.webp',
      field: 'selfie',
    },
    {
      name: 'PDF',
      bytes: PDF,
      filename: 'bill.pdf',
      declared: 'application/pdf',
      ext: '.pdf',
      field: 'address_proof',
    },
  ];

  const stored = [];
  for (const f of accepted) {
    const res = await upload(f.bytes, f.filename, f.declared, f.field);
    const body = await res.json().catch(() => ({}));
    check(
      `${f.name} accepted into ${f.field}`,
      res.status === 201,
      `${res.status} ${JSON.stringify(body)}`,
    );
    if (res.status !== 201) continue;

    // The path the submission recorded — the shape the frontends' URL builders read.
    const row = await db.query(
      `SELECT storage_key, content_type, byte_size, sha256, owner_user_id, provider,
              uploaded_by_kind, to_jsonb(stored_objects)::text AS whole_row
         FROM stored_objects
        WHERE owner_user_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    const reg = row.rows[0];
    check(`${f.name} registered in stored_objects`, Boolean(reg));
    if (!reg) continue;

    uploadedKeys.push(reg.storage_key);
    const filename = reg.storage_key.split('/').pop();
    stored.push({ ...f, key: reg.storage_key, filename });

    check(
      `${f.name} stored under a UUID with the SNIFFED extension`,
      new RegExp(`^kyc/[0-9a-f-]{36}\\${f.ext}$`).test(reg.storage_key),
      reg.storage_key,
    );
    check(
      `${f.name} content_type is the sniffed one`,
      reg.content_type === f.declared,
      reg.content_type,
    );
    check(`${f.name} byte_size matches`, Number(reg.byte_size) === f.bytes.length);
    check(
      `${f.name} sha256 matches the bytes we sent`,
      reg.sha256 === createHash('sha256').update(f.bytes).digest('hex'),
    );
    check(`${f.name} attributed to the calling client`, reg.owner_user_id === userId);
    check(`${f.name} provider recorded as r2`, reg.provider === 'r2', reg.provider);
    check(`${f.name} uploader kind is client`, reg.uploaded_by_kind === 'client');
    // The name it had on the uploader's device is not kept anywhere (0160, D-84).
    check(`${f.name} original filename not kept`, !reg.whole_row.includes(f.filename));

    // ── The object really is in the bucket, byte-identical ──────────────────
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: reg.storage_key }));
    check(`${f.name} present in R2 with the right size`, head.ContentLength === f.bytes.length);
    check(
      `${f.name} Content-Type stored on the object`,
      head.ContentType === f.declared,
      head.ContentType,
    );

    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: reg.storage_key }));
    const raw = Buffer.from(await obj.Body.transformToByteArray());
    check(`${f.name} bytes in R2 are identical`, raw.equals(f.bytes));
  }

  // ── Nothing landed on this host's disk ────────────────────────────────────
  section('nothing on local disk');
  const { existsSync, readdirSync } = await import('node:fs');
  const diskDir = new URL('../uploads/kyc/', import.meta.url).pathname;
  const onDisk = existsSync(diskDir) ? readdirSync(diskDir) : [];
  check(
    'no new files under ./uploads/kyc',
    !stored.some((s) => onDisk.includes(s.filename)),
    `dir holds ${onDisk.length} legacy file(s)`,
  );

  // ── Reading them back through the authenticated route ─────────────────────
  section('serving');
  for (const f of stored) {
    const res = await api(`/uploads/kyc/${f.filename}`);
    const body = Buffer.from(await res.arrayBuffer());
    check(`${f.name} served 200 to its owner`, res.status === 200, String(res.status));
    check(`${f.name} bytes round-trip through the API`, body.equals(f.bytes));
    check(`${f.name} Content-Type set`, res.headers.get('content-type') === f.declared);
    check(`${f.name} nosniff`, res.headers.get('x-content-type-options') === 'nosniff');
    check(
      `${f.name} CSP sandbox`,
      (res.headers.get('content-security-policy') ?? '').includes("default-src 'none'"),
    );
    check(
      `${f.name} no-store (PII must not reach a disk cache)`,
      (res.headers.get('cache-control') ?? '').includes('no-store'),
    );
    check(`${f.name} Accept-Ranges advertised`, res.headers.get('accept-ranges') === 'bytes');
    check(
      `${f.name} Content-Disposition inline`,
      (res.headers.get('content-disposition') ?? '').startsWith('inline'),
    );
  }

  // ── Range reads: what a PDF viewer actually does ──────────────────────────
  section('range reads (the PDF viewer path)');
  const pdf = stored.find((s) => s.name === 'PDF');
  if (pdf) {
    const first = await api(`/uploads/kyc/${pdf.filename}`, { headers: { range: 'bytes=0-99' } });
    const firstBody = Buffer.from(await first.arrayBuffer());
    check('a closed range returns 206', first.status === 206, String(first.status));
    check(
      'Content-Range names the whole size',
      first.headers.get('content-range') === `bytes 0-99/${PDF.length}`,
    );
    check('the first 100 bytes are correct', firstBody.equals(PDF.subarray(0, 100)));

    // The FIRST request a PDF viewer makes: the trailer, as a suffix range.
    const tail = await api(`/uploads/kyc/${pdf.filename}`, { headers: { range: 'bytes=-64' } });
    const tailBody = Buffer.from(await tail.arrayBuffer());
    check('a suffix range returns 206', tail.status === 206, String(tail.status));
    check('the LAST 64 bytes are correct', tailBody.equals(PDF.subarray(PDF.length - 64)));

    const open = await api(`/uploads/kyc/${pdf.filename}`, {
      headers: { range: `bytes=${PDF.length - 10}-` },
    });
    check('an open-ended range returns 206', open.status === 206);
    check(
      'the open-ended range is the tail',
      Buffer.from(await open.arrayBuffer()).equals(PDF.subarray(PDF.length - 10)),
    );
  }

  // ── Authorization ─────────────────────────────────────────────────────────
  section('authorization');
  if (stored[0]) {
    const anon = await fetch(`${API}/uploads/kyc/${stored[0].filename}`, { redirect: 'manual' });
    check('anonymous read refused (401)', anon.status === 401, String(anon.status));

    /*
     * REFUSED, and the exact code differs by principal on purpose.
     *
     * A client gets 403 ("you can only access your own documents") because the
     * question answered is "does your submission reference this", which a
     * non-existent file fails without ever revealing whether it exists. The ADMIN
     * branch answers 404 for the same request, so a scoped reviewer cannot
     * enumerate filenames. Both refuse; asserting a single number here would pin
     * the wrong half of that design.
     */
    const bogus = await api('/uploads/kyc/00000000-0000-4000-8000-000000000000.png');
    check(
      'a document the client does not own is refused',
      bogus.status === 403 || bogus.status === 404,
      String(bogus.status),
    );

    const traversal = await fetch(`${API}/uploads/kyc/..%2F..%2F.env`, {
      headers: { cookie: cookieHeader() },
      redirect: 'manual',
    });
    check('path traversal refused', traversal.status >= 400, String(traversal.status));
  }

  // ── Every REJECTED case ───────────────────────────────────────────────────
  section('rejections');
  const rejected = [
    {
      name: 'HEIC (an iPhone photo)',
      bytes: HEIC,
      filename: 'photo.heic',
      declared: 'image/heic',
      expect: 400,
      // The message has to name the iOS setting; "invalid file" is a dead end
      // for someone holding a photo they just took.
      messageMatches: /iPhone|Most Compatible/i,
    },
    {
      name: 'HTML declared as PNG (stored XSS)',
      bytes: HTML,
      filename: 'id.png',
      declared: 'image/png',
      expect: 400,
    },
    {
      name: 'HTML declared honestly',
      bytes: HTML,
      filename: 'payload.html',
      declared: 'text/html',
      expect: 400,
    },
    {
      name: 'SVG (accepted for logos, NOT for identity documents)',
      bytes: SVG,
      filename: 'id.svg',
      declared: 'image/svg+xml',
      expect: 400,
    },
    {
      name: 'GIF (not in the allow-list)',
      bytes: GIF,
      filename: 'id.gif',
      declared: 'image/gif',
      expect: 400,
    },
    {
      name: 'an empty file',
      bytes: Buffer.alloc(0),
      filename: 'empty.png',
      declared: 'image/png',
      expect: 400,
    },
    {
      name: 'a PNG renamed .pdf but declared image/png',
      bytes: PNG,
      filename: 'id.pdf',
      declared: 'application/pdf',
      expect: 400,
    },
  ];

  for (const r of rejected) {
    const res = await upload(r.bytes, r.filename, r.declared);
    const body = await res.json().catch(() => ({}));
    check(
      `${r.name} → ${r.expect}`,
      res.status === r.expect,
      `${res.status} ${JSON.stringify(body)}`,
    );
    if (r.messageMatches) {
      check(
        `${r.name} message names the fix`,
        r.messageMatches.test(String(body.message ?? '')),
        String(body.message ?? '').slice(0, 120),
      );
    }
  }

  // ── Oversize: aborted mid-flight, nothing stored ──────────────────────────
  section('oversize');
  const before = await db.query(
    `SELECT count(*)::int AS n FROM stored_objects WHERE owner_user_id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  const huge = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024, 1)]);
  const oversize = await upload(huge, 'huge.png', 'image/png');
  const oversizeBody = await oversize.json().catch(() => ({}));
  check('an 11MB upload is refused with 413', oversize.status === 413, String(oversize.status));
  check(
    'the refusal carries PAYLOAD_TOO_LARGE',
    oversizeBody.code === 'PAYLOAD_TOO_LARGE',
    JSON.stringify(oversizeBody),
  );
  check(
    'the message names the limit',
    /10 ?MB/i.test(String(oversizeBody.message ?? '')),
    String(oversizeBody.message ?? ''),
  );

  const after = await db.query(
    `SELECT count(*)::int AS n FROM stored_objects WHERE owner_user_id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  check('nothing was stored for the oversize attempt', after.rows[0].n === before.rows[0].n);

  // ── The audit trail (R-6.6) ───────────────────────────────────────────────
  section('audit trail');
  const audited = stored[stored.length - 1];
  if (audited) {
    const audit = await db.query(
      `SELECT actor_kind, action FROM audit_log
        WHERE subject_type = 'kyc_document' AND subject_id = $1`,
      [audited.filename],
    );
    check(
      'every document read wrote an audit row',
      audit.rows.length > 0,
      `${audit.rows.length} row(s)`,
    );
    check(
      'the reading client is identified',
      audit.rows.some((r) => r.actor_kind === 'client' && r.action === 'kyc.document.view'),
    );
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('cleanup');
  for (const key of uploadedKeys) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
  }
  await db.query(`DELETE FROM stored_objects WHERE storage_key = ANY($1)`, [uploadedKeys]);
  await db.query(
    `UPDATE kyc_submissions SET document = NULL, selfie = NULL, address_proof = NULL WHERE user_id = $1`,
    [userId],
  );
  console.log(`    ✔ removed ${uploadedKeys.length} object(s) and their rows`);

  console.log(`\n${'═'.repeat(64)}`);
  console.log(fail === 0 ? `✔ ALL ${pass} CHECKS PASSED` : `✖ ${fail} FAILED, ${pass} passed`);
  if (fail > 0) console.log(failures.map((f) => `    - ${f}`).join('\n'));
  console.log('');

  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`\n✖ ABORTED: ${error?.message ?? error}\n`);
  for (const key of uploadedKeys) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
  }
  await db.end().catch(() => {});
  process.exit(1);
});
