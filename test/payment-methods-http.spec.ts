import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';
import { CSRF_HEADER } from '../src/common/security/csrf.guard';
import { PAYMENT_LOGO_BUCKET } from '../src/common/uploads/stored-files.service';

/**
 * The payment-method admin surface, over real HTTP.
 *
 * The unit specs cover the rules; this covers the WIRE — multipart parsing, the
 * guards, and the shape the admin console actually receives. Three things here
 * cannot be tested any other way:
 *
 *   1. The logo upload is `multipart/form-data`. Every unit test in the suite
 *      hands `StoredFilesService` a Buffer directly, so nothing exercised
 *      Multer, the interceptor's size limit, or the `file` field name — and the
 *      first bug this endpoint shipped was exactly there: the admin client sent
 *      a JSON content type, no boundary was generated, and the server answered
 *      "No file was uploaded" for a request that carried one.
 *   2. DELETE is gone. A route that no longer exists must 404, not 405 or 200.
 *   3. The logo is served PUBLICLY, and its CSP is what makes accepting SVG
 *      safe. That header is only observable on a real response.
 */

const MASTER = { email: 'pm-master@oxshare.com', password: 'admin-password-123' };

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
);

let ctx: HttpTestContext;
let master: Session;

/**
 * Multipart, sent by hand.
 *
 * `Session` has no `attach`, so the cookie and CSRF headers are applied here
 * rather than through its helpers — and `Content-Type` is left to supertest,
 * which generates the boundary. Setting it explicitly is the bug this endpoint
 * already had once.
 */
function uploadLogo(bytes: Buffer, filename: string, contentType: string) {
  return request(ctx.server)
    .post('/v1/admin/payment-methods/logo')
    .set('Cookie', master.cookieHeader())
    .set('Origin', 'http://localhost:3002')
    .set(CSRF_HEADER, master.csrfToken ?? '')
    .attach('file', bytes, { filename, contentType });
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [role] = await db
    .insert(roles)
    .values({ name: 'PM Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'PM Master',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  master = await actingAs(ctx, 'admin', MASTER);
}, 180_000);

afterAll(async () => {
  await rm(join(process.cwd(), 'uploads', PAYMENT_LOGO_BUCKET.dir), {
    recursive: true,
    force: true,
  });
  await stopHttpTestApp(ctx);
});

describe('creating a payment method', () => {
  it('takes key, name and currency, and offers it to clients', async () => {
    const created = await master.post('/v1/admin/payment-methods', {
      key: 'e2e_bank',
      name: 'E2E Bank',
      currency: 'USD',
      enabled: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.key).toBe('e2e_bank');

    const listed = await master.get('/v1/admin/payment-methods');
    const row = (listed.body as { key: string }[]).find((m) => m.key === 'e2e_bank');
    expect(row).toBeDefined();
  });

  /**
   * ⚠️ `kind` is gone, and sending it is REFUSED rather than ignored.
   *
   * `forbidNonWhitelisted` does this, and it matters more here than the tidiness
   * of it: a caller still sending `kind` believes it is choosing the deposit
   * flow. Accepting and dropping the field would tell them they had.
   */
  it('refuses a body still carrying the dropped `kind` field', async () => {
    const res = await master.post('/v1/admin/payment-methods', {
      key: 'e2e_with_kind',
      name: 'Old shape',
      kind: 'manual',
      currency: 'USD',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a duplicate key rather than silently overwriting', async () => {
    const again = await master.post('/v1/admin/payment-methods', {
      key: 'e2e_bank',
      name: 'Something else',
      currency: 'USD',
    });
    expect(again.status).toBe(409);
  });

  /*
   * Enabling and disabling is the ONLY lever now, and the row action sends just
   * this one field. A PATCH carrying `enabled` alone must not blank anything
   * else — the action is reached from a table row that does not hold the whole
   * method.
   */
  it('toggles enabled without disturbing the rest of the method', async () => {
    const off = await master.patch('/v1/admin/payment-methods/e2e_bank', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(off.body.name).toBe('E2E Bank');

    const on = await master.patch('/v1/admin/payment-methods/e2e_bank', { enabled: true });
    expect(on.body.enabled).toBe(true);
  });

  /*
   * DELETE exists again, narrowly (0161): a method NO transaction references.
   * e2e_bank has none, so it goes; an unknown key is a 404.
   */
  it('deletes a method nobody used', async () => {
    expect((await master.del('/v1/admin/payment-methods/e2e_bank')).status).toBe(200);
    expect((await master.del('/v1/admin/payment-methods/e2e_bank')).status).toBe(404);
  });
});

describe('uploading a logo', () => {
  it('accepts a PNG over multipart and returns a URL on this API', async () => {
    const res = await uploadLogo(PNG, 'brand.png', 'image/png');

    expect(res.status).toBe(200);
    // A path we serve, NOT a third-party host — that is the whole point of
    // replacing the URL field with an upload.
    expect(res.body.logoUrl).toMatch(/^\/v1\/uploads\/payment-logos\/[0-9a-f-]{36}\.png$/);
  });

  /**
   * ⚠️ THE ROUND TRIP, and it was BROKEN.
   *
   * Upload answers with `/v1/uploads/payment-logos/…` — a path on this API,
   * which is the whole point of replacing the old URL field with an upload. The
   * create/update DTOs validated `logoUrl` with `@IsUrl({ protocols: ['https'] })`,
   * which refuses exactly that shape. So the admin console's own upload button
   * produced a value its own Save button rejected with a 400, and the only logo
   * an operator could actually store was one pasted from a third-party host —
   * the thing the upload existed to stop.
   *
   * Nothing caught it because no test ever put the uploaded URL back on a
   * method. This one does, end to end, which is the only way this bug is
   * visible.
   */
  it('stores an uploaded logo back on a method', async () => {
    const uploaded = await uploadLogo(PNG, 'brand.png', 'image/png');
    const logoUrl = uploaded.body.logoUrl as string;

    const created = await master.post('/v1/admin/payment-methods', {
      key: 'e2e_logo',
      name: 'E2E Logo',
      currency: 'USD',
      logoUrl,
    });

    expect(created.status).toBe(201);
    expect(created.body.logoUrl).toBe(logoUrl);
  });

  /**
   * The other half: an operator-set value still reaches every client's browser
   * as an `<img src>`, so the pattern is two allowed shapes and nothing else.
   * A `javascript:` URL is where that goes wrong.
   */
  it('refuses a logo URL that is neither an upload path nor https', async () => {
    const res = await master.post('/v1/admin/payment-methods', {
      key: 'e2e_bad_logo',
      name: 'Bad logo',
      currency: 'USD',
      logoUrl: 'javascript:alert(document.cookie)',
    });

    expect(res.status).toBe(400);
  });

  it('accepts an SVG', async () => {
    const res = await uploadLogo(SVG, 'brand.svg', 'image/svg+xml');

    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toMatch(/\.svg$/);
  });

  /*
   * ⚠️ THE stored-XSS case, over the wire. The multipart `Content-Type` is a
   * CLAIM by the uploader; the bytes decide. An HTML document declared as SVG
   * must be refused, because one served from our own origin executes.
   */
  it('refuses an HTML document declared as SVG', async () => {
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    const res = await uploadLogo(html, 'evil.svg', 'image/svg+xml');

    expect(res.status).toBe(400);
  });

  it('refuses a request carrying no file', async () => {
    const res = await request(ctx.server)
      .post('/v1/admin/payment-methods/logo')
      .set('Cookie', master.cookieHeader())
      .set('Origin', 'http://localhost:3002')
      .set(CSRF_HEADER, master.csrfToken ?? '');

    expect(res.status).toBe(400);
  });

  /**
   * The served logo, and the headers that make SVG safe to accept.
   *
   * `default-src 'none'` (which `script-src` falls back to) and `sandbox` are
   * what stop script executing if somebody navigates straight to a stored SVG.
   * If either assertion ever fails, SVG must come out of `PAYMENT_LOGO_BUCKET` —
   * they are a pair.
   */
  it('serves a logo publicly, with a CSP that cannot execute script', async () => {
    const uploaded = await uploadLogo(SVG, 'served.svg', 'image/svg+xml');
    const path = uploaded.body.logoUrl as string;

    // NO cookie: this route is deliberately unauthenticated, because a brand
    // mark on the deposit screen must render for anyone.
    const res = await request(ctx.server).get(path);

    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // No `script-src` of its own, so it falls back to `default-src 'none'`.
    // Asserted because ADDING one is how this policy would quietly gain the
    // ability to execute.
    expect(res.headers['content-security-policy']).not.toContain('script-src');
  });

  /**
   * ⚠️ `Content-Type`, and the reason an uploaded SVG rendered as nothing.
   *
   * The route sent no `Content-Type` at all alongside `nosniff`. A PNG survives
   * that because a browser decodes it from its magic bytes; SVG is XML with no
   * signature, so a browser forbidden to sniff and told nothing will not treat
   * it as an image. The logo was simply absent, which reads as a bad file rather
   * than a missing header.
   *
   * Both types are asserted, because the PNG is the case that hid the bug.
   */
  it('declares the content type it stored, so an SVG renders at all', async () => {
    const svg = await uploadLogo(SVG, 'typed.svg', 'image/svg+xml');
    const svgRes = await request(ctx.server).get(svg.body.logoUrl as string);
    expect(svgRes.headers['content-type']).toContain('image/svg+xml');

    const png = await uploadLogo(PNG, 'typed.png', 'image/png');
    const pngRes = await request(ctx.server).get(png.body.logoUrl as string);
    expect(pngRes.headers['content-type']).toContain('image/png');
  });

  /**
   * The SVG's OWN stylesheet must be allowed to apply.
   *
   * Illustrator and Figma export a `<style>` block and put every fill in it.
   * Under `default-src 'none'` alone, `style-src` falls back to `'none'` and the
   * browser drops that block — the mark renders as uncoloured shapes, which is
   * how the first uploaded logo looked.
   *
   * `'unsafe-inline'` here is scoped to STYLE. It cannot execute, and CSS
   * `url()` still resolves against `img-src`/`font-src`/`connect-src`, all of
   * which fall back to `'none'`.
   */
  it('lets a stored SVG apply its own inline stylesheet', async () => {
    const uploaded = await uploadLogo(SVG, 'styled.svg', 'image/svg+xml');
    const res = await request(ctx.server).get(uploaded.body.logoUrl as string);

    expect(res.headers['content-security-policy']).toContain("style-src 'unsafe-inline'");
  });

  it('404s for a logo that does not exist, without leaking the path', async () => {
    const res = await request(ctx.server).get(
      '/v1/uploads/payment-logos/00000000-0000-4000-8000-000000000000.png',
    );
    expect(res.status).toBe(404);
  });
});
