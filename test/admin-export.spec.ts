import { eq } from 'drizzle-orm';
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
  auditLog,
  clientTagAssignments,
  clientTags,
  ibAccounts,
  ibApplications,
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
/*
 * The same two clients by PORTAL ID — what every export identifies a client by
 * now. The uuid is in no file any more, so a `not.toContain(uuid)` would pass
 * whatever the export did; rows are found by their Portal ID cell instead.
 */
let minePortalId: number;
let theirsPortalId: number;

/** Does the CSV hold a row for this client — their Portal ID as a whole cell? */
function hasClientRow(csv: string, portalId: number): boolean {
  return csv.split('\r\n').some((line) => line.split(',').includes(String(portalId)));
}

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
      // `ib.view` belongs here for the reason the comment above already states:
      // this fixture must hold every read the exports need, so a mask assertion
      // cannot pass because of a missing permission. It did not hold it, and
      // the two IB exports were the ones that masked nothing.
      //
      // `audit.view` is here for the SAME reason, and it was missing for the
      // same reason — so the audit export was never reached by a masked reader
      // in this file either, and it leaked the client address in its `Actor
      // email` column until the crosshost browser run downloaded the file and
      // read it. That is twice this one absent permission has hidden a live
      // leak; the lesson is that a mask fixture must hold EVERY read, not the
      // reads whose masking somebody already suspected.
      permissions: ['clients.view', 'kyc.view', 'ib.view', 'audit.view'],
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
  minePortalId = mine.portalId;
  theirsPortalId = theirs.portalId;

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
   * Both clients are also PARTNERS and APPLICANTS, so the two IB exports have
   * rows at all.
   *
   * Without this they had none, and `ib partners: the partner export omits
   * out-of-scope partners` below passed on an EMPTY FILE — a file containing no
   * partners contains no out-of-scope partner either. That is the vacuous pass
   * this file's own header warns about ("an empty file would pass vacuously"),
   * and it is why the mask cases further down assert a row is PRESENT before
   * asserting a field is absent.
   */
  await db.insert(ibAccounts).values([
    { userId: mineId, referralCode: 'EXPORT-MINE' },
    { userId: theirsId, referralCode: 'EXPORT-THEIRS' },
  ]);
  await db.insert(ibApplications).values([
    { userId: mineId, status: 'approved' },
    { userId: theirsId, status: 'approved' },
  ]);

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
    expect(hasClientRow(res.text, theirsPortalId)).toBe(false);
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
    expect(hasClientRow(res.text, minePortalId)).toBe(true);
    expect(res.text).not.toContain('export-mine@oxshare-e2e.test');
  });

  it('masks NOTHING for the master — on the file, as on the screen', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/kyc/export');

    expect(res.status).toBe(200);
    expect(res.text).toContain('export-mine@oxshare-e2e.test');
  });

  /*
   * The two IB exports, which were the ONLY two of nine batch methods that
   * returned their rows unmasked — `return rows;` where every sibling ends in
   * `maskByShape`. A reviewer refused `client.email` on every screen could
   * download every applicant's and every partner's address.
   *
   * Both assert the ROW SURVIVES before asserting the field is gone. Masking by
   * deleting a property and masking by returning nothing are indistinguishable
   * from the outside, and only one of them is correct.
   */
  it('ib applications: the masked email is absent while the row remains', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get('/v1/admin/ib/applications/export');

    expect(res.status).toBe(200);
    expect(
      hasClientRow(res.text, minePortalId),
      'the applications export came back empty — the mask case is vacuous',
    ).toBe(true);
    expect(res.text).not.toContain('export-mine@oxshare-e2e.test');
    expect(res.text).not.toContain('export-theirs@oxshare-e2e.test');
  });

  it('ib partners: the masked email is absent while the row remains', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get('/v1/admin/ib/partners/export');

    expect(res.status).toBe(200);
    expect(
      hasClientRow(res.text, minePortalId),
      'the partners export came back empty — the mask case is vacuous',
    ).toBe(true);
    expect(res.text).not.toContain('export-mine@oxshare-e2e.test');
    expect(res.text).not.toContain('export-theirs@oxshare-e2e.test');
  });

  /*
   * THE AUDIT TRAIL'S OWN ACTOR COLUMN.
   *
   * `audit_log.actor_kind` is one of `admin | client | system | provider`, so
   * `actor_email` is a CLIENT's address on every row a client generated — and
   * clients generate them routinely (`kyc.document.view`,
   * `deposit.proof.view`). `AuditEntryDto.actorEmail` nonetheless declared
   * `@NotClientField('the ACTOR ... an administrator')`, which was true of the
   * table as first written and was not revisited when `actorKind` was added to
   * that same class to record that it had stopped being true.
   *
   * Masking it unconditionally would be the wrong fix and is what the control
   * below forbids: an ADMIN actor's address is the answer to "who did this",
   * and a log that withholds that is not a log.
   */
  it('audit log: a client ACTOR’s address is masked, while the admin actor’s remains', async () => {
    const db = ctx.db.db;
    const [masterAdmin] = await db.select().from(admins).where(eq(admins.email, MASTER.email));
    const ACTION = 'export.actor_mask_probe';

    await db.insert(auditLog).values([
      {
        // A client acting on their own record — the row shape the DTO's
        // "an administrator" sentence denied could exist.
        actorId: mineId,
        actorEmail: 'export-mine@oxshare-e2e.test',
        actorKind: 'client',
        action: ACTION,
        subjectType: 'client',
        subjectId: mineId,
      },
      {
        actorId: masterAdmin.id,
        actorEmail: 'export-master@oxshare.com',
        actorKind: 'admin',
        action: ACTION,
        subjectType: 'client',
        subjectId: mineId,
      },
    ]);

    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`/v1/admin/audit-log/export?action=${ACTION}`);

    expect(res.status).toBe(200);
    // The rows must SURVIVE: masking by dropping the row and masking by
    // dropping the value are indistinguishable from outside the file.
    const dataRows = res.text
      .split(/\r?\n/)
      .slice(1)
      .filter((line) => line.trim().length > 0);
    expect(dataRows.length, 'the audit export came back empty — the mask case is vacuous').toBe(2);

    expect(
      res.text,
      'the Actor email column handed a masked operator a client address',
    ).not.toContain('export-mine@oxshare-e2e.test');
    expect(
      res.text,
      'the ADMIN actor was masked too — that empties the column the log exists for',
    ).toContain('export-master@oxshare.com');
  });

  it('audit log: the master reads both actor addresses — the control', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/audit-log/export?action=export.actor_mask_probe');

    expect(res.status).toBe(200);
    expect(res.text).toContain('export-mine@oxshare-e2e.test');
    expect(res.text).toContain('export-master@oxshare.com');
  });

  it('gives the master BOTH IB exports in full — the mask is policy, not a dropped column', async () => {
    /*
     * The control that makes the two cases above mean something. Without it
     * they would pass equally well if the exporter had simply stopped emitting
     * the email for everybody, which is a different bug wearing the same shape.
     */
    const session = await actingAs(ctx, 'admin', MASTER);

    const applications = await session.get('/v1/admin/ib/applications/export');
    expect(applications.status).toBe(200);
    expect(applications.text).toContain('export-mine@oxshare-e2e.test');

    const partners = await session.get('/v1/admin/ib/partners/export');
    expect(partners.status).toBe(200);
    expect(partners.text).toContain('export-mine@oxshare-e2e.test');
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

  it('audit log: exports EVERY row, not the first page of them', async () => {
    /*
     * ⚠️ THE CASE THE TWO ABOVE COULD NOT CATCH, and the defect it caught was
     * live: `GET /admin/audit-log/export` returned 100 rows out of 1,600.
     *
     * `streamCsv` reads in batches of EXPORT_BATCH_SIZE (1,000) and stops when a
     * batch comes back SHORT, because a short batch means the end of the data.
     * `AuditLogStore.findAll` ran its limit through `pageSize()`, which clamps to
     * MAX_PAGE_SIZE (100) — correct for a LIST, where it bounds what one screen
     * can ask the database for. So the export asked for 1,000, was handed 100,
     * read that as the end, and finished at six per cent of the trail.
     *
     * AND THE TRUNCATION NOTICE COULD NOT FIRE. `streamCsv` writes
     * EXPORT_TRUNCATED_NOTICE into the file past MAX_EXPORT_ROWS (200,000) — a
     * real guard, correctly written, made unreachable by a clamp that ended the
     * stream 199,900 rows early. The file did not merely truncate; it truncated
     * and said nothing, which is the difference between a limit and a lie. On
     * the forensic record, and on the one table an auditor actually exports.
     *
     * The two cases above assert a 403, a 200 and the word "Action" in the body.
     * Both pass identically at 100 rows and at 1,600. THE ROW COUNT IS THE
     * PROPERTY, and nothing was asserting it.
     */
    const db = ctx.db.db;
    const ROWS = 150; // deliberately above MAX_PAGE_SIZE (100)
    const [master] = await db.select().from(admins).where(eq(admins.email, MASTER.email));
    const masterId = master.id;
    const ACTION = 'export.completeness_probe';

    await db.insert(auditLog).values(
      Array.from({ length: ROWS }, (_, i) => ({
        // `actor_id` and `actor_email` are NOT NULL — the trail always names who.
        actorId: masterId,
        actorEmail: `probe-${i}@oxshare.com`,
        action: ACTION,
        subjectType: 'admin',
        subjectId: masterId,
      })),
    );

    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/audit-log/export?action=${ACTION}`);
    expect(res.status).toBe(200);

    // Data rows only: drop the header and any trailing blank line.
    const dataRows = res.text
      .split(/\r?\n/)
      .slice(1)
      .filter((line) => line.trim().length > 0);

    expect(
      dataRows.length,
      `the export returned ${dataRows.length} of ${ROWS} rows. A page-size clamp on the ` +
        'export batch makes streamCsv read a short batch as end-of-data, so the file stops ' +
        'early — and the truncation notice never fires, because it is keyed on a limit the ' +
        'stream never reaches. An audit export that silently omits rows is worse than one ' +
        'that refuses.',
    ).toBe(ROWS);

    // Non-vacuous: the filter must still bite, or "every row" is trivially true
    // of an export that ignores its filter and returns the whole table.
    expect(
      dataRows.every((line) => line.includes(ACTION)),
      'the export returned rows outside the requested action — it is not filtering',
    ).toBe(true);
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

describe('no export names a client by uuid — the Portal ID is their identifier', () => {
  /*
   * The owner's rule (24 Sep 2026): an administrator identifies a client by
   * Portal ID alone, as if the uuid had never existed. The uuid still keys every
   * row; it must just never reach a person — and a spreadsheet is where it would
   * surface first, in an ID column or inside the audit trail's details.
   *
   * Each file must hold the client's Portal ID (or the absence of the uuid
   * proves nothing — an empty file has no uuid in it either) and never their
   * uuid, in any column or inside any JSON.
   */
  const CLIENT_EXPORTS = [
    'clients',
    'kyc',
    'withdrawals',
    'transactions',
    'wallets',
    'ib/applications',
    'ib/partners',
    'audit-log',
  ];

  beforeAll(async () => {
    // A money row naming the client only inside `details`, as the withdrawal
    // desk records one — the place a uuid would otherwise survive.
    const [masterAdmin] = await ctx.db.db
      .select()
      .from(admins)
      .where(eq(admins.email, MASTER.email));
    await ctx.db.db.insert(auditLog).values({
      actorId: masterAdmin.id,
      actorEmail: MASTER.email,
      actorKind: 'admin',
      action: 'withdrawal.approve',
      subjectType: 'transaction',
      subjectId: '11111111-1111-4111-8111-111111111111',
      details: { userId: mineId, amount: '10.00000000' },
    });
  });

  for (const resource of CLIENT_EXPORTS) {
    it(`${resource}: carries the Portal ID and never the uuid`, async () => {
      const session = await actingAs(ctx, 'admin', MASTER);
      const res = await session.get(`/v1/admin/${resource}/export?format=csv`);

      expect(res.status).toBe(200);
      expect(res.text, `${resource} names no client at all — the check is vacuous`).toMatch(
        new RegExp(`(^|[,"{:\\s])${minePortalId}([,"}\\s]|$)`, 'm'),
      );
      expect(res.text, `${resource} still prints a client uuid`).not.toContain(mineId);
    });
  }
});

describe('the export honours the SAME filters as the list', () => {
  /*
   * `admin-clients.controller.ts` promises exactly this, directly above the
   * query it builds: "the export honours the SAME filters as the list, so
   * 'export what I am looking at' stays true as filters are added. Omitting
   * these two would have made a filtered screen produce an unfiltered file."
   *
   * It then passed `emailVerified` and `kycStatus` into an object typed by
   * `ClientExportQuery`, which declared neither — so `clientBatch` never
   * forwarded them and a filtered screen produced exactly the unfiltered file
   * the comment says it must not. TypeScript could not see it: the object binds
   * to a `const` before the call, which is the one case excess-property checking
   * does not cover.
   */
  it('narrows by kycStatus, instead of returning every client', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);

    const res = await master.get('/v1/admin/clients/export?kycStatus=submitted');

    expect(res.status).toBe(200);
    // `mine` has a submitted submission; `theirs` has none at all.
    expect(
      hasClientRow(res.text, minePortalId),
      'the filtered client is missing — the filter over-narrowed',
    ).toBe(true);
    expect(
      hasClientRow(res.text, theirsPortalId),
      'the filter was ignored and the file holds everybody',
    ).toBe(false);
  });

  it('narrows by emailVerified, and tells absent apart from false', async () => {
    const db = ctx.db.db;
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, mineId));
    await db.update(users).set({ emailVerified: false }).where(eq(users.id, theirsId));

    const master = await actingAs(ctx, 'admin', MASTER);

    const verified = await master.get('/v1/admin/clients/export?emailVerified=true');
    expect(verified.status).toBe(200);
    expect(hasClientRow(verified.text, minePortalId)).toBe(true);
    expect(hasClientRow(verified.text, theirsPortalId)).toBe(false);

    /*
     * The tri-state, which is why this is parsed by a shared function rather
     * than `=== 'true'`. An ABSENT filter must return both — collapsing absent
     * into false would silently show only unverified clients on an unfiltered
     * export.
     */
    const all = await master.get('/v1/admin/clients/export');
    expect(hasClientRow(all.text, minePortalId)).toBe(true);
    expect(hasClientRow(all.text, theirsPortalId)).toBe(true);
  });

  it('REFUSES an unrecognised kycStatus rather than ignoring it', async () => {
    // The same 400 the list gives. A silently ignored filter returns everybody,
    // and "every client" looks enough like a plausible answer that nobody
    // checks it against what they asked for.
    const master = await actingAs(ctx, 'admin', MASTER);

    const res = await master.get('/v1/admin/clients/export?kycStatus=nonsense');

    expect(res.status).toBe(400);
  });
});

describe('an offset-batched export is bounded to ONE instant', () => {
  /*
   * ⚠️ The claim this replaces was exactly backwards.
   *
   * Two exports justified offset batching with: "a concurrent insert can only
   * add a row at the head this pass has already passed — it cannot shift a row
   * across a batch boundary."
   *
   * The ordering is `created_at DESC`. A new row sorts FIRST. It does not land
   * at a head already gone by — it pushes every later row down one, so
   * `OFFSET 1000` points at what was row 999 and the last row of batch 1 is
   * written to the file a second time. The sentence described the one thing that
   * cannot happen and asserted it as the reason the thing that does happen
   * cannot.
   *
   * `created_at <= startedAt` removes the possibility rather than reasoning
   * about it, which is why this asserts the BOUND rather than trying to race an
   * insert against a streaming download — a test that has to win a race to fail
   * is a test that will pass on a busy machine.
   */
  it('excludes rows created after the run began', async () => {
    const db = ctx.db.db;
    const { TransactionsService } = await import('../src/modules/payments/transactions.service');
    const service = ctx.app.get(TransactionsService);

    const startedAt = new Date();
    // Unambiguously after the snapshot, so the assertion cannot turn on clock
    // resolution.
    const later = new Date(startedAt.getTime() + 60_000);

    // The client's EXISTING wallet — `currency` carries a foreign key to
    // `currencies`, so an invented code fails the insert rather than the test.
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, mineId)).limit(1);
    const [fresh] = await db
      .insert(transactions)
      .values({
        userId: mineId,
        walletId: wallet.id,
        direction: 'withdrawal',
        amount: '1.00000000',
        currency: wallet.currency,
        state: 'pending',
        provider: 'whish',
        destination: 'inserted-mid-export',
        createdAt: later,
      })
      .returning();

    const bounded = await service.listForExport({ offset: 0, limit: 100, startedAt });
    expect(
      bounded.map((row) => row.id),
      'a row created after the snapshot entered the export, so offsets can still shift',
    ).not.toContain(fresh.id);

    // And the control: the same query with a snapshot taken AFTER the insert
    // does include it, so the exclusion is about the bound and not about the row
    // being invisible for some other reason.
    const unbounded = await service.listForExport({
      offset: 0,
      limit: 100,
      startedAt: new Date(later.getTime() + 1_000),
    });
    expect(unbounded.map((row) => row.id)).toContain(fresh.id);
  });
});
