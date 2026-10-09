import { MAX_PAGE_SIZE } from '../src/common/pagination';
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
import { admins, ledgerEntries, roles, users, wallets } from '../src/database/schema';

/**
 * ADM-13 — who may read the ledger, over HTTP, through the real guard chain.
 *
 * `GET /admin/ledger` used to require `withdrawals.view`, and that is the whole
 * point of this file. `ledger_entries` holds SIX entry types — deposit,
 * withdrawal, commission, rebate, payout and adjustment — so only one of them
 * is a withdrawal. Gating the ledger on the withdrawal queue's read key meant
 * that granting somebody payout review also handed them every client deposit
 * and every partner commission the platform has ever recorded.
 *
 * A service test cannot show that: it would assert what the service refuses,
 * and the decorator on the route is the thing that was wrong. Only a request
 * through the assembled chain proves which key the endpoint actually demands.
 */

const LEDGER = '/v1/admin/ledger';

const FULL = { email: 'ledger-full@oxshare.com', password: 'admin-password-123' };
/** Holds the ledger key and nothing else that could explain a 200. */
const READER = { email: 'ledger-reader@oxshare.com', password: 'admin-password-123' };
/** The regression: payout review WITHOUT the ledger. */
const PAYOUTS = { email: 'ledger-payouts@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const hash = await passwords.hash(FULL.password);

  const [fullRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Ledger Full', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();

  await ctx.db.db.insert(admins).values([
    {
      email: FULL.email,
      passwordHash: hash,
      name: 'Ledger Full',
      role: 'master_admin',
      roleId: fullRole.id,
      permissions: ALL_PERMISSIONS,
      status: 'active',
    },
    {
      email: READER.email,
      passwordHash: hash,
      name: 'Ledger Reader',
      role: 'sub_admin',
      permissions: ['ledger.view'],
      status: 'active',
    },
    {
      email: PAYOUTS.email,
      passwordHash: hash,
      name: 'Payout Reviewer',
      role: 'sub_admin',
      permissions: ['withdrawals.view', 'withdrawals.approve', 'withdrawals.settle'],
      status: 'active',
    },
  ]);
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the ledger has its own key', () => {
  it('admits an admin holding ledger.view alone', async () => {
    const session = await actingAs(ctx, 'admin', READER);
    await session.get(LEDGER).expect(200);
  });

  it('REFUSES a payout reviewer — the whole reason the key was split', async () => {
    // withdrawals.view + approve + settle, and still no ledger. Before this
    // change these three permissions read every deposit and commission on the
    // platform.
    const session = await actingAs(ctx, 'admin', PAYOUTS);
    await session.get(LEDGER).expect(403);
  });

  it('answers 403 rather than 401 — the caller is known, just not permitted', async () => {
    // §8.8. A 401 sends the admin app into refresh-and-retry against a request
    // that can never succeed, and signs the operator out of a valid session.
    const session = await actingAs(ctx, 'admin', PAYOUTS);
    const res = await session.get(LEDGER);
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
  });

  it('refuses an anonymous caller with 401', async () => {
    await anonymous(ctx).get(LEDGER).expect(401);
  });
});

describe('what the ledger returns', () => {
  it('pages, and reports the total independently of the page', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LEDGER}?limit=5`).expect(200);
    const body = res.body as { items: unknown[]; total: number; limit: number };

    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(typeof body.total).toBe('number');
  });

  it('carries the wallet number on every entry, joined from the wallet', async () => {
    // This file seeds no money elsewhere — the other reads tolerate an empty
    // ledger — so this test writes the one entry it asserts about.
    const [client] = await ctx.db.db
      .insert(users)
      .values({
        email: 'ledger-numbered@test.local',
        passwordHash: 'x',
        firstName: 'L',
        lastName: 'N',
      })
      .returning();
    const [wallet] = await ctx.db.db
      .insert(wallets)
      .values({ userId: client.id, currency: 'USD', balance: '10' })
      .returning();
    await ctx.db.db.insert(ledgerEntries).values({
      walletId: wallet.id,
      amount: '10',
      balanceAfter: '10',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: 'ledger-numbered',
    });

    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LEDGER}?userId=${client.id}`).expect(200);
    const body = res.body as { items: Array<{ walletId: string; walletNumber: string }> };

    // ADM-13's wallet column renders this; without it the screen falls back
    // to a uuid nobody can compare across rows.
    expect(body.items.length).toBe(1);
    expect(body.items[0].walletId).toBe(wallet.id);
    expect(body.items[0].walletNumber).toBe(wallet.walletNumber);
    expect(body.items[0].walletNumber).toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/);
  });

  it('bounds the page size rather than trusting the querystring', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LEDGER}?limit=100000`).expect(200);
    expect((res.body as { limit: number }).limit).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  it('validates entryType instead of casting it into the query', async () => {
    // The enum reaches a Postgres enum column. An unchecked value surfaces as
    // 22P02 and a 500; `enumQuery` makes it a 400 that names the field.
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LEDGER}?entryType=not-a-type`);

    expect(res.status).toBe(400);
    expect((res.body as { code?: string }).code).toBe('VALIDATION_FAILED');
  });

  it('accepts every entry type the column actually holds', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    for (const type of ['deposit', 'withdrawal', 'commission', 'rebate', 'payout', 'adjustment']) {
      await session.get(`${LEDGER}?entryType=${type}`).expect(200);
    }
  });

  it('serialises money as STRINGS, never numbers (§6.1)', async () => {
    // A running balance that arrives as a JS number is already wrong past 2^53,
    // and the screen formats it with decimal.js on the assumption it is a string.
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(LEDGER).expect(200);
    for (const entry of (res.body as { items: { amount: unknown; balanceAfter: unknown }[] })
      .items) {
      expect(typeof entry.amount).toBe('string');
      expect(typeof entry.balanceAfter).toBe('string');
    }
  });
});

/**
 * WHOSE MONEY IS THIS — on the screen that exists to ask.
 *
 * ADM-13 rendered `r.userId`, a raw uuid in monospace, in a column headed
 * "Client". Its siblings `/wallets` and `/trading-accounts` have shown a named
 * Owner all along, so the ledger was inconsistent with them rather than
 * deliberately anonymous — and the API was the reason it could not be fixed in
 * the frontend: `LedgerEntryDto` carried `userId` and nothing else, and was
 * marked `@NoClientFields('… the person who owns it is not projected here')`.
 * That marking was an accurate description of a bad outcome.
 *
 * Both halves are asserted here, because either alone would be a defect. The
 * identity has to ARRIVE, and it has to be MASKED for an actor whose role hides
 * it — a ledger that names every client to a reader denied those fields is the
 * RBAC-03 leak this project has closed three times on other surfaces.
 */
describe('the ledger says WHOSE money each row is', () => {
  async function seedEntry(email: string, first: string, last: string, ref: string) {
    const [client] = await ctx.db.db
      .insert(users)
      .values({ email, passwordHash: 'x', firstName: first, lastName: last })
      .returning();
    const [wallet] = await ctx.db.db
      .insert(wallets)
      .values({ userId: client.id, currency: 'USD', balance: '25' })
      .returning();
    await ctx.db.db.insert(ledgerEntries).values({
      walletId: wallet.id,
      amount: '25',
      balanceAfter: '25',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: ref,
    });
    return client.id;
  }

  it('names the client, so an operator need not resolve a uuid by hand', async () => {
    const userId = await seedEntry('ledger-named@test.local', 'Nadia', 'Haddad', 'ledger-named');
    const session = await actingAs(ctx, 'admin', FULL);

    const res = await session.get(`/v1/admin/ledger?userId=${userId}`).expect(200);
    const row = (res.body as { items: Array<Record<string, unknown>> }).items.find(
      (r) => r.referenceId === 'ledger-named',
    );

    expect(row, 'the seeded entry did not come back').toBeDefined();
    expect(row!.userFirstName).toBe('Nadia');
    expect(row!.userLastName).toBe('Haddad');
    expect(row!.userEmail).toBe('ledger-named@test.local');
    // The uuid stays — it is the key the screen filters on. What changed is
    // that it is no longer the ONLY thing identifying the person.
    expect(row!.userId).toBe(userId);
  });

  it('MASKS the identity for a role configured to hide it', async () => {
    const userId = await seedEntry('ledger-masked@test.local', 'Omar', 'Khoury', 'ledger-masked');

    const [maskedRole] = await ctx.db.db
      .insert(roles)
      .values({
        name: `Ledger Masked ${Date.now()}`,
        permissions: ALL_PERMISSIONS,
        maskedFields: ['client.email', 'client.firstName', 'client.lastName'],
      })
      .returning();
    const MASKED = {
      email: `ledger-masked-${Date.now()}@oxshare.com`,
      password: 'admin-password-123',
    };
    await ctx.db.db.insert(admins).values({
      email: MASKED.email,
      passwordHash: await new PasswordService().hash(MASKED.password),
      name: 'Ledger Masked Reader',
      role: 'sub_admin',
      roleId: maskedRole.id,
      permissions: ALL_PERMISSIONS,
      status: 'active',
    });

    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(`/v1/admin/ledger?userId=${userId}`).expect(200);
    const row = (res.body as { items: Array<Record<string, unknown>> }).items.find(
      (r) => r.referenceId === 'ledger-masked',
    );

    expect(row, 'the seeded entry did not come back for the masked reader').toBeDefined();
    /*
     * ABSENT, not blanked. `maskByShape` removes the key, which is what lets a
     * screen tell "your role hides this" from "this client has no email" — the
     * distinction the KYC review screen got wrong until Sep 2026.
     */
    expect(row!.userEmail, 'a masked reader was served the client email').toBeUndefined();
    expect(row!.userFirstName).toBeUndefined();
    expect(row!.userLastName).toBeUndefined();
    // The money and the key are NOT client fields and must survive the mask —
    // a reconciliation screen that hides its own amounts is useless.
    expect(row!.amount).toBe('25.00000000');
    expect(row!.userId).toBe(userId);
  });
});

/**
 * FINDING A ROW BY THE NAME THE COLUMN NOW SHOWS.
 *
 * The Client column was given a name and an email, and the filter was left
 * accepting only `userId` — a uuid the page never prints. Half the screen spoke
 * in names and the other half in ids, which is the same defect the wallets desk
 * had and is the reason this one was missed on the first pass.
 */
describe('the ledger can be searched by the client', () => {
  it('finds entries by the owner’s email', async () => {
    const [client] = await ctx.db.db
      .insert(users)
      .values({
        email: 'ledger-search@test.local',
        passwordHash: 'x',
        firstName: 'Search',
        lastName: 'Target',
      })
      .returning();
    const [wallet] = await ctx.db.db
      .insert(wallets)
      .values({ userId: client.id, currency: 'USD', balance: '40' })
      .returning();
    await ctx.db.db.insert(ledgerEntries).values({
      walletId: wallet.id,
      amount: '40',
      balanceAfter: '40',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: 'ledger-search',
    });

    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get('/v1/admin/ledger?q=ledger-search@test.local').expect(200);
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;

    expect(items.length, 'the search found nothing at all').toBeGreaterThan(0);
    expect(items.every((r) => r.userId === client.id)).toBe(true);
  });

  it('finds entries by NAME across first and last, which only the concatenation matches', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get('/v1/admin/ledger?q=search tar').expect(200);
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;

    // 'search tar' spans firstName and lastName. It matches only because the
    // expression searches the CONCATENATION — which is also what keeps the
    // pg_trgm index usable. Three separate ILIKEs would miss it.
    expect(items.length, 'an infix search across first+last name found nothing').toBeGreaterThan(0);
    expect(items[0].userEmail).toBe('ledger-search@test.local');
  });
});
