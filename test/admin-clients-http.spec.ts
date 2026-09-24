import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  admins,
  ibAccounts,
  ibPrograms,
  kycSubmissions,
  roles,
  users,
} from '../src/database/schema';
import { eq } from 'drizzle-orm';

/**
 * The client directory's query surface — ADM-01.
 *
 * `?type=` and `?status=` reach POSTGRES ENUM columns, and `UsersStore.findPage`
 * casts them straight in (`eq(users.type, filter.type as 'individual')`). The
 * controller guards that with `enumQuery()`, the same helper the ledger view
 * uses for `entryType` — these are individual `@Query()` strings rather than a
 * DTO class, so the global ValidationPipe validates nothing here.
 *
 * WHAT THIS FILE PINS IS THE MESSAGE, NOT THE STATUS CODE, and that distinction
 * is the whole point. Two different layers answer 400 for a bad enum:
 *
 *   - `enumQuery` — 400 VALIDATION_FAILED, naming the field and listing the
 *     values it accepts;
 *   - `AllExceptionsFilter`, if the value gets through — Postgres raises 22P02
 *     and it is mapped to 400 INVALID_IDENTIFIER, "A value in the request is not
 *     a valid identifier", which says nothing about which value or why.
 *
 * A test asserting only `status === 400` passes either way. This one was written
 * that way first, and disabling `enumQuery` did not turn it red — the fallback
 * quietly covered for it. Asserting the helpful message is what makes the guard
 * real: the fallback is a safety net, not the contract, and an operator filtering
 * a client list deserves to be told which filter they got wrong.
 */

const ADMIN = { email: 'clients-http@oxshare.com', password: 'admin-password-123' };
const CLIENTS = '/v1/admin/clients';

let ctx: HttpTestContext;
/** A seeded client's uuid — what rows are keyed on, and no longer searchable. */
let approvedId: string;
/** The same client's Portal ID, which is what the search box takes (0133). */
let approvedPortalId: number;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Clients HTTP Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();

  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Clients HTTP Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  /*
   * Three clients spanning the states the verification columns exist to tell
   * apart. Without these the suite had NO client rows at all, so any assertion
   * about the KYC join passed vacuously — an inner join would have looked
   * exactly as healthy as a left one.
   */
  const passwordHash = await passwords.hash('client-password-123');

  const [noKyc, submitted, approved] = await ctx.db.db
    .insert(users)
    .values([
      {
        // Never began verification, and has not confirmed their email. This is
        // the row an inner join silently drops.
        email: 'never-started@oxshare.com',
        passwordHash,
        firstName: 'Never',
        lastName: 'Started',
        emailVerified: false,
      },
      {
        email: 'awaiting-review@oxshare.com',
        passwordHash,
        firstName: 'Awaiting',
        lastName: 'Review',
        emailVerified: true,
      },
      {
        email: 'fully-verified@oxshare.com',
        passwordHash,
        firstName: 'Fully',
        lastName: 'Verified',
        emailVerified: true,
        verificationLevel: 1,
      },
    ])
    .returning();

  // Deliberately NO row for `noKyc` — its status has to come from the coalesce
  // rather than from a stored 'not_started'.
  await ctx.db.db.insert(kycSubmissions).values([
    { userId: submitted.id, status: 'submitted', submittedAt: new Date() },
    { userId: approved.id, status: 'approved', submittedAt: new Date(), reviewedAt: new Date() },
  ]);

  void noKyc;
  approvedId = approved.id;
  approvedPortalId = approved.portalId;
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('filters are validated, not cast into the query', () => {
  it('names the field and the allowed values for an unknown ?status=', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?status=definitely-not-a-status`);
    const body = res.body as { code?: string; fields?: Record<string, string> };

    expect(res.status).toBe(400);
    // Not the INVALID_IDENTIFIER fallback — that is the net, not the contract.
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields?.['status']).toMatch(/active/);
    expect(body.fields?.['status']).toMatch(/suspended/);
  });

  it('names the field and the allowed values for an unknown ?type=', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?type=definitely-not-a-type`);
    const body = res.body as { code?: string; fields?: Record<string, string> };

    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields?.['type']).toMatch(/individual/);
  });

  it('still rejects an out-of-range ?level= — the one that was already guarded', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(`${CLIENTS}?level=7`).expect(400);
    await session.get(`${CLIENTS}?level=abc`).expect(400);
  });
});

describe('valid filters keep working', () => {
  it('accepts each real status', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    for (const status of ['active', 'pending', 'suspended']) {
      await session.get(`${CLIENTS}?status=${status}`).expect(200);
    }
  });

  it('accepts each real type', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    for (const type of ['individual', 'referral', 'partner']) {
      await session.get(`${CLIENTS}?type=${type}`).expect(200);
    }
  });

  it('accepts an empty filter, which is how the screen first loads', async () => {
    // An absent filter must not be confused with an invalid one.
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(CLIENTS).expect(200);
    await session.get(`${CLIENTS}?status=&type=&level=`).expect(200);
  });

  it('bounds the page size rather than trusting the querystring', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?limit=100000`).expect(200);
    const body = res.body as { limit: number };
    expect(body.limit).toBeLessThanOrEqual(100);
  });
});

/**
 * `?q=` answers a PORTAL ID as well as a name or email (0133).
 *
 * The admin UI shows the Portal ID wherever a client appears and no longer shows
 * the uuid, so the number is what an operator has to paste. Digits are read as
 * a Portal ID and matched EXACTLY — "1000245" is that client, not every email
 * containing those digits — and the uuid stopped being searchable when it
 * stopped being shown: nobody has one to paste.
 */
describe('searching by Portal ID', () => {
  it('returns exactly that client for their Portal ID', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?q=${approvedPortalId}&withTotal=true`).expect(200);
    const body = res.body as { items: { id: string; portalId: number }[]; total: number };
    expect(body.items.map((c) => c.id)).toEqual([approvedId]);
    expect(body.items[0].portalId).toBe(approvedPortalId);
    // The count carries the same predicate, so it describes the same set.
    expect(body.total).toBe(1);
  });

  it('forgives a leading # and surrounding spaces, as a pasted number carries', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const q = encodeURIComponent(`  #${approvedPortalId} `);
    const res = await session.get(`${CLIENTS}?q=${q}`).expect(200);
    const body = res.body as { items: { id: string }[] };
    expect(body.items.map((c) => c.id)).toEqual([approvedId]);
  });

  it('matches the whole number only — a prefix is not a Portal ID', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const prefix = String(approvedPortalId).slice(0, 4);
    const res = await session.get(`${CLIENTS}?q=${prefix}`).expect(200);
    const body = res.body as { items: { id: string }[] };
    expect(body.items.map((c) => c.id)).not.toContain(approvedId);
  });

  it('answers an empty page — not an error — for a number nobody holds', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?q=999999999`).expect(200);
    expect((res.body as { items: unknown[] }).items).toEqual([]);
  });

  it('does not turn a number beyond the column into a database error', async () => {
    // int4 tops out at 2,147,483,647; comparing a larger literal to the column
    // would make Postgres raise. It falls through to the text search instead.
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?q=99999999999999`).expect(200);
    expect((res.body as { items: unknown[] }).items).toEqual([]);
  });

  it('no longer answers a pasted uuid — it is shown nowhere', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?q=${approvedId}`).expect(200);
    expect((res.body as { items: unknown[] }).items).toEqual([]);
  });

  it('still searches name and email as before', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?q=fully-verified`).expect(200);
    const body = res.body as { items: { id: string }[] };
    expect(body.items.map((c) => c.id)).toEqual([approvedId]);
  });

  it('puts the Portal ID in the CSV export, never the uuid', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}/export?q=${approvedPortalId}`).expect(200);
    const [header, row] = res.text.replace(/^\uFEFF/, '').split('\r\n');
    expect(header.split(',')[0]).toBe('Portal ID');
    expect(row.split(',')[0]).toBe(String(approvedPortalId));
    expect(res.text).not.toContain(approvedId);
  });
});

/**
 * A client is ADDRESSED by Portal ID too — `ClientRefPipe`.
 *
 * The console's URLs carry the Portal ID (`/clients/1000245`, `/kyc/1000245`)
 * and pass it straight to the API, so every route that names a client takes
 * one and resolves it to the uuid the record is keyed on. These pin the three
 * answers that matter: the right client, the same 404 an unknown client gets —
 * never a distinguishable one — and a 400 for something that is neither.
 */
describe('a client is addressed by Portal ID', () => {
  it('serves the profile at /clients/<Portal ID>', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}/${approvedPortalId}`).expect(200);
    const body = res.body as { id: string; portalId: number };
    expect(body.portalId).toBe(approvedPortalId);
    expect(body.id).toBe(approvedId);
  });

  it('still serves it at the internal key, for links minted before', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}/${approvedId}`).expect(200);
    expect((res.body as { portalId: number }).portalId).toBe(approvedPortalId);
  });

  it('answers an unknown Portal ID exactly as it answers an unknown client', async () => {
    // A distinguishable "no such Portal ID" would be an existence probe of its
    // own; the pipe resolves to the nil uuid so the route answers as usual.
    const session = await actingAs(ctx, 'admin', ADMIN);
    const byNumber = await session.get(`${CLIENTS}/999999999`);
    const byKey = await session.get(`${CLIENTS}/00000000-0000-4000-8000-000000000000`);
    expect(byNumber.status).toBe(404);
    expect(byKey.status).toBe(404);
    expect((byNumber.body as { message: unknown }).message).toEqual(
      (byKey.body as { message: unknown }).message,
    );
  });

  it('refuses a value that is neither a Portal ID nor a client key', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}/abc`).expect(400);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('writes through the Portal ID too — a suspend by number suspends that client', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session
      .patch(`${CLIENTS}/${approvedPortalId}/status`, { status: 'suspended' })
      .expect(200);
    const [row] = await ctx.db.db.select().from(users).where(eq(users.id, approvedId));
    expect(row.status).toBe('suspended');
    await session.patch(`${CLIENTS}/${approvedPortalId}/status`, { status: 'active' }).expect(200);
  });

  it('serves the KYC review at /kyc/<Portal ID>', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`/v1/admin/kyc/${approvedPortalId}`).expect(200);
    expect((res.body as { userId: string }).userId).toBe(approvedId);
  });

  it('filters the client list by a partner’s Portal ID, and refuses nonsense', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?referredBy=${approvedPortalId}`).expect(200);
    // Nobody was introduced by this client — an empty list, not every client.
    expect((res.body as { items: unknown[] }).items).toEqual([]);
    await session.get(`${CLIENTS}?referredBy=not-a-client`).expect(400);
  });

  it('filters a money list by Portal ID', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`/v1/admin/wallets?userId=${approvedPortalId}`).expect(200);
    const items = (res.body as { items: { user: { portalId: number } }[] }).items;
    for (const wallet of items) expect(wallet.user.portalId).toBe(approvedPortalId);
  });
});

/**
 * The two columns that replaced a status nobody could read.
 *
 * `users.status` is 'active' | 'pending' | 'suspended', and "pending" was
 * carrying three unrelated meanings: an unconfirmed email, a queued KYC
 * document, and an account that is genuinely not yet active. An operator
 * looking at the directory could not tell which, so the row said "something is
 * incomplete" and nothing more.
 *
 * `emailVerified` and `kycStatus` are now separate columns on the row. What
 * these tests pin is the part that is easy to get wrong and silent when it is:
 *
 *   - the KYC join must be LEFT, so a client who never started verification
 *     still appears — an inner join drops exactly the group most worth chasing;
 *   - `kycStatus=not_started` must match those absent rows, not just rows that
 *     literally store 'not_started';
 *   - the count must use the same join as the page, or `total` describes a
 *     different set than the one being paginated.
 */
describe('verification state is two columns, not one vague status', () => {
  it('reports emailVerified and kycStatus on every row', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?limit=5`).expect(200);
    const body = res.body as { items: Record<string, unknown>[] };

    for (const row of body.items) {
      expect(row).toHaveProperty('emailVerified');
      expect(typeof row['emailVerified']).toBe('boolean');
      // TOTAL — never null, even for a client with no submission row at all.
      expect(row['kycStatus']).toBeTruthy();
      expect([
        'not_started',
        'in_progress',
        'submitted',
        'under_review',
        'approved',
        'rejected',
      ]).toContain(row['kycStatus']);
    }
  });

  it('keeps clients who never started KYC — the join must be LEFT', async () => {
    /*
     * The regression this exists for: with an inner join the list silently
     * loses every client with no `kyc_submissions` row, which on a fresh
     * platform is nearly all of them. The page still renders, so nothing looks
     * broken — the rows are simply gone.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    const all = await session.get(`${CLIENTS}?withTotal=true&limit=100`).expect(200);
    const body = all.body as { items: { email: string; kycStatus: string }[]; total: number };

    // BY EMAIL, not by count: the client with no submission row is the one an
    // inner join loses, so naming it is what makes this test fail on that bug.
    const emails = body.items.map((r) => r.email);
    expect(emails).toContain('never-started@oxshare.com');
    expect(emails).toContain('awaiting-review@oxshare.com');

    const byEmail = new Map(body.items.map((r) => [r.email, r.kycStatus]));
    expect(byEmail.get('never-started@oxshare.com')).toBe('not_started');
    expect(byEmail.get('awaiting-review@oxshare.com')).toBe('submitted');
    expect(byEmail.get('fully-verified@oxshare.com')).toBe('approved');
    // And the count agrees with the page, which it cannot if only one of the
    // two queries carries the join.
    expect(body.total).toBeGreaterThanOrEqual(body.items.length);
  });

  it('filters on kycStatus=not_started, including rows with no submission', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session
      .get(`${CLIENTS}?kycStatus=not_started&withTotal=true&limit=100`)
      .expect(200);
    const body = res.body as { items: { email: string; kycStatus: string }[]; total: number };

    // The client with NO submission row must be in this result — that is the
    // whole point of the coalesce in the predicate.
    expect(body.items.map((r) => r.email)).toContain('never-started@oxshare.com');
    for (const row of body.items) expect(row.kycStatus).toBe('not_started');
    // The count carries the same join, so it describes the same set.
    expect(body.total).toBe(body.items.length);
  });

  it('names the six values for an unknown ?kycStatus= rather than ignoring it', async () => {
    // R-2.5. A silently ignored filter returns the whole list, and "every
    // client" is a plausible enough answer that nobody checks it.
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?kycStatus=nonsense`);
    const body = res.body as { message?: string };

    expect(res.status).toBe(400);
    expect(String(body.message)).toMatch(/not_started/);
    expect(String(body.message)).toMatch(/approved/);
  });

  it('treats an absent emailVerified as "do not filter", not as false', async () => {
    /*
     * The tri-state. `=== 'true'` alone would make an unfiltered list quietly
     * show only unverified clients — a wrong answer that looks like a right
     * one, because the page is full of plausible rows.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    const unfiltered = await session.get(`${CLIENTS}?withTotal=true&limit=100`).expect(200);
    const explicitFalse = await session
      .get(`${CLIENTS}?emailVerified=false&withTotal=true&limit=100`)
      .expect(200);

    const a = (unfiltered.body as { total: number }).total;
    const b = (explicitFalse.body as { total: number }).total;
    expect(a).toBeGreaterThanOrEqual(b);
  });

  it('filters emailVerified in both directions', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    for (const value of ['true', 'false']) {
      const res = await session.get(`${CLIENTS}?emailVerified=${value}&limit=50`).expect(200);
      const body = res.body as { items: { emailVerified: boolean }[] };
      for (const row of body.items) expect(row.emailVerified).toBe(value === 'true');
    }
  });
});

/*
 * ── The Network sections: referrer and referredClients ──
 *
 * These two fields sat in the DTO with NO code assigning them — the old
 * assembly died with the `referral_attributions` teardown (0028) and the
 * replacement read against `users.referred_by_ib_user_id` was never written.
 * Every client profile said "Not introduced by a partner", including clients
 * whose Referral badge derives from the very column that names the introducer.
 * These tests are what would have caught it: they drive the real endpoint and
 * assert the fields ARRIVE, not merely that the screen renders their absence.
 */
describe('the Network sections of the client profile', () => {
  const LIMITED = { email: 'clients-http-no-ib@oxshare.com', password: 'admin-password-123' };
  let partnerId: string;
  let referredId: string;
  let soloId: string;

  beforeAll(async () => {
    const passwords = new PasswordService();
    const passwordHash = await passwords.hash('client-password-123');

    // An admin who may open clients but NOT the partner programme — the
    // sections must be ABSENT for them, not empty.
    await ctx.db.db.insert(admins).values({
      email: LIMITED.email,
      passwordHash: await passwords.hash(LIMITED.password),
      name: 'Clients HTTP No IB View',
      permissions: ['clients.view'],
      status: 'active',
    });

    const [partner, referred, solo] = await ctx.db.db
      .insert(users)
      .values([
        {
          email: 'network-partner@oxshare.com',
          passwordHash,
          firstName: 'Networked',
          lastName: 'Partner',
          emailVerified: true,
          verificationLevel: 1,
        },
        {
          email: 'network-referred@oxshare.com',
          passwordHash,
          firstName: 'Referred',
          lastName: 'Client',
          emailVerified: true,
        },
        {
          email: 'network-solo@oxshare.com',
          passwordHash,
          firstName: 'Walked',
          lastName: 'InAlone',
          emailVerified: true,
        },
      ])
      .returning();
    partnerId = partner.id;
    referredId = referred.id;
    soloId = solo.id;

    // The partner row, on the migration-seeded Default programme.
    const [program] = await ctx.db.db.select().from(ibPrograms).limit(1);
    await ctx.db.db.insert(ibAccounts).values({
      userId: partnerId,
      referralCode: 'HTTP-NETWORK-1',
      programId: program.id,
      active: true,
    });

    // Attribution AFTER the ib_accounts row — the FK points at it.
    await ctx.db.db
      .update(users)
      .set({ referredByIbUserId: partnerId })
      .where(eq(users.id, referredId));
  });

  it('names the introducer on a referred client, matching the Referral badge', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}/${referredId}`).expect(200);
    const body = res.body as {
      type: string;
      referrer?: { ibUserId: string; email: string; active: boolean };
    };

    // The badge and the card must agree — they derive from the same column.
    expect(body.type).toBe('referral');
    expect(body.referrer).toBeDefined();
    expect(body.referrer?.ibUserId).toBe(partnerId);
    expect(body.referrer?.email).toBe('network-partner@oxshare.com');
    expect(body.referrer?.active).toBe(true);
  });

  it("lists the partner's downline with the shown count", async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}/${partnerId}`).expect(200);
    const body = res.body as {
      type: string;
      referredClients?: { clientUserId: string; email: string }[];
      referredShown?: number;
    };

    expect(body.type).toBe('partner');
    expect(body.referredClients?.map((c) => c.clientUserId)).toContain(referredId);
    expect(body.referredShown).toBe(body.referredClients?.length);
  });

  it('sends an EMPTY downline for a client nobody introduced — visible, not missing', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}/${soloId}`).expect(200);
    const body = res.body as { referrer?: unknown; referredClients?: unknown[] };

    // "May see, has none": referrer absent, the list present and empty.
    expect(body.referrer).toBeUndefined();
    expect(body.referredClients).toEqual([]);
  });

  it('withholds both sections from a reader without ib.view', async () => {
    const session = await actingAs(ctx, 'admin', LIMITED);
    const res = await session.get(`${CLIENTS}/${referredId}`).expect(200);
    const body = res.body as { referrer?: unknown; referredClients?: unknown };

    expect('referrer' in body).toBe(false);
    expect('referredClients' in body).toBe(false);
  });
});
