import { MAX_PAGE_SIZE } from '../src/common/pagination';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { legacyRoute } from './support/payment-route';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { UNRESTRICTED } from '../src/common/security/client-scope';
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
  ibWalletTransfers,
  roles,
  tradingAccounts,
  transactions,
  transfers,
  users,
  wallets,
} from '../src/database/schema';

/**
 * The Financial page's API — GET /admin/transactions (+ /summary, /export),
 * over HTTP, through the real guard chain and against real Postgres.
 *
 * What this file pins, and why each half matters:
 *
 *  - **The key.** `transactions.view` and NOTHING ELSE opens it — an admin
 *    holding `withdrawals.view` AND `ledger.view` is still refused, which is
 *    the only proof of which key the route actually demands (the
 *    admin-ledger-http technique).
 *  - **The union.** One client's deposit, withdrawal, wallet⇄account transfer
 *    and commission transfer all appear, with `kind` naming each and transfer
 *    states mapped into the transaction vocabulary.
 *  - **The scope, including the counts.** The 13 Aug badge leak, re-asserted
 *    one level up: an out-of-territory movement must be absent from the rows
 *    AND from `counts`/`directionCounts` AND from the summary AND the CSV.
 *  - **Money as strings**, exact to the character (§6.1).
 */

const LIST = '/v1/admin/transactions';
const SUMMARY = '/v1/admin/transactions/summary';
const EXPORT = '/v1/admin/transactions/export';

const FULL = { email: 'fin-full@oxshare.com', password: 'admin-password-123' };
/** Holds `transactions.view` and nothing else that could explain a 200. */
const READER = { email: 'fin-reader@oxshare.com', password: 'admin-password-123' };
/** The regression: withdrawals + ledger, and still no Financial page. */
const MONEY_DESK = { email: 'fin-desk@oxshare.com', password: 'admin-password-123' };
/** Scoped to one tag; the out-of-territory client must be invisible. */
const SCOPED = { email: 'fin-scoped@oxshare.com', password: 'admin-password-123' };
/** RBAC-03: may read the page, may NOT see the client's email or first name. */
const MASKED = { email: 'fin-masked@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;

/** The union client: one movement of every kind, seeded in beforeAll. */
let unionClientId: number;
/** The out-of-territory client whose movement must never reach SCOPED. */
let outsiderId: number;

async function seedClient(email: string, firstName: string, lastName: string) {
  const [client] = await ctx.db.db
    .insert(users)
    .values({ email, passwordHash: 'x', firstName, lastName })
    .returning();
  const [main] = await ctx.db.db
    .insert(wallets)
    .values({ userId: client.id, currency: 'USD', balance: '0', onHold: '0' })
    .returning();
  return { client, main };
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();
  const hash = await passwords.hash(FULL.password);

  const [fullRole] = await db
    .insert(roles)
    .values({ name: 'Fin Full', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();

  await db.insert(admins).values([
    {
      email: FULL.email,
      passwordHash: hash,
      name: 'Fin Full',
      role: 'master_admin',
      roleId: fullRole.id,
      permissions: ALL_PERMISSIONS,
      status: 'active',
    },
    {
      email: READER.email,
      passwordHash: hash,
      name: 'Fin Reader',
      role: 'sub_admin',
      permissions: ['transactions.view'],
      status: 'active',
    },
    {
      email: MONEY_DESK.email,
      passwordHash: hash,
      name: 'Fin Desk',
      role: 'sub_admin',
      permissions: [
        'withdrawals.view',
        'withdrawals.approve',
        'withdrawals.settle',
        'ledger.view',
        'wallets.view',
      ],
      status: 'active',
    },
  ]);

  // RBAC-03 — a reader whose ROLE hides the email and first name. The mask
  // lives on the role and the guard resolves it (with the catalog's aliases)
  // into actor.fieldMask on every request.
  const [maskedRole] = await db
    .insert(roles)
    .values({
      name: 'Fin Masked Reader',
      // `transactions.view`, or the routes answer 403 and every masking
      // assertion below passes while proving nothing — the vacuity trap the
      // field-masking spec's fixture documents.
      permissions: ['clients.view', 'transactions.view'],
      maskedFields: ['client.email', 'client.firstName'],
    })
    .returning();
  await db.insert(admins).values({
    email: MASKED.email,
    passwordHash: hash,
    name: 'Fin Masked',
    role: 'sub_admin',
    roleId: maskedRole.id,
    permissions: [],
    status: 'active',
  });

  // ── The union client: every kind of movement, all USD ─────────────────────
  const { client, main } = await seedClient('fin-union@oxshare-e2e.test', 'Una', 'Union');
  unionClientId = client.id;

  const [commission] = await db
    .insert(wallets)
    .values({ userId: client.id, currency: 'USD', balance: '0', onHold: '0', kind: 'commission' })
    .returning();
  const [account] = await db
    .insert(tradingAccounts)
    .values({
      userId: client.id,
      login: '5109001',
      mt5Group: 'real\\Standard',
      environment: 'live',
      currency: 'USD',
      leverage: 100,
    })
    .returning();

  await db.insert(transactions).values([
    {
      userId: client.id,
      walletId: main.id,
      direction: 'deposit',
      amount: '100.12345678',
      currency: 'USD',
      state: 'success',
      provider: 'manual_test',
      ...legacyRoute('manual_test', 'deposit'),
      providerRef: 'fin-union-dep',
      createdAt: new Date('2026-08-01T10:00:00Z'),
      settledAt: new Date('2026-08-01T10:05:00Z'),
    },
    {
      userId: client.id,
      walletId: main.id,
      direction: 'withdrawal',
      amount: '40.00000000',
      currency: 'USD',
      state: 'pending',
      provider: 'manual_test',
      ...legacyRoute('manual_test', 'withdrawal'),
      destination: 'fin-union-dest',
      createdAt: new Date('2026-08-02T11:00:00Z'),
    },
  ]);
  await db.insert(transfers).values({
    userId: client.id,
    walletId: main.id,
    tradingAccountId: account.id,
    direction: 'wallet_to_account',
    amount: '25.50000000',
    currency: 'USD',
    state: 'settled',
    settledAt: new Date('2026-08-03T12:05:00Z'),
    createdAt: new Date('2026-08-03T12:00:00Z'),
  });
  await db.insert(ibWalletTransfers).values({
    userId: client.id,
    fromWalletId: commission.id,
    toWalletId: main.id,
    amount: '7.75000000',
    currency: 'USD',
    createdAt: new Date('2026-08-04T13:00:00Z'),
  });

  // ── Territory: a scoped admin, one in-scope and one out-of-scope client ───
  const [scopedRole] = await db
    .insert(roles)
    .values({ name: 'Fin Scoped Desk', permissions: ['clients.view', 'transactions.view'] })
    .returning();
  const [scopedAdmin] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: hash,
      name: 'Fin Scoped',
      role: 'sub_admin',
      roleId: scopedRole.id,
      permissions: [],
      // Restricted from intake, so the union client (untagged) is genuinely
      // out of reach — this file's scope tests are about territory.
      status: 'active',
    })
    .returning();

  const [tag] = await db
    .insert(clientTags)
    .values({ slug: 'fin-scope-mine', label: 'Fin Scope Mine' })
    .returning();
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: scopedAdmin.id, tagId: tag.id, createdBy: scopedAdmin.id });

  const mine = await seedClient('fin-mine@oxshare-e2e.test', 'Mia', 'Mine');
  await db.insert(clientTagAssignments).values({ userId: mine.client.id, tagId: tag.id });
  await db.insert(transactions).values({
    userId: mine.client.id,
    walletId: mine.main.id,
    direction: 'deposit',
    amount: '11.00000000',
    currency: 'USD',
    state: 'success',
    provider: 'manual_test',
    ...legacyRoute('manual_test', 'deposit'),
    providerRef: 'fin-mine-dep',
  });

  const outside = await seedClient('fin-outside@oxshare-e2e.test', 'Otto', 'Outside');
  outsiderId = outside.client.id;
  await db.insert(clientTagAssignments).values({
    userId: outside.client.id,
    tagId: (
      await db
        .insert(clientTags)
        .values({ slug: 'fin-scope-other', label: 'Fin Scope Other' })
        .returning()
    )[0].id,
  });
  await db.insert(transactions).values({
    userId: outside.client.id,
    walletId: outside.main.id,
    direction: 'withdrawal',
    amount: '999.00000000',
    currency: 'USD',
    state: 'pending',
    provider: 'manual_test',
    ...legacyRoute('manual_test', 'withdrawal'),
    destination: 'fin-outside-dest',
  });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

type ListBody = {
  items: Array<{
    id: string;
    kind: string;
    direction: string;
    state: string;
    amount: string;
    currency: string;
    methodName: string;
    user: { id: number; email: string; firstName: string; lastName: string };
  }>;
  nextCursor: string | null;
  total: number;
  counts: Record<string, number>;
  directionCounts: Record<string, number>;
};

describe('the Financial page has its own key', () => {
  it('admits an admin holding transactions.view alone', async () => {
    const session = await actingAs(ctx, 'admin', READER);
    await session.get(LIST).expect(200);
    await session.get(SUMMARY).expect(200);
  });

  it('REFUSES the whole money desk — withdrawals + ledger is still not this power', async () => {
    // withdrawals.view + approve + settle + ledger.view + wallets.view, and
    // still no platform-wide movement list. This is the assertion that proves
    // which key the routes demand.
    const session = await actingAs(ctx, 'admin', MONEY_DESK);
    await session.get(LIST).expect(403);
    await session.get(SUMMARY).expect(403);
    await session.get(EXPORT).expect(403);
  });

  it('refuses an anonymous caller with 401', async () => {
    await anonymous(ctx).get(LIST).expect(401);
  });
});

describe('the union: every kind of movement, one list', () => {
  it('returns all four kinds for the union client, states mapped', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LIST}?userId=${unionClientId}`).expect(200);
    const body = res.body as ListBody;

    expect(body.total).toBe(4);
    const byKindDirection = new Map(body.items.map((row) => [`${row.kind}:${row.direction}`, row]));
    // The two payments pass through untouched.
    expect(byKindDirection.get('payment:deposit')?.state).toBe('success');
    expect(byKindDirection.get('payment:withdrawal')?.state).toBe('pending');
    // wallet_to_account: direction from the wallet's side, settled → success.
    expect(byKindDirection.get('transfer:withdrawal')?.state).toBe('success');
    // commission → main wallet: always a deposit, always success.
    expect(byKindDirection.get('commission_transfer:deposit')?.state).toBe('success');
  });

  it('joins the client onto every row — the list is platform-wide', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LIST}?userId=${unionClientId}`).expect(200);
    for (const row of (res.body as ListBody).items) {
      expect(row.user.id).toBe(unionClientId);
      expect(row.user.email).toBe('fin-union@oxshare-e2e.test');
      expect(row.user.firstName).toBe('Una');
    }
  });

  it('serialises money as the EXACT string the column holds (§6.1)', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session
      .get(`${LIST}?userId=${unionClientId}&kind=payment&direction=deposit`)
      .expect(200);
    const body = res.body as ListBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].amount).toBe('100.12345678');
    expect(typeof body.items[0].amount).toBe('string');
  });
});

describe('filters', () => {
  const get = async (qs: string): Promise<ListBody> => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LIST}?userId=${unionClientId}&${qs}`).expect(200);
    return res.body as ListBody;
  };

  it('direction narrows across BOTH tables', async () => {
    const body = await get('direction=deposit');
    // The payment deposit and the commission transfer — not the transfer out.
    expect(body.total).toBe(2);
    expect(body.items.every((row) => row.direction === 'deposit')).toBe(true);
  });

  /*
   * The deposits desk asks for what a PERSON decides (0168). A deposit on
   * Rival's hosted page is settled by Rival; listed there, it offered an
   * Approve the API could only refuse.
   */
  it("decidedBy=desk keeps the desk's movements and drops a provider-settled deposit", async () => {
    const [wallet] = await ctx.db.db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, unionClientId));
    const [hosted] = await ctx.db.db
      .insert(transactions)
      .values({
        userId: unionClientId,
        walletId: wallet.id,
        direction: 'deposit',
        amount: '5.00000000',
        currency: 'USD',
        state: 'pending',
        provider: 'whish',
        ...legacyRoute('whish', 'deposit'),
        providerRef: 'fin-union-hosted',
        createdAt: new Date('2026-08-06T09:00:00Z'),
      })
      .returning({ id: transactions.id });
    try {
      const all = await get('kind=payment');
      expect(all.total).toBe(3);
      const desk = await get('kind=payment&decidedBy=desk');
      expect(desk.total).toBe(2);
      expect(desk.items.map((row) => row.id)).not.toContain(hosted.id);
      // Transfers are nobody's to approve.
      expect((await get('decidedBy=desk')).total).toBe(2);
    } finally {
      await ctx.db.db.delete(transactions).where(eq(transactions.providerRef, 'fin-union-hosted'));
    }
  });

  it('kind isolates the transfer arms', async () => {
    expect((await get('kind=payment')).total).toBe(2);
    expect((await get('kind=transfer')).total).toBe(1);
    expect((await get('kind=commission_transfer')).total).toBe(1);
  });

  it('state matches the MAPPED vocabulary — a settled transfer is success', async () => {
    const body = await get('state=success');
    expect(body.total).toBe(3);
  });

  it('q searches the client email and name', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const byEmail = (await session.get(`${LIST}?q=fin-union%40`).expect(200)).body as ListBody;
    expect(byEmail.total).toBe(4);
    const byName = (await session.get(`${LIST}?q=Una`).expect(200)).body as ListBody;
    expect(byName.items.every((row) => row.user.firstName === 'Una')).toBe(true);
    expect(byName.total).toBeGreaterThanOrEqual(4);
  });

  it('from/to are INCLUSIVE by date part — the end date does not vanish', async () => {
    // The transfer sits at 12:00Z on the 3rd. A naive `created_at <= '2026-08-03'`
    // (midnight) would exclude it; the ::date comparison keeps it.
    const body = await get('from=2026-08-03&to=2026-08-03');
    expect(body.total).toBe(1);
    expect(body.items[0].kind).toBe('transfer');
  });

  it('a from after every movement returns nothing rather than everything', async () => {
    expect((await get('from=2027-01-01')).total).toBe(0);
  });
});

describe('validation — a typo is a 400 with a sentence, never a 500', () => {
  const expect400 = async (qs: string) => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LIST}?${qs}`);
    expect(res.status, `${qs} should be a 400`).toBe(400);
    expect(res.status).not.toBe(500);
  };

  it('rejects an unknown state', () => expect400('state=nonsense'));
  it('rejects an unknown direction', () => expect400('direction=sideways'));
  it('rejects an unknown kind', () => expect400('kind=magic'));
  it('rejects a non-UUID userId', () => expect400('userId=abc'));
  it('rejects a malformed date', () => expect400('from=yesterday'));
  it('rejects an impossible date', () => expect400('to=2026-02-31'));
  it('rejects an unknown sort key rather than silently ignoring it', () =>
    expect400('sort=provider'));

  it('bounds the page size rather than trusting the querystring', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LIST}?limit=100000`).expect(200);
    expect((res.body as { limit: number }).limit).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });
});

describe('counts — the two-axis rule, on both axes', () => {
  it('state counts ignore the active state filter but total matches it', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LIST}?userId=${unionClientId}&state=pending`).expect(200);
    const body = res.body as ListBody;

    // The page narrows to the one pending row…
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    // …while the tabs still describe every state's size.
    expect(body.counts['all']).toBe(4);
    expect(body.counts['pending']).toBe(1);
    expect(body.counts['success']).toBe(3);
  });

  it('direction counts ignore ONLY the direction filter — each facet its own axis', async () => {
    // Symmetry with the state facet: a facet ignores exactly its own axis and
    // honours every other filter, so the two facet rows on one screen always
    // describe the same filtered set. With kind=payment active, the direction
    // tabs must count PAYMENTS per direction — not quietly re-admit the
    // transfers the kind filter excluded (a tab claiming 120 whose click
    // lists 80).
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session
      .get(`${LIST}?userId=${unionClientId}&direction=deposit&kind=payment`)
      .expect(200);
    const body = res.body as ListBody;

    expect(body.total).toBe(1);
    expect(body.directionCounts['all']).toBe(2);
    expect(body.directionCounts['deposit']).toBe(1);
    expect(body.directionCounts['withdrawal']).toBe(1);

    // Without the kind filter the tabs describe the whole union again.
    const unfiltered = (
      await session.get(`${LIST}?userId=${unionClientId}&direction=deposit`).expect(200)
    ).body as ListBody;
    expect(unfiltered.directionCounts['all']).toBe(4);
    expect(unfiltered.directionCounts['deposit']).toBe(2);
    expect(unfiltered.directionCounts['withdrawal']).toBe(2);
  });
});

describe('keyset pagination — R-2.4', () => {
  it('a concurrent insert cannot skip or duplicate a row across pages', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const page1 = (await session.get(`${LIST}?userId=${unionClientId}&limit=2`).expect(200))
      .body as ListBody;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    // A new movement lands at the HEAD while the admin reads page 1 — the
    // exact case offset paging shifts a row across the boundary.
    const [wallet] = await ctx.db.db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, unionClientId));
    await ctx.db.db.insert(transactions).values({
      userId: unionClientId,
      walletId: wallet.id,
      direction: 'deposit',
      amount: '1.00000000',
      currency: 'USD',
      state: 'success',
      provider: 'manual_test',
      ...legacyRoute('manual_test', 'deposit'),
      providerRef: 'fin-union-concurrent',
      createdAt: new Date('2026-08-05T09:00:00Z'),
    });

    try {
      const page2 = (
        await session
          .get(
            `${LIST}?userId=${unionClientId}&limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
          )
          .expect(200)
      ).body as ListBody;

      const seen = new Set(page1.items.map((row) => row.id));
      for (const row of page2.items) {
        expect(seen.has(row.id), 'page 2 re-served a row from page 1').toBe(false);
      }
      // Everything OLDER than page 1's last row still arrives — nothing skipped.
      expect(page1.items.length + page2.items.length).toBe(4);
    } finally {
      await ctx.db.db
        .delete(transactions)
        .where(eq(transactions.providerRef, 'fin-union-concurrent'));
    }
  });

  it('refuses a cursor minted under a different ordering', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const page1 = (await session.get(`${LIST}?userId=${unionClientId}&limit=2`).expect(200))
      .body as ListBody;
    // Minted under createdAt; replayed against amount it is a position in a
    // different ordering, and the failure would otherwise be silently wrong rows.
    await session
      .get(
        `${LIST}?userId=${unionClientId}&limit=2&sort=amount&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
      )
      .expect(400);
  });
});

describe('the summary — server-computed strings, grouped per currency', () => {
  type SummaryBody = {
    rows: Array<{
      direction: string;
      kind: string;
      state: string;
      currency: string;
      count: number;
      total: string;
    }>;
  };

  it('sums in the database and returns strings with the column scale', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${SUMMARY}?userId=${unionClientId}`).expect(200);
    const body = res.body as SummaryBody;

    const depositPayments = body.rows.find(
      (row) =>
        row.direction === 'deposit' &&
        row.kind === 'payment' &&
        row.state === 'success' &&
        row.currency === 'USD',
    );
    expect(depositPayments?.count).toBe(1);
    expect(depositPayments?.total).toBe('100.12345678');
    expect(typeof depositPayments?.total).toBe('string');

    // Every group names its currency — nothing is summed across currencies.
    expect(body.rows.every((row) => row.currency === 'USD')).toBe(true);
  });

  it('honours the same filters as the list', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session
      .get(`${SUMMARY}?userId=${unionClientId}&kind=commission_transfer`)
      .expect(200);
    const body = res.body as SummaryBody;
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].total).toBe('7.75000000');
  });

  it('carries per-direction headline totals, still per currency', async () => {
    // The tiles' numbers — computed by the SERVER from the same predicate,
    // never by the page adding the fine-grained rows together.
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${SUMMARY}?userId=${unionClientId}`).expect(200);
    const body = res.body as SummaryBody & {
      directions: Array<{ direction: string; currency: string; count: number; total: string }>;
    };

    const deposits = body.directions.find(
      (row) => row.direction === 'deposit' && row.currency === 'USD',
    );
    // The payment deposit (100.12345678) + the commission transfer (7.75).
    expect(deposits?.count).toBe(2);
    expect(deposits?.total).toBe('107.87345678');
    const withdrawals = body.directions.find(
      (row) => row.direction === 'withdrawal' && row.currency === 'USD',
    );
    // The pending payment withdrawal (40) + the trading transfer (25.5).
    expect(withdrawals?.count).toBe(2);
    expect(withdrawals?.total).toBe('65.50000000');
  });
});

describe('THE LEAK TEST: territory holds on every surface', () => {
  it('rows: the scoped admin sees only their own client', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const body = (await session.get(LIST).expect(200)).body as ListBody;
    expect(body.total).toBe(1);
    expect(body.items[0].user.email).toBe('fin-mine@oxshare-e2e.test');
  });

  it('counts and directionCounts: no aggregate intelligence leaks either', async () => {
    // The 13 Aug badge leak, re-asserted here: the out-of-scope pending
    // withdrawal must not move this reader's tabs.
    const session = await actingAs(ctx, 'admin', SCOPED);
    const body = (await session.get(LIST).expect(200)).body as ListBody;
    expect(body.counts['all']).toBe(1);
    expect(body.counts['pending'] ?? 0).toBe(0);
    expect(body.directionCounts['all']).toBe(1);
    expect(body.directionCounts['withdrawal'] ?? 0).toBe(0);
  });

  it('summary: the out-of-scope amount is absent from the totals', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get(SUMMARY).expect(200);
    const rows = (res.body as { rows: Array<{ total: string }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe('11.00000000');
  });

  it('export: the file omits the out-of-scope client (the worst possible leak)', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get(EXPORT).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('fin-mine@oxshare-e2e.test');
    expect(res.text).not.toContain('fin-outside@oxshare-e2e.test');
    expect(res.text).not.toContain(String(outsiderId));
  });

  it('a MASTER admin exporting the same list sees both, amounts verbatim', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${EXPORT}?state=pending`).expect(200);
    expect(res.text).toContain('fin-outside@oxshare-e2e.test');
    // §6.1 in the file: the exact decimal string, never rounded or formatted.
    expect(res.text).toContain('999.00000000');
  });
});

describe('RBAC-03: the joined client is masked like everywhere else', () => {
  it('omits the masked fields from every row, keeping id and the rest', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const body = (await session.get(LIST).expect(200)).body as ListBody & {
      maskedFields?: string[];
    };
    // Guards the fixture: an empty list would make every assertion vacuous.
    expect(body.items.length).toBeGreaterThan(0);

    for (const row of body.items) {
      expect('email' in row.user, 'email survived masking').toBe(false);
      expect('firstName' in row.user, 'firstName survived masking').toBe(false);
      // The id stays — the row is addressed by it (client.id is unmaskable) —
      // and lastName stays because only email and firstName were hidden.
      expect(row.user.id).toBeDefined();
      expect(row.user.lastName).toBeDefined();
    }
  });

  it('never puts the masked value anywhere in the response', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(LIST).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('fin-union@oxshare-e2e.test');
    expect(JSON.stringify(res.body)).not.toContain('Una');
  });

  it('announces its OWN paths and nobody else’s', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const body = (await session.get(LIST).expect(200)).body as { maskedFields: string[] };

    expect(body.maskedFields).toContain('financial.user.email');
    expect(body.maskedFields).toContain('financial.user.firstName');
    // A response is a promise about ITS rows: the export's flat spelling —
    // and every other surface's prefix — must not leak in here.
    expect(body.maskedFields.every((key) => key.startsWith('financial.'))).toBe(true);
  });

  it('the CSV leaves an EMPTY CELL under a kept header — never a way around', async () => {
    const session = await actingAs(ctx, 'admin', MASKED);
    const res = await session.get(EXPORT).expect(200);

    // The header row survives whole, so nothing shifts under a wrong heading…
    expect(res.text).toContain('Client email');
    expect(res.text).toContain('Client first name');
    // …while the masked values are simply not in the file.
    expect(res.text).not.toContain('fin-union@oxshare-e2e.test');
    expect(res.text).not.toContain('Una');
    // And the unmasked column still carries its values.
    expect(res.text).toContain('Union');
  });

  it('a hidden email is found by its complete address, never by a fragment (D-82)', async () => {
    /*
     * This case used to pin the opposite — "the mask is display, not scope":
     * a fragment of a hidden email still filtered the list. That was the
     * oracle: "f", "fi", "fin"… and the row count spells the address out. The
     * owner's rule keeps the one lookup support needs — the complete address
     * they already hold, audited — and nothing else.
     */
    const session = await actingAs(ctx, 'admin', MASKED);
    const fragment = (await session.get(`${LIST}?q=fin-union`).expect(200)).body as ListBody;
    expect(fragment.total).toBe(0);

    const complete = (
      await session.get(`${LIST}?q=${encodeURIComponent('fin-union@oxshare-e2e.test')}`).expect(200)
    ).body as ListBody;
    expect(complete.total).toBeGreaterThan(0);
    expect(JSON.stringify(complete)).not.toContain('fin-union@oxshare-e2e.test');
  });
});

describe('the export is audited', () => {
  it('writes an export.transactions row carrying the filters', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    await session.get(`${EXPORT}?state=pending`).expect(200);

    /*
     * audit.record is fire-and-forget, so give the row a moment to land — and
     * assert that SOME export.transactions row carries these filters rather
     * than indexing into an unordered result: the scope tests above also
     * export, a SELECT without ORDER BY returns their rows in any order, and
     * "the last element" was a coin flip that failed one run in three.
     */
    const hasFilteredRow = () =>
      ctx.db.db
        .select({ action: auditLog.action, details: auditLog.details })
        .from(auditLog)
        .where(eq(auditLog.action, 'export.transactions'))
        .then((rows) =>
          rows.some(
            (row) =>
              (row.details as { filters?: { state?: string } })?.filters?.state === 'pending',
          ),
        );

    let found = await hasFilteredRow();
    for (let attempt = 0; attempt < 20 && !found; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      found = await hasFilteredRow();
    }
    expect(found).toBe(true);
  });
});

describe('cursor hygiene — a bad token is a 400, never a database error', () => {
  // The seek casts the cursor's value and id (`::numeric`, `::uuid`); an
  // unvalidated token would reach Postgres and surface as a 22P02 500 — the
  // exact class R-2.1 exists to prevent, via a token a proxy or a frontend
  // bug can corrupt in flight.
  const mint = (position: object) =>
    Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');

  it('rejects a non-numeric value under sort=amount', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const cursor = mint({
      sort: 'amount',
      value: 'not-a-number',
      id: '11111111-1111-1111-1111-111111111111',
    });
    const res = await session.get(`${LIST}?sort=amount&cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it('rejects a non-uuid id whatever the sort', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const cursor = mint({ sort: 'state', value: 'pending', id: 'not-a-uuid' });
    const res = await session.get(`${LIST}?sort=state&cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });
});

describe('keyset precision — rows sharing a millisecond are never skipped', () => {
  it('walks three same-millisecond rows across three pages, losing none', async () => {
    const { client, main } = await seedClient('fin-micro@oxshare-e2e.test', 'Mia', 'Micro');
    /*
     * Raw SQL, because a JS Date cannot express microseconds — and the
     * microseconds ARE the regression: a cursor minted from a ms-truncated
     * boundary (.123) seeks past every same-millisecond row with smaller
     * microseconds (.123200 is neither < .123 nor equal to it), so the row
     * vanishes from every page with nothing erroring anywhere.
     */
    for (const [ref, fraction] of [
      ['fin-micro-a', '123456'],
      ['fin-micro-x', '123200'],
      ['fin-micro-c', '100000'],
    ] as const) {
      await ctx.db.db.execute(sql`
        INSERT INTO transactions
          (user_id, wallet_id, direction, amount, currency, state, provider, provider_ref, created_at)
        VALUES
          (${client.id}::integer, ${main.id}::uuid, 'deposit', '1.00000000', 'USD', 'success',
           'manual_test', ${ref}, ${`2026-07-01T09:00:00.${fraction}Z`}::timestamptz)
      `);
    }

    const session = await actingAs(ctx, 'admin', FULL);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let hop = 0; hop < 5; hop += 1) {
      const url = `${LIST}?userId=${client.id}&limit=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      const body = (await session.get(url).expect(200)).body as ListBody;
      for (const row of body.items) seen.push(row.id);
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });
});

describe('the currency filter is validated, never silently empty', () => {
  it('resolves a lower-case code to the stored currency', async () => {
    const session = await actingAs(ctx, 'admin', FULL);
    const body = (await session.get(`${LIST}?userId=${unionClientId}&currency=usd`).expect(200))
      .body as ListBody;
    expect(body.total).toBe(4);
  });

  it('rejects an unknown code with a sentence rather than an empty 200', async () => {
    // `?currency=ZZZ` answering an empty list with a 200 is the report-shaped
    // failure: an operator exporting "all ZZZ movements" reads the empty file
    // as "there were none".
    const session = await actingAs(ctx, 'admin', FULL);
    const res = await session.get(`${LIST}?currency=ZZZ`);
    expect(res.status).toBe(400);
    expect((res.body as { code?: string }).code).toBe('VALIDATION_FAILED');
  });
});

describe('search treats LIKE metacharacters as literals', () => {
  it('an underscore does not become a one-character wildcard', async () => {
    // 'fin_union' would match 'fin-union@…' if _ passed through unescaped —
    // a confidently over-broad result set on a money list.
    const session = await actingAs(ctx, 'admin', FULL);
    const body = (await session.get(`${LIST}?q=fin_union`).expect(200)).body as ListBody;
    expect(body.total).toBe(0);
  });
});

describe('the export is frozen at its start and keyset-batched', () => {
  it('chains batches without duplicating a boundary row, excluding mid-export inserts', async () => {
    const service = ctx.app.get(TransactionsService);
    const startedAt = new Date();
    const base = { scope: UNRESTRICTED, userId: unionClientId, startedAt, limit: 3 };

    const batch1 = await service.listAllForExport(base);
    expect(batch1).toHaveLength(3);

    // A movement lands between batches — newest, so under OFFSET batching it
    // would push every already-streamed row down one and emit the boundary
    // row twice; a reconciliation spreadsheet then double-counts its amount.
    const [wallet] = await ctx.db.db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, unionClientId));
    await ctx.db.db.insert(transactions).values({
      userId: unionClientId,
      walletId: wallet.id,
      direction: 'deposit',
      amount: '2.00000000',
      currency: 'USD',
      state: 'success',
      provider: 'manual_test',
      ...legacyRoute('manual_test', 'deposit'),
      providerRef: 'fin-export-mid',
    });
    try {
      const last = batch1[batch1.length - 1];
      const batch2 = await service.listAllForExport({
        ...base,
        after: { createdAt: last.cursorCreatedAt, id: last.id },
      });

      const ids = [...batch1, ...batch2].map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length); // no boundary duplicate
      expect(ids).toHaveLength(4); // …and nothing skipped
      // The mid-export insert is excluded by the startedAt snapshot bound.
      expect(batch2.some((row) => row.providerRef === 'fin-export-mid')).toBe(false);
    } finally {
      await ctx.db.db.delete(transactions).where(eq(transactions.providerRef, 'fin-export-mid'));
    }
  });
});
