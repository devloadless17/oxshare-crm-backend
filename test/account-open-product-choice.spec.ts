import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { tradingAccounts, tradingProductGroups } from '../src/database/schema';
import {
  PRODUCT_BY_GROUP,
  PRODUCT_BY_ID,
  PRODUCT_GROUP_JOIN_ON,
  PRODUCT_NAME,
} from '../src/common/account-product';
import { Mt5AccountsService } from '../src/modules/trading/mt5/mt5-accounts.service';
import type { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import type { Mt5AccountSyncService } from '../src/modules/trading/mt5/mt5-account-sync.service';
import type { EmailService } from '../src/modules/email/email.service';
import type { AuthenticatedAdmin } from '../src/modules/admin/guards/admin.guard';
import { ProductsStore } from '../src/store/products.store';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import { EMPTY_MASK } from '../src/common/security/field-mask';
import { AccountNameTakenError, ValidationError } from '../src/common/errors/domain-errors';
import { auditStubAs } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Which product an account is opened under, now that a group may back SEVERAL
 * products (0142).
 *
 * The product decides the account's commission type, so it has to be the one
 * somebody chose. These pin the admin open path's three answers — and that an
 * ambiguous group is refused BEFORE the bridge is called, while nothing exists
 * on MT5 that the CRM would then fail to record.
 */
let ctx: MoneyTestContext;
let accounts: Mt5AccountsService;
let createOnMt5: ReturnType<typeof vi.fn>;
let clientId: number;
let standardId: string;
let premiumId: string;
let ecnId: string;
let nextLogin = 910_000;

const ADMIN = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'open-account-admin@oxshare.internal',
  permissions: ['trading.create'],
  clientScope: UNRESTRICTED,
  fieldMask: EMPTY_MASK,
} as unknown as AuthenticatedAdmin;

async function product(name: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_products (name, enabled, type) VALUES (${name}, true, 'real') RETURNING id
  `);
  return rows[0].id;
}

/** Attach a group; `minutesAgo` pins the attachment order the fallback reads. */
async function sell(productId: string, mt5Group: string, minutesAgo: number): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO trading_product_groups (product_id, environment, mt5_group, currency, created_at)
    VALUES (${productId}, 'live', ${mt5Group}, 'USD', now() - make_interval(mins => ${minutesAgo}))
  `);
}

async function recordedProduct(accountId: string): Promise<string | null> {
  const { rows } = await ctx.db.execute<{ product_id: string | null }>(
    sql`SELECT product_id FROM trading_accounts WHERE id = ${accountId}`,
  );
  return rows[0].product_id;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES ('open-choice@oxshare-e2e.test', 'x', 'Open', 'Choice')
    RETURNING id
  `);
  clientId = rows[0].id;

  standardId = await product('Choice Standard');
  premiumId = await product('Choice Premium');
  ecnId = await product('Choice ECN');
  // The shared group: two products sell it (0142).
  // Standard attached first, so it is the OLDEST attachment of the shared group.
  await sell(standardId, 'real\\Shared', 10);
  await sell(premiumId, 'real\\Shared', 5);
  // A group only one product sells.
  await sell(ecnId, 'real\\ECN', 5);

  createOnMt5 = vi.fn((input: { group: string; leverage?: number }) => {
    nextLogin += 1;
    return Promise.resolve({
      login: nextLogin,
      group: input.group,
      leverage: input.leverage ?? 100,
      currency: 'USD',
      masterPassword: 'Master!1',
      investorPassword: 'Investor!1',
    });
  });

  accounts = new Mt5AccountsService(
    ctx.db,
    { isConfigured: true, createAccount: createOnMt5 } as unknown as Mt5BridgeClient,
    auditStubAs(),
    {
      sendTradingAccountOpenedEmail: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmailService,
    new AppSettingsStore(ctx.db),
    new ProductsStore(ctx.db),
    {} as Mt5AccountSyncService,
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(() => {
  createOnMt5.mockClear();
});

describe('opening an account from the console', () => {
  it('records the only product when one product sells the group', async () => {
    const row = await accounts.createAccount(
      { userId: clientId, group: 'real\\ECN', environment: 'live' },
      ADMIN,
    );

    expect(await recordedProduct(row.id)).toBe(ecnId);
  });

  /*
   * THE case 0142 introduces. Two products sell the group, the product decides
   * the commission type, and guessing would record terms nobody chose — so the
   * request is refused, and refused before MT5 is asked to open anything.
   */
  it('refuses a group sold by several products until one is chosen — before MT5', async () => {
    await expect(
      accounts.createAccount(
        { userId: clientId, group: 'real\\Shared', environment: 'live' },
        ADMIN,
      ),
    ).rejects.toThrow(/Choice Premium, Choice Standard|Choice Standard, Choice Premium/);

    expect(createOnMt5).not.toHaveBeenCalled();
  });

  it('records the product the operator chose', async () => {
    const row = await accounts.createAccount(
      { userId: clientId, group: 'real\\Shared', productId: premiumId, environment: 'live' },
      ADMIN,
    );

    expect(await recordedProduct(row.id)).toBe(premiumId);
  });

  it('refuses a chosen product that does not sell the group', async () => {
    await expect(
      accounts.createAccount(
        { userId: clientId, group: 'real\\Shared', productId: ecnId, environment: 'live' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(createOnMt5).not.toHaveBeenCalled();
  });

  it('matches the group case-insensitively, as MT5 does', async () => {
    const row = await accounts.createAccount(
      { userId: clientId, group: 'REAL\\shared', productId: standardId, environment: 'live' },
      ADMIN,
    );

    expect(await recordedProduct(row.id)).toBe(standardId);
  });
});

describe('the product fallback for accounts that recorded none', () => {
  /*
   * Legacy accounts (no `product_id`) fall back to matching their group. With
   * two products selling it, a plain join would list the account twice — once
   * per product. The fallback takes the OLDEST attachment, so it is listed once.
   */
  it('lists an unrecorded account once, under the oldest product selling its group', async () => {
    const { rows: inserted } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO trading_accounts (user_id, login, currency, mt5_group)
      VALUES (${clientId}, '999001', 'USD', ${'real\\Shared'})
      RETURNING id
    `);
    const accountId = inserted[0].id;

    // The REAL join the account lists use — `common/account-product.ts`.
    const rows = await ctx.db
      .select({ id: tradingAccounts.id, product: PRODUCT_NAME })
      .from(tradingAccounts)
      .leftJoin(PRODUCT_BY_ID, eq(PRODUCT_BY_ID.id, tradingAccounts.productId))
      .leftJoin(tradingProductGroups, PRODUCT_GROUP_JOIN_ON)
      .leftJoin(PRODUCT_BY_GROUP, eq(PRODUCT_BY_GROUP.id, tradingProductGroups.productId))
      .where(eq(tradingAccounts.id, accountId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.product).toBe('Choice Standard');
  });
});

/*
 * The account NAME a client gives on the portal's open form — restored after
 * its removal (backend e6fce0f), at the owner's request (25 Sep 2026).
 *
 * The name is what MT5 records as the account holder and what the portal
 * labels the account with. A client who leaves it blank gets their own name on
 * MT5 and NULL locally. A client may not use one name twice, and that refusal
 * has to come BEFORE MT5 opens anything: the trading server has no rollback.
 */
describe('the name a client gives an account they open', () => {
  let holderId: number;

  beforeAll(async () => {
    const { rows } = await ctx.db.execute<{ id: number }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES ('open-name@oxshare-e2e.test', 'x', 'Named', 'Holder')
      RETURNING id
    `);
    holderId = rows[0].id;
  });

  async function storedName(accountId: string): Promise<string | null> {
    const { rows } = await ctx.db.execute<{ name: string | null }>(
      sql`SELECT name FROM trading_accounts WHERE id = ${accountId}`,
    );
    return rows[0].name;
  }

  it('sends the chosen name to MT5 and stores it for the portal', async () => {
    const opened = await accounts.createOwnAccount({
      userId: holderId,
      environment: 'live',
      group: 'real\\ECN',
      name: '  Swing trading  ',
    });

    expect(createOnMt5).toHaveBeenCalledWith(expect.objectContaining({ name: 'Swing trading' }));
    expect(await storedName(opened.id)).toBe('Swing trading');
  });

  it("uses the client's own name on MT5 when none is chosen, and stores none", async () => {
    const opened = await accounts.createOwnAccount({
      userId: holderId,
      environment: 'live',
      group: 'real\\ECN',
    });

    expect(createOnMt5).toHaveBeenCalledWith(expect.objectContaining({ name: 'Named Holder' }));
    expect(await storedName(opened.id)).toBeNull();
  });

  it('refuses a name the client already uses, whatever its case — before MT5', async () => {
    await expect(
      accounts.createOwnAccount({
        userId: holderId,
        environment: 'live',
        group: 'real\\ECN',
        name: 'SWING TRADING',
      }),
    ).rejects.toBeInstanceOf(AccountNameTakenError);

    expect(createOnMt5).not.toHaveBeenCalled();
  });
});
