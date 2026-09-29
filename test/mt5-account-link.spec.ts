import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { tradingAccounts } from '../src/database/schema';
import { Mt5AccountsService } from '../src/modules/trading/mt5/mt5-accounts.service';
import type {
  Mt5AccountHolder,
  Mt5AccountSnapshot,
  Mt5BridgeClient,
} from '../src/modules/trading/mt5/mt5-bridge.client';
import type { Mt5AccountSyncService } from '../src/modules/trading/mt5/mt5-account-sync.service';
import type { EmailService } from '../src/modules/email/email.service';
import type { AuthenticatedAdmin } from '../src/modules/admin/guards/admin.guard';
import { ProductsStore } from '../src/store/products.store';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import { EMPTY_MASK } from '../src/common/security/field-mask';
import { ConflictError, NotFoundError, ValidationError } from '../src/common/errors/domain-errors';
import { auditStubAs } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * LINKING AN EXISTING MT5 ACCOUNT TO A CLIENT (owner, 29 Sep 2026).
 *
 * The broker's server holds accounts the CRM never recorded; their deals wait
 * in `mt5_deals` as orphans. Pinned here, against real Postgres:
 *
 *  - the lookup shows MT5's account and holder, the products that sell its
 *    group, whether the CRM already has it, and how many deals are waiting;
 *  - the link records the login under the client with MT5's own balance and a
 *    product chosen by the same rule opening an account follows — an ambiguous
 *    group is refused until one is picked;
 *  - a login the CRM already has, one MT5 does not have, a currency the
 *    platform does not hold, and a client outside the reader's territory are
 *    each refused, and nothing is written;
 *  - a product can be set, changed or cleared later, only to one selling the
 *    account's group.
 */
let ctx: MoneyTestContext;
let accounts: Mt5AccountsService;
let clientId: number;
let otherClientId: number;
let standardId: string;
let premiumId: string;
let ecnId: string;

const MT5: Record<string, Mt5AccountSnapshot> = {};
const HOLDERS: Record<string, Mt5AccountHolder> = {};

const ADMIN = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'link-admin@oxshare.internal',
  permissions: ['trading.create'],
  clientScope: UNRESTRICTED,
  fieldMask: EMPTY_MASK,
} as unknown as AuthenticatedAdmin;

/** A desk that may see NO client — every territory check answers 404. */
const NOBODYS_DESK = {
  ...ADMIN,
  clientScope: { unrestricted: false, tagIds: [], includesUntriaged: false },
} as unknown as AuthenticatedAdmin;

function onMt5(login: number, group: string, currency = 'USD', balance = '1250.00000000'): void {
  MT5[String(login)] = {
    login,
    group,
    currency,
    leverage: 200,
    balance,
    equity: balance,
    credit: '0.00000000',
    margin: '0.00000000',
    marginFree: balance,
    marginLevel: null,
  };
  HOLDERS[String(login)] = { login, name: 'Rana Existing', email: 'rana@old-platform.test', group };
}

async function product(name: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_products (name, enabled, type) VALUES (${name}, true, 'real') RETURNING id
  `);
  return rows[0].id;
}

async function sell(productId: string, mt5Group: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO trading_product_groups (product_id, environment, mt5_group, currency)
    VALUES (${productId}, 'live', ${mt5Group}, 'USD')
  `);
}

async function deal(login: number, dealId: string, processed: boolean): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO mt5_deals (mt5_deal_id, login, symbol, action, entry, volume, price, profit,
                           commission, swap, dealt_at, commission_processed_at)
    VALUES (${dealId}, ${String(login)}, 'EURUSD', 0, 1, '1', '1.1', '10', '-3', '0', now(),
            ${processed ? sql`now()` : sql`NULL`})
  `);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const person = async (email: string) => {
    const { rows } = await ctx.db.execute<{ id: number }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES (${email}, 'x', 'Rana', 'Existing') RETURNING id`);
    return rows[0].id;
  };
  clientId = await person('link-client@oxshare-e2e.test');
  otherClientId = await person('link-other@oxshare-e2e.test');

  standardId = await product('Link Standard');
  premiumId = await product('Link Premium');
  ecnId = await product('Link ECN');
  await sell(standardId, 'real\\LinkShared'); // two products sell this group
  await sell(premiumId, 'real\\LinkShared');
  await sell(ecnId, 'real\\LinkEcn'); // one product sells this one

  onMt5(7000001, 'real\\LinkShared');
  onMt5(7000002, 'real\\LinkEcn', 'USD', '42.50000000');
  onMt5(7000003, 'real\\Bespoke'); // a group no product carries
  onMt5(7000004, 'real\\LinkEcn', 'XYZ'); // a currency the platform does not hold

  // Two deals on 7000001 waiting for an owner, and one already decided.
  await deal(7000001, 'link-d1', false);
  await deal(7000001, 'link-d2', false);
  await deal(7000001, 'link-d3', true);

  const bridge = {
    isConfigured: true,
    getAccount: vi.fn((login: string) => Promise.resolve(MT5[login] ?? null)),
    getAccountHolder: vi.fn((login: string) => Promise.resolve(HOLDERS[login] ?? null)),
  } as unknown as Mt5BridgeClient;

  accounts = new Mt5AccountsService(
    ctx.db,
    bridge,
    auditStubAs(),
    {} as EmailService,
    new AppSettingsStore(ctx.db),
    new ProductsStore(ctx.db),
    {} as Mt5AccountSyncService,
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM trading_accounts WHERE login LIKE '700000%'`);
});

const rowFor = async (login: number) =>
  (
    await ctx.db
      .select()
      .from(tradingAccounts)
      .where(eq(tradingAccounts.login, String(login)))
  )[0];

describe('looking an MT5 login up', () => {
  it('shows MT5’s account and holder, its products, and the deals waiting', async () => {
    const found = await accounts.lookupMt5Account('7000001', ADMIN);
    expect(found).toMatchObject({
      login: '7000001',
      group: 'real\\LinkShared',
      currency: 'USD',
      balance: '1250.00000000',
      holderName: 'Rana Existing',
      holderEmail: 'rana@old-platform.test',
      environment: 'live',
      currencyKnown: true,
      owner: null,
      waitingDeals: 2,
    });
    expect(found.products.map((p) => p.id).sort()).toEqual([standardId, premiumId].sort());
  });

  it('withholds MT5’s holder name and email from a role that may not read them', async () => {
    const masked = {
      ...ADMIN,
      fieldMask: ['client.firstName', 'client.email'],
    } as unknown as AuthenticatedAdmin;
    const found = await accounts.lookupMt5Account('7000001', masked);
    expect(found.holderName).toBeNull();
    expect(found.holderEmail).toBeNull();
    // What identifies the ACCOUNT stays.
    expect(found.group).toBe('real\\LinkShared');
  });

  it('is a 404 for a login MT5 does not have', async () => {
    await expect(accounts.lookupMt5Account('7999999', ADMIN)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses something that is not a login', async () => {
    await expect(accounts.lookupMt5Account('abc', ADMIN)).rejects.toBeInstanceOf(ValidationError);
  });

  it('names the owner once linked — only inside the reader’s territory', async () => {
    await accounts.linkMt5Account({ userId: clientId, login: '7000002' }, ADMIN);
    expect((await accounts.lookupMt5Account('7000002', ADMIN)).owner).toEqual({
      portalId: clientId,
      name: 'Rana Existing',
      outsideTerritory: false,
    });
    expect((await accounts.lookupMt5Account('7000002', NOBODYS_DESK)).owner).toEqual({
      outsideTerritory: true,
    });
  });
});

describe('linking it to a client', () => {
  it('records the login under the client with MT5’s own balance and the one product', async () => {
    const linked = await accounts.linkMt5Account({ userId: clientId, login: '7000002' }, ADMIN);
    expect(linked).toMatchObject({ login: '7000002', productId: ecnId, environment: 'live' });

    const row = await rowFor(7000002);
    expect(row).toMatchObject({
      userId: clientId,
      mt5Group: 'real\\LinkEcn',
      productId: ecnId,
      currency: 'USD',
      leverage: 200,
      // Never zero: an existing account holds real money.
      balance: '42.50000000',
      status: 'active',
    });
    expect(row.balanceSyncedAt).not.toBeNull();
  });

  it('refuses an ambiguous group until a product is chosen — and writes nothing', async () => {
    await expect(
      accounts.linkMt5Account({ userId: clientId, login: '7000001' }, ADMIN),
    ).rejects.toThrow(/more than one product.*Link Standard|more than one product.*Link Premium/);
    expect(await rowFor(7000001)).toBeUndefined();

    const linked = await accounts.linkMt5Account(
      { userId: clientId, login: '7000001', productId: premiumId },
      ADMIN,
    );
    expect(linked.productId).toBe(premiumId);
    // The two undecided deals now have an owner and accrue on the next run.
    expect(linked.waitingDeals).toBe(2);
  });

  it('refuses a product that does not sell the group', async () => {
    await expect(
      accounts.linkMt5Account({ userId: clientId, login: '7000001', productId: ecnId }, ADMIN),
    ).rejects.toThrow(/does not sell the MT5 group/);
  });

  it('links a group no product carries with no product — to be set later', async () => {
    const linked = await accounts.linkMt5Account({ userId: clientId, login: '7000003' }, ADMIN);
    expect(linked.productId).toBeNull();
  });

  it('refuses a login the CRM already has — moving an account is not this action', async () => {
    await accounts.linkMt5Account({ userId: clientId, login: '7000002' }, ADMIN);
    await expect(
      accounts.linkMt5Account({ userId: otherClientId, login: '7000002' }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await rowFor(7000002)).userId).toBe(clientId);
  });

  it('refuses a login MT5 does not have, and a currency the platform does not hold', async () => {
    await expect(
      accounts.linkMt5Account({ userId: clientId, login: '7999999' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      accounts.linkMt5Account({ userId: clientId, login: '7000004' }, ADMIN),
    ).rejects.toThrow(/XYZ, which this platform does not hold/);
    expect(await rowFor(7000004)).toBeUndefined();
  });

  it('is a 404 for a client outside the reader’s territory — nothing written', async () => {
    await expect(
      accounts.linkMt5Account({ userId: clientId, login: '7000002' }, NOBODYS_DESK),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await rowFor(7000002)).toBeUndefined();
  });
});

describe('setting the product later', () => {
  it('sets, changes and clears it — only to a product selling the group', async () => {
    const linked = await accounts.linkMt5Account({ userId: clientId, login: '7000003' }, ADMIN);
    // real\Bespoke is sold by nobody, so no product may be set on it.
    await expect(accounts.setAccountProduct(linked.id, ecnId, ADMIN)).rejects.toThrow(
      /does not sell the MT5 group/,
    );

    const shared = await accounts.linkMt5Account(
      { userId: clientId, login: '7000001', productId: standardId },
      ADMIN,
    );
    await accounts.setAccountProduct(shared.id, premiumId, ADMIN);
    expect((await rowFor(7000001)).productId).toBe(premiumId);
    await accounts.setAccountProduct(shared.id, null, ADMIN);
    expect((await rowFor(7000001)).productId).toBeNull();
  });

  it('is a 404 for an account of a client outside the territory', async () => {
    const linked = await accounts.linkMt5Account({ userId: clientId, login: '7000002' }, ADMIN);
    await expect(accounts.setAccountProduct(linked.id, ecnId, NOBODYS_DESK)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
