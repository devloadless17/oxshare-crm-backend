import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { IbApplicationsService } from '../src/modules/ib/ib-applications.service';
import { IbLevelsService } from '../src/modules/ib/ib-levels.service';
import { IbStore } from '../src/store/ib.store';
import { ProductsStore } from '../src/store/products.store';
import { UsersStore } from '../src/store/users.store';
import { ClientVisibilityService } from '../src/common/security/client-visibility.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { WalletProvisioningService } from '../src/modules/wallet/wallet-provisioning.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { WalletsStore } from '../src/store/wallets.store';
import type { EmailService } from '../src/modules/email/email.service';
import { scopeOf, UNRESTRICTED, type ClientScope } from '../src/common/security/client-scope';
import { auditStubAs } from './audit-stub';
import { notificationsStubAs } from './notifications-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * THE PARTNER DIRECTORY — `GET /admin/ib/partners`, behind the console's
 * Partners page (25 Sep 2026).
 *
 * The page existed once and was deleted on 13 Aug, for a reason that is the
 * first thing pinned here: it and the client list disagreed about who WAS a
 * partner — 7 against 1 — because this list read `ib_accounts` while the
 * client filter read a label nothing maintained. The client type is derived
 * from `ib_accounts` now, so the two read one table, and "the totals agree" is
 * asserted rather than assumed, unrestricted AND through a territory.
 *
 * The rest is what the directory gained on its return, each with the failure it
 * exists to prevent:
 *
 *   - SEARCH that never widens scope — a referral code is exactly the thing a
 *     scoped desk might guess;
 *   - the parent named by Portal ID, never by the uuid of a partner the reader
 *     is denied;
 *   - earnings ONE LINE PER CURRENCY — they were summed across currencies and
 *     printed as the platform default, a plausible figure describing nothing.
 */

let ctx: MoneyTestContext;
let service: IbApplicationsService;
let store: IbStore;
let users: UsersStore;

/** The two desks. Disjoint on purpose — the scope cases need a real outside. */
let deskA: string;
let deskB: string;

/** A level-1 partner on desk A, with commission in two currencies. */
const top = { id: 0, portalId: 0 };
/** Their level-2 recruit, on desk B — whose parent desk B cannot see. */
const child = { id: 0, portalId: 0 };
/** A suspended partner on desk A. */
const dormant = { id: 0, portalId: 0 };

async function makeUser(email: string, first: string, last: string, tag?: string) {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', ${first}, ${last}, 1, true)
    RETURNING id
  `);
  const user = { id: rows[0].id, portalId: rows[0].id };
  if (tag) {
    await ctx.db.execute(sql`
      INSERT INTO client_tag_assignments (user_id, tag_id) VALUES (${user.id}, ${tag})
    `);
  }
  return user;
}

async function makeTag(slug: string, label: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO client_tags (slug, label) VALUES (${slug}, ${label}) RETURNING id
  `);
  return rows[0].id;
}

let accrualSeq = 0;
/** One accrual for `top`. Each source id is fresh, so none is a replay. */
async function accrue(
  currency: string,
  amount: string,
  status: 'confirmed' | 'pending' | 'reversed',
  kind: 'commission' | 'rebate' = 'commission',
  clientUserId = child.id,
  /** 0209 — a LEGACY rebate paid to the client rather than the partner. */
  paidToClient = false,
) {
  accrualSeq += 1;
  const sourceId = `00000000-0000-4000-8000-${String(accrualSeq).padStart(12, '0')}`;
  await ctx.db.execute(sql`
    INSERT INTO ib_accruals
      (ib_user_id, client_user_id, kind, source_type, source_id, depth, rate_value,
       base_amount, amount, currency, status, paid_to_client)
    VALUES
      (${top.id}, ${clientUserId}, ${kind}, 'transaction', ${sourceId}, 1, '10.0000',
       '1000.00000000', ${amount}, ${currency}, ${status}, ${paidToClient})
  `);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new IbStore(ctx.db);
  users = new UsersStore(ctx.db);
  service = new IbApplicationsService(
    ctx.db,
    store,
    users,
    new IbLevelsService(ctx.db, auditStubAs()),
    new ClientVisibilityService(users),
    { sendPartnerDecisionEmail: () => Promise.resolve() } as unknown as EmailService,
    auditStubAs(),
    notificationsStubAs(),
    new ProductsStore(ctx.db),
    new WalletProvisioningService(
      new WalletService(ctx.db),
      new CurrenciesService(ctx.db, auditStubAs()),
      new WalletsStore(ctx.db),
    ),
  );

  await ctx.db.execute(sql`
    INSERT INTO currencies (code, name, symbol) VALUES ('EUR', 'Euro', '€')
    ON CONFLICT (code) DO NOTHING
  `);

  deskA = await makeTag('directory-desk-a', 'Desk A');
  deskB = await makeTag('directory-desk-b', 'Desk B');

  Object.assign(top, await makeUser('amira.top@directory.test', 'Amira', 'Topline', deskA));
  Object.assign(child, await makeUser('basil.branch@directory.test', 'Basil', 'Branch', deskB));
  Object.assign(dormant, await makeUser('celia.dormant@directory.test', 'Celia', 'Dormant', deskA));
  // A client who is NOT a partner, on desk A — the list must not count them.
  await makeUser('dora.plain@directory.test', 'Dora', 'Plain', deskA);

  await store.createAccount({ userId: top.id, level: 1, referralCode: 'DIRTOP01' });
  await store.createAccount({
    userId: child.id,
    level: 2,
    parentIbUserId: top.id,
    referralCode: 'DIRCHLD2',
  });
  await store.createAccount({ userId: dormant.id, level: 1, referralCode: 'DIRSUSP3' });
  await store.updateAccount(dormant.id, { active: false });

  /*
   * `top` earns in TWO currencies, plus two rows that must never count:
   * a LEGACY rebate paid to the client (the client's money, pre-0209) and a
   * reversed accrual (clawed back). Since 0209 a rebate is partner money, so
   * the partner's own 7 USD rebate DOES count, next to their commission.
   */
  await accrue('USD', '100.00000000', 'confirmed');
  await accrue('USD', '5.00000000', 'pending');
  await accrue('EUR', '90.00000000', 'confirmed');
  await accrue('USD', '70.00000000', 'confirmed', 'rebate', child.id, true);
  await accrue('USD', '7.00000000', 'confirmed', 'rebate');
  await accrue('EUR', '30.00000000', 'reversed');
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

const list = (filter: Parameters<IbApplicationsService['listPartners']>[0], scope: ClientScope) =>
  service.listPartners({ limit: 100, ...filter }, scope);

const portalIds = (page: Awaited<ReturnType<typeof list>>) =>
  page.rows.map((row) => row.user.portalId).sort();

describe('the directory and the client list agree on who is a partner', () => {
  /*
   * THE REASON THIS PAGE WAS ONCE DELETED. Asserted through a territory too:
   * both sides are scoped, and two scopes applied differently would be the same
   * disagreement arriving by a second door.
   */
  it.each([
    ['an unrestricted reader', UNRESTRICTED],
    ['a reader holding desk A only', 'deskA'],
  ] as const)('counts the same partners as the client list, for %s', async (_, which) => {
    const scope = which === 'deskA' ? scopeOf([deskA], false) : which;
    const directory = await list({}, scope);
    const clients = await users.findPage({
      page: 1,
      limit: 1,
      type: 'partner',
      scope,
      withTotal: true,
    });

    expect(directory.total).toBe(clients.total);
    // Non-vacuous: equal because both found the partners, not because both
    // found nothing. Desk A holds `top` and the suspended one.
    expect(directory.total).toBe(which === 'deskA' ? 2 : 3);
  });
});

describe('searching the directory', () => {
  it('finds a partner by Portal ID, name, email and referral code', async () => {
    const expected = [top.portalId];
    expect(portalIds(await list({ q: String(top.portalId) }, UNRESTRICTED))).toEqual(expected);
    expect(portalIds(await list({ q: `#${top.portalId}` }, UNRESTRICTED))).toEqual(expected);
    expect(portalIds(await list({ q: 'Amira' }, UNRESTRICTED))).toEqual(expected);
    expect(portalIds(await list({ q: 'amira.top@directory.test' }, UNRESTRICTED))).toEqual(
      expected,
    );
    // Typed the way a person reads it off a screen — the code is stored upper.
    expect(portalIds(await list({ q: 'dirtop01' }, UNRESTRICTED))).toEqual(expected);
  });

  it('counts only what it found', async () => {
    const page = await list({ q: 'DIRCHLD2' }, UNRESTRICTED);
    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
  });

  it('never reaches past the reader’s territory — not even by referral code', async () => {
    /*
     * Desk B holds the child and not their parent. A code is the one handle an
     * operator is most often given, and precisely the thing a scoped desk could
     * guess: the search must narrow what they see, never widen it.
     */
    const deskBScope = scopeOf([deskB], false);
    expect((await list({ q: 'DIRTOP01' }, deskBScope)).total).toBe(0);
    expect((await list({ q: String(top.portalId) }, deskBScope)).total).toBe(0);
    expect(portalIds(await list({ q: 'DIRCHLD2' }, deskBScope))).toEqual([child.portalId]);
  });

  it('filters by state', async () => {
    const active = await list({ active: true }, UNRESTRICTED);
    const suspended = await list({ active: false }, UNRESTRICTED);

    expect(portalIds(active)).toEqual([top.portalId, child.portalId].sort());
    expect(portalIds(suspended)).toEqual([dormant.portalId]);
    expect(suspended.rows[0].account.active).toBe(false);
  });

  it('gives the export the same answer — it reads the same query', async () => {
    // `AdminExportService.ibPartnerBatch` pages `findPartnersPage` with these
    // two filters, so the file is the list on screen.
    const { rows, total } = await store.findPartnersPage({
      page: 1,
      limit: 50,
      q: 'dirsusp3',
      active: false,
    });
    expect(total).toBe(1);
    expect(rows[0].user.portalId).toBe(dormant.portalId);
  });
});

describe('the parent is named, never identified', () => {
  it('names an in-territory parent by Portal ID', async () => {
    const [row] = (await list({ q: 'DIRCHLD2' }, UNRESTRICTED)).rows;
    expect(row.parentPortalId).toBe(top.portalId);
    expect(row.parentOutsideTerritory).toBe(false);
  });

  it('says a parent exists outside the territory, without saying who', async () => {
    const [row] = (await list({ q: 'DIRCHLD2' }, scopeOf([deskB], false))).rows;

    expect(row.parentPortalId).toBeNull();
    expect(row.parentOutsideTerritory).toBe(true);
    // The uuid of a partner this reader is denied is an oracle — nowhere on the
    // row, under any key.
    expect(JSON.stringify(row)).not.toContain(top.id);
    expect('parentIbUserId' in row.account).toBe(false);
  });

  it('tells "deals with the broker directly" apart from "parent hidden"', async () => {
    const [row] = (await list({ q: 'DIRTOP01' }, UNRESTRICTED)).rows;
    expect(row.parentPortalId).toBeNull();
    expect(row.parentOutsideTerritory).toBe(false);
  });
});

describe('earnings, one line per currency', () => {
  const EXPECTED = [
    { currency: 'EUR', confirmed: '90.00000000', pending: '0' },
    { currency: 'USD', confirmed: '107.00000000', pending: '5.00000000' },
  ];

  it('keeps each currency on its own line, and never adds them together', async () => {
    /*
     * The defect: grouped by partner and status alone, this returned one
     * confirmed figure of 190 — USD and EUR added — which the profile then
     * printed as the platform currency. The legacy client rebate (70 USD)
     * and the reversed accrual (30 EUR, clawed back) must not appear either.
     */
    const [row] = (await list({ q: 'DIRTOP01' }, UNRESTRICTED)).rows;
    expect(row.earnings).toEqual(EXPECTED);
  });

  it('reports the same lines on the partner’s own detail', async () => {
    const detail = await service.partnerDetailFor(top.id, UNRESTRICTED, []);
    expect(detail?.earnings).toEqual(EXPECTED);
  });

  it('reports no line at all for a partner who has earned nothing', async () => {
    // Not a zero in a currency nobody chose.
    const [row] = (await list({ q: 'DIRCHLD2' }, UNRESTRICTED)).rows;
    expect(row.earnings).toEqual([]);
  });
});

describe('the row is the declared shape, and only that', () => {
  it('carries no raw account columns beyond what the directory declares', async () => {
    const [row] = (await list({ q: 'DIRTOP01' }, UNRESTRICTED)).rows;
    expect(Object.keys(row.account).sort()).toEqual(
      ['active', 'agencyId', 'approvedAt', 'level', 'referralCode', 'userId'].sort(),
    );
    expect(Object.keys(row).sort()).toEqual(
      [
        'account',
        'agencyName',
        'earnings',
        'parentOutsideTerritory',
        'parentPortalId',
        'user',
      ].sort(),
    );
  });
});
