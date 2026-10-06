import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  ibAccounts,
  roles,
  users,
} from '../src/database/schema';

/**
 * The console's REFERRALS page (owner, 28 Sep 2026): every client a partner
 * introduced, and who introduced them.
 *
 * It is `GET /admin/clients?referred=true`, and each row carries `referrer`.
 * What this file pins:
 *
 *  - the filter is on the ATTRIBUTION, so a referred client who later became a
 *    partner is still listed, and `referred=false` is its exact complement;
 *  - a value other than true/false is a 400, never an unfiltered list under a
 *    "clients a partner introduced" heading;
 *  - the list and the introducer follow the reader's TERRITORY — a client
 *    outside it is not listed, and an introducer outside it is told as
 *    `outsideTerritory` with no identity, never as "not introduced";
 *  - `referrer` needs `ib.view`, as on the profile, and is masked by the
 *    reader's field mask like any other name;
 *  - the CSV carries the same column.
 */

const MASTER = { email: 'referred-master@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'referred-scoped@oxshare.com', password: 'admin-password-123' };
const NO_IB = { email: 'referred-no-ib@oxshare.com', password: 'admin-password-123' };
const MASKED = { email: 'referred-masked@oxshare.com', password: 'admin-password-123' };

const CLIENTS = '/v1/admin/clients';

interface Referrer {
  ibUserId?: number;
  portalId?: number;
  firstName?: string;
  lastName?: string;
  outsideTerritory: boolean;
}
interface Row {
  id: number;
  type: string;
  referrer?: Referrer;
}
interface Page {
  items: Row[];
  total?: number;
}

let ctx: HttpTestContext;
/** A partner inside the scoped reader's territory, and one outside it. */
let partnerIn: { id: number; portalId: number };
let partnerOut: { id: number; portalId: number };
/** Tagged (in territory), introduced by `partnerIn`. */
let clientA: number;
/** Tagged, introduced by the partner OUTSIDE the territory. */
let clientB: number;
/** Untagged (outside the territory), introduced by `partnerIn`. */
let clientC: number;
/** Tagged, introduced by nobody. */
let clientD: number;
/** Tagged, introduced by `partnerIn` — and a partner themselves since. */
let clientE: number;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const admin = async (
    who: { email: string; password: string },
    name: string,
    permissions: string[],
    extra: { maskedFields?: string[]; scoped?: boolean } = {},
  ) => {
    const [role] = await db
      .insert(roles)
      .values({ name, permissions, maskedFields: extra.maskedFields ?? [] })
      .returning();
    const [row] = await db
      .insert(admins)
      .values({
        email: who.email,
        passwordHash: await passwords.hash(who.password),
        name,
        role: extra.scoped ? 'sub_admin' : 'master_admin',
        roleId: role.id,
        permissions: extra.scoped ? [] : ['*'],
        // An untagged fixture client would otherwise be visible through the
        // intake branch, hiding the boundary the scoped cases exist to prove.
        status: 'active',
      })
      .returning();
    return row.id;
  };

  await admin(MASTER, 'Referred Master', ALL_PERMISSIONS);
  const scopedId = await admin(SCOPED, 'Referred Scoped', ALL_PERMISSIONS, { scoped: true });
  await admin(NO_IB, 'Referred No IB', ['clients.view']);
  await admin(MASKED, 'Referred Masked', ['clients.view', 'ib.view'], {
    maskedFields: ['client.firstName', 'client.lastName'],
  });

  const [tag] = await db
    .insert(clientTags)
    .values({ slug: 'referred-mine', label: 'Referred Mine' })
    .returning();
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: scopedId, tagId: tag.id, createdBy: scopedId });

  const person = async (email: string, first: string, referredBy: number | null = null) => {
    const [row] = await db
      .insert(users)
      .values({
        email,
        passwordHash: 'x',
        firstName: first,
        lastName: 'Referred',
        referredByIbUserId: referredBy,
      })
      .returning();
    return row;
  };

  const pIn = await person('referred-partner-in@oxshare-e2e.test', 'Inside');
  const pOut = await person('referred-partner-out@oxshare-e2e.test', 'Outside');
  partnerIn = { id: pIn.id, portalId: pIn.id };
  partnerOut = { id: pOut.id, portalId: pOut.id };
  // Partners FIRST: the attribution column is a foreign key to ib_accounts.
  await db.insert(ibAccounts).values([
    { userId: partnerIn.id, level: 1, active: true, referralCode: 'REFPAGE1' },
    { userId: partnerOut.id, level: 1, active: true, referralCode: 'REFPAGE2' },
  ]);
  clientA = (await person('referred-a@oxshare-e2e.test', 'Alpha', partnerIn.id)).id;
  clientB = (await person('referred-b@oxshare-e2e.test', 'Bravo', partnerOut.id)).id;
  clientC = (await person('referred-c@oxshare-e2e.test', 'Charlie', partnerIn.id)).id;
  clientD = (await person('referred-d@oxshare-e2e.test', 'Delta')).id;
  clientE = (await person('referred-e@oxshare-e2e.test', 'Echo', partnerIn.id)).id;
  await db.insert(ibAccounts).values({
    userId: clientE,
    level: 2,
    active: true,
    referralCode: 'REFPAGE3',
    parentIbUserId: partnerIn.id,
  });

  // Inside the territory: partnerIn and A, B, D, E. Outside: partnerOut and C.
  await db.insert(clientTagAssignments).values(
    [partnerIn.id, clientA, clientB, clientD, clientE].map((userId) => ({
      userId,
      tagId: tag.id,
    })),
  );
}, 240_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

const ids = (page: Page) => page.items.map((row) => row.id);
const rowOf = (page: Page, id: number) => page.items.find((row) => row.id === id);

describe('GET /admin/clients?referred=', () => {
  it('true lists every client a partner introduced — and nobody else', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}?referred=true&limit=100&withTotal=true`).expect(200);
    const page = res.body as Page;

    expect(ids(page)).toEqual(expect.arrayContaining([clientA, clientB, clientC, clientE]));
    expect(ids(page), 'a client nobody introduced is not a referral').not.toContain(clientD);
    expect(ids(page), 'the partners themselves were introduced by nobody').not.toContain(
      partnerIn.id,
    );
    // Every row on the page is a referral — the heading over it is true.
    expect(page.items.every((row) => row.referrer)).toBe(true);
  });

  it('keeps a referred client who became a partner — the attribution, not the type', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}?referred=true&limit=100`).expect(200);
    const echo = rowOf(res.body as Page, clientE);

    expect(
      echo,
      'filtering on the derived type would drop a referred client turned partner',
    ).toBeDefined();
    expect(echo?.type).toBe('partner');
    expect(echo?.referrer?.ibUserId).toBe(partnerIn.id);
  });

  it('names the introducer on each row', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}?referred=true&limit=100`).expect(200);
    const page = res.body as Page;

    expect(rowOf(page, clientA)?.referrer).toEqual({
      ibUserId: partnerIn.id,
      portalId: partnerIn.portalId,
      firstName: 'Inside',
      lastName: 'Referred',
      outsideTerritory: false,
    });
    expect(rowOf(page, clientB)?.referrer).toMatchObject({
      ibUserId: partnerOut.id,
      portalId: partnerOut.portalId,
      firstName: 'Outside',
      outsideTerritory: false,
    });
  });

  it('false is the exact complement', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}?referred=false&limit=100`).expect(200);
    const page = res.body as Page;

    expect(ids(page)).toEqual(expect.arrayContaining([clientD, partnerIn.id, partnerOut.id]));
    for (const referred of [clientA, clientB, clientC, clientE]) {
      expect(ids(page)).not.toContain(referred);
    }
    expect(page.items.some((row) => row.referrer)).toBe(false);
  });

  it('REFUSES any other value rather than answering with every client', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}?referred=yes`);

    expect(res.status, 'a 200 here is an unfiltered list under a referrals heading').toBe(400);
    expect(res.body).not.toHaveProperty('items');
  });

  it('narrows with the other filters — one partner’s referrals', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master
      .get(`${CLIENTS}?referred=true&referredBy=${partnerOut.id}&withTotal=true`)
      .expect(200);
    const page = res.body as Page;

    expect(ids(page)).toEqual([clientB]);
    expect(page.total).toBe(1);
  });

  it('carries the introducer on the plain client list too', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}?q=referred-&limit=100`).expect(200);
    const page = res.body as Page;

    expect(rowOf(page, clientA)?.referrer?.ibUserId).toBe(partnerIn.id);
    expect(rowOf(page, clientD), 'the fixture client is on the page').toBeDefined();
    expect(rowOf(page, clientD)).not.toHaveProperty('referrer');
  });
});

describe("the Referrals page follows the reader's territory", () => {
  it('lists only referred clients inside it, and counts only those', async () => {
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const res = await scoped.get(`${CLIENTS}?referred=true&limit=100&withTotal=true`).expect(200);
    const page = res.body as Page;

    expect(ids(page).sort()).toEqual([clientA, clientB, clientE].sort());
    expect(ids(page), 'a referred client outside the territory was listed').not.toContain(clientC);
    expect(page.total).toBe(3);
  });

  it('tells an introducer outside it as a fact with no identity — never "not introduced"', async () => {
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const res = await scoped.get(`${CLIENTS}?referred=true&limit=100`).expect(200);
    const page = res.body as Page;

    // The fact alone: not even the partner's uuid (R1).
    expect(rowOf(page, clientB)?.referrer).toEqual({ outsideTerritory: true });
    expect(JSON.stringify(page)).not.toContain(partnerOut.id);
    expect(rowOf(page, clientA)?.referrer).toMatchObject({
      portalId: partnerIn.portalId,
      firstName: 'Inside',
      outsideTerritory: false,
    });
  });
});

describe('who may read the introducer', () => {
  it('is absent without ib.view — the rows are as they were', async () => {
    const reader = await actingAs(ctx, 'admin', NO_IB);
    const res = await reader.get(`${CLIENTS}?referred=true&limit=100`).expect(200);
    const page = res.body as Page;

    expect(ids(page), 'the filter still works for a clients.view reader').toContain(clientA);
    expect(page.items.some((row) => 'referrer' in row)).toBe(false);
  });

  it('is masked like any other name — the Portal ID stays', async () => {
    const reader = await actingAs(ctx, 'admin', MASKED);
    const res = await reader.get(`${CLIENTS}?referred=true&limit=100`).expect(200);
    const referrer = rowOf(res.body as Page, clientA)?.referrer;

    expect(referrer?.portalId).toBe(partnerIn.portalId);
    expect(referrer).not.toHaveProperty('firstName');
    expect(referrer).not.toHaveProperty('lastName');
  });
});

describe('GET /admin/clients/export?referred=true', () => {
  it('is the Referrals page as a file, with an Introduced by column', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}/export?referred=true`).expect(200);
    const lines = res.text.split(/\r?\n/);

    expect(lines[0]).toContain('Introduced by');
    const alpha = lines.find((line) => line.includes('referred-a@oxshare-e2e.test'));
    expect(alpha).toContain(`${partnerIn.portalId} Inside Referred`);
    expect(res.text, 'a client nobody introduced is not in the file').not.toContain(
      'referred-d@oxshare-e2e.test',
    );
  });

  it('says "outside your territory" for such an introducer, never a blank', async () => {
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const res = await scoped.get(`${CLIENTS}/export?referred=true`).expect(200);
    const bravo = res.text
      .split(/\r?\n/)
      .find((line) => line.includes('referred-b@oxshare-e2e.test'));

    expect(bravo).toContain('Outside your territory');
    expect(bravo).not.toContain(String(partnerOut.portalId));
    expect(res.text).not.toContain('referred-c@oxshare-e2e.test');
  });

  it('refuses a malformed value like the list does', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}/export?referred=maybe`);
    expect(res.status).toBe(400);
  });
});
