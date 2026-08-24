import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CatalogueService } from '../src/modules/products/catalogue.service';
import { ProductsStore } from '../src/store/products.store';
import { ValidationError } from '../src/common/errors/domain-errors';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import type { Mt5AccountsService } from '../src/modules/trading/mt5/mt5-accounts.service';
import type { Mt5GroupSyncService } from '../src/modules/trading/mt5/mt5-group-sync.service';
import { auditStub, auditStubAs, TEST_ACTOR } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The product-type rules migration 0088 introduced, asserted against a real
 * Postgres running the committed migrations.
 *
 * Three rules, each with a database or service guarantee worth pinning:
 *
 *   1. At most ONE demo product — `trading_products_single_demo_uq` at the DB,
 *      a readable refusal at the service.
 *   2. Agencies carry REAL products only — refused on write, filtered on read.
 *   3. Demo offering is GLOBAL — `offeredTo(demo)` ignores the client's agency
 *      entirely and reads the single demo product.
 */
let ctx: MoneyTestContext;
let store: ProductsStore;
let service: CatalogueService;

/** What the migration chain left in trading_products, captured BEFORE cleanup. */
let migratedDemoProducts: Array<{ name: string; enabled: boolean }>;

/**
 * The bridge, stubbed: `attachGroup` validates the group EXISTS on MT5 and
 * reads its currency back. These are the groups "the server" reports.
 */
const MT5_GROUPS = [
  { name: 'real\\Standard-USD', currency: 'USD' },
  { name: 'real\\Standard-EUR', currency: 'EUR' },
  { name: 'demo\\Standard-USD', currency: 'USD' },
  { name: 'demo\\Standard-EUR', currency: 'EUR' },
];
const mt5Stub = {
  listGroupsForClients: () => Promise.resolve(MT5_GROUPS),
} as unknown as Mt5AccountsService;
// Only `availableGroups` reads the sync mirror, and nothing here calls it.
const groupSyncStub = {} as Mt5GroupSyncService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new ProductsStore(ctx.db);
  service = new CatalogueService(store, auditStubAs(), mt5Stub, groupSyncStub);

  const { rows } = await ctx.db.execute<{ name: string; enabled: boolean }>(
    sql`SELECT name, enabled FROM trading_products WHERE type = 'demo'`,
  );
  migratedDemoProducts = rows;
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

/** The constraint that refused a statement — same shape as ib-schema-constraints. */
async function constraintViolatedBy(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    const cause: unknown = (error as { cause?: unknown }).cause ?? error;
    const name = (cause as { constraint?: string }).constraint;
    if (name) return name;
    throw new Error(`Statement failed, but not on a constraint: ${(cause as Error).message}`);
  }
  throw new Error('Expected the statement to be refused, but it succeeded.');
}

async function makeProduct(name: string, type: 'real' | 'demo' = 'real'): Promise<string> {
  const product = await service.createProduct(
    { name, description: null, enabled: true, type, sortOrder: 0 },
    TEST_ACTOR,
  );
  return product.id;
}

async function makeAgency(name: string): Promise<string> {
  const agency = await service.createAgency(
    { name, description: null, enabled: true, sortOrder: 0 },
    TEST_ACTOR,
  );
  return agency.id;
}

async function makeUser(email: string, referredBy?: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, referred_by_ib_user_id)
    VALUES (${email}, 'x', 'Test', 'Client', ${referredBy ?? null})
    RETURNING id
  `);
  return rows[0].id;
}

async function makePartner(email: string, agencyId: string): Promise<string> {
  const partnerId = await makeUser(email);
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, level, referral_code, agency_id, program_id)
    VALUES (${partnerId}, 1, ${'PC-' + email.slice(0, 20)}, ${agencyId},
            (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))
  `);
  return partnerId;
}

beforeEach(async () => {
  // Children first — agency_products restricts product deletes, ib_accounts
  // restricts agency deletes, users restrict through referral attribution.
  await ctx.db.execute(sql`DELETE FROM agency_products`);
  await ctx.db.execute(sql`DELETE FROM trading_product_groups`);
  // Referral attribution points at ib_accounts, so it is cleared first.
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM agencies`);
  await ctx.db.execute(sql`DELETE FROM users`);
  await ctx.db.execute(sql`DELETE FROM trading_products`);
});

describe('migration 0088', () => {
  it('establishes exactly one enabled demo product on a fresh database', () => {
    expect(migratedDemoProducts).toHaveLength(1);
    expect(migratedDemoProducts[0].enabled).toBe(true);
    expect(migratedDemoProducts[0].name).toBe('Demo');
  });
});

describe('at most one demo product', () => {
  it('is refused by the DATABASE — the guarantee a race cannot slip past', async () => {
    await makeProduct('Demo A', 'demo');

    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`INSERT INTO trading_products (name, type) VALUES ('Demo B', 'demo')`),
      ),
    ).toBe('trading_products_single_demo_uq');
  });

  it('is refused by the service with a sentence naming the existing one', async () => {
    await makeProduct('Demo A', 'demo');

    await expect(makeProduct('Demo B', 'demo')).rejects.toThrow(ValidationError);
    await expect(makeProduct('Demo B', 'demo')).rejects.toThrow(/Demo A/);
  });

  it('a real product beside the demo one is fine', async () => {
    await makeProduct('Demo A', 'demo');
    await expect(makeProduct('Standard')).resolves.toBeDefined();
  });
});

describe('the type is fixed at creation', () => {
  it('refuses an update that flips it, in either direction', async () => {
    const realId = await makeProduct('Standard');
    const demoId = await makeProduct('Demo A', 'demo');

    const base = { description: null, enabled: true, sortOrder: 0 };
    await expect(
      service.updateProduct(realId, { ...base, name: 'Standard', type: 'demo' }, TEST_ACTOR),
    ).rejects.toThrow(ValidationError);
    await expect(
      service.updateProduct(demoId, { ...base, name: 'Demo A', type: 'real' }, TEST_ACTOR),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts an update that omits the type, or repeats the stored one', async () => {
    const id = await makeProduct('Standard');
    const base = { name: 'Standard Plus', description: null, enabled: true, sortOrder: 1 };

    await expect(service.updateProduct(id, base, TEST_ACTOR)).resolves.toMatchObject({
      name: 'Standard Plus',
      type: 'real',
    });
    await expect(
      service.updateProduct(id, { ...base, type: 'real' }, TEST_ACTOR),
    ).resolves.toBeDefined();
  });
});

describe('groups must match the product type', () => {
  it('refuses a demo group on a real product, and a live group on the demo product', async () => {
    const realId = await makeProduct('Standard');
    const demoId = await makeProduct('Demo A', 'demo');

    await expect(
      service.attachGroup(
        realId,
        { environment: 'demo', mt5Group: 'demo\\Standard-USD' },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/demo product/);
    await expect(
      service.attachGroup(
        demoId,
        { environment: 'live', mt5Group: 'real\\Standard-USD' },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/demo groups only/);
  });

  it('accepts the matching pairs', async () => {
    const realId = await makeProduct('Standard');
    const demoId = await makeProduct('Demo A', 'demo');

    const real = await service.attachGroup(
      realId,
      { environment: 'live', mt5Group: 'real\\Standard-USD' },
      TEST_ACTOR,
    );
    expect(real.groups).toHaveLength(1);

    const demo = await service.attachGroup(
      demoId,
      { environment: 'demo', mt5Group: 'demo\\Standard-USD' },
      TEST_ACTOR,
    );
    expect(demo.groups).toHaveLength(1);
  });
});

describe('agencies carry real products only', () => {
  it('refuses assigning the demo product', async () => {
    const agencyId = await makeAgency('Gold');
    const realId = await makeProduct('Standard');
    const demoId = await makeProduct('Demo A', 'demo');

    await expect(service.setAgencyProducts(agencyId, [realId, demoId], TEST_ACTOR)).rejects.toThrow(
      /real products only/,
    );
    // Nothing was written — the refusal happened before the store.
    expect(await store.productIdsOf(agencyId)).toEqual([]);
  });

  it('hides a demo link that arrived by hand from every agency read', async () => {
    const agencyId = await makeAgency('Gold');
    const realId = await makeProduct('Standard');
    const demoId = await makeProduct('Demo A', 'demo');
    await service.setAgencyProducts(agencyId, [realId], TEST_ACTOR);
    await ctx.db.execute(sql`
      INSERT INTO agency_products (agency_id, product_id) VALUES (${agencyId}, ${demoId})
    `);

    const [agency] = await store.listAgencies();
    expect(agency.productIds).toEqual([realId]);
    expect(await store.productIdsOf(agencyId)).toEqual([realId]);
  });
});

describe('offeredTo: demo is global, live is agency-scoped', () => {
  async function fixture() {
    const agencyId = await makeAgency('Gold');
    const carriedId = await makeProduct('Standard');
    const otherId = await makeProduct('ECN');
    const demoId = await makeProduct('Demo A', 'demo');

    await service.attachGroup(
      carriedId,
      { environment: 'live', mt5Group: 'real\\Standard-USD' },
      TEST_ACTOR,
    );
    await service.attachGroup(
      otherId,
      { environment: 'live', mt5Group: 'real\\Standard-EUR' },
      TEST_ACTOR,
    );
    await service.attachGroup(
      demoId,
      { environment: 'demo', mt5Group: 'demo\\Standard-USD' },
      TEST_ACTOR,
    );
    // The agency carries ONLY 'Standard' — and, pointedly, not the demo product.
    await service.setAgencyProducts(agencyId, [carriedId], TEST_ACTOR);

    const partnerId = await makePartner('partner@offered.local', agencyId);
    const referredId = await makeUser('referred@offered.local', partnerId);
    const directId = await makeUser('direct@offered.local');
    return { referredId, directId, demoId };
  }

  it('a referred client gets their agency for LIVE and the demo product for DEMO', async () => {
    const { referredId } = await fixture();

    const live = await store.offeredTo(referredId, 'live');
    expect(live.map((offer) => offer.mt5Group)).toEqual(['real\\Standard-USD']);

    const demo = await store.offeredTo(referredId, 'demo');
    expect(demo.map((offer) => offer.mt5Group)).toEqual(['demo\\Standard-USD']);
  });

  it('a direct client gets the full real catalogue for LIVE and the same demo set', async () => {
    const { directId } = await fixture();

    const live = await store.offeredTo(directId, 'live');
    expect(live.map((offer) => offer.mt5Group).sort()).toEqual([
      'real\\Standard-EUR',
      'real\\Standard-USD',
    ]);

    const demo = await store.offeredTo(directId, 'demo');
    expect(demo.map((offer) => offer.mt5Group)).toEqual(['demo\\Standard-USD']);
  });

  it('disabling the demo product closes the demo door for everybody', async () => {
    const { referredId, demoId } = await fixture();

    await ctx.db.execute(sql`UPDATE trading_products SET enabled = false WHERE id = ${demoId}`);
    expect(await store.offeredTo(referredId, 'demo')).toEqual([]);
  });
});

/**
 * ── ADM-07: a product records the spread markup it is sold on ─────────────
 *
 * On the PRODUCT because the product IS the tier — `trading_accounts.tier` is
 * inert and labelled dead on the reasoning that "a tier would be a second name
 * for the same thing".
 *
 * ⚠️ It drives NOTHING. Nothing computes from it, and it is deliberately not
 * part of `brokerRevenueOf` (commission + swap), which decides what partners
 * are paid. These tests pin the recording, the arithmetic-free round trip, and
 * the two refusals — not any effect on money, because there is none.
 */
describe('a product records its spread markup', () => {
  it('defaults to zero rather than to nothing anybody has to interpret', async () => {
    // Every product carries a defined value, so no reader has to invent a
    // meaning for NULL. Zero is honest: it is what the system knew before the
    // column existed, and a raw-spread product genuinely carries no markup.
    const id = await makeProduct('Markup default');
    const [product] = (await service.listProducts()).filter((p) => p.id === id);

    expect(product.spreadMarkupPerLot).toBe('0.00000000');
  });

  it('keeps every decimal place the operator typed', async () => {
    /*
     * THE ONE THAT MATTERS. It is NUMERIC(28,8) and it is money, so it travels
     * as a decimal string end to end. A JSON number would round-trip through a
     * float and 1.5 comes back as something that looks right in a table and is
     * not the number anybody agreed to.
     */
    const created = await service.createProduct(
      {
        name: 'Markup precise',
        description: null,
        enabled: true,
        spreadMarkupPerLot: '7.12345678',
        sortOrder: 0,
      },
      TEST_ACTOR,
    );

    expect(created.spreadMarkupPerLot).toBe('7.12345678');
    expect(typeof created.spreadMarkupPerLot).toBe('string');

    const [read] = (await service.listProducts()).filter((p) => p.id === created.id);
    expect(read.spreadMarkupPerLot).toBe('7.12345678');
  });

  it('leaves a negotiated markup alone when an update omits it', async () => {
    /*
     * This endpoint is a PUT, so a caller that predates the field — the admin
     * screen as it stands today — would otherwise reset a markup to zero every
     * time somebody renamed a product, and the audit row would faithfully
     * record a change nobody made.
     */
    const created = await service.createProduct(
      {
        name: 'Markup preserved',
        description: null,
        enabled: true,
        spreadMarkupPerLot: '2.50000000',
        sortOrder: 0,
      },
      TEST_ACTOR,
    );

    const updated = await service.updateProduct(
      created.id,
      { name: 'Markup preserved (renamed)', description: null, enabled: true, sortOrder: 0 },
      TEST_ACTOR,
    );

    expect(updated.name).toBe('Markup preserved (renamed)');
    expect(updated.spreadMarkupPerLot).toBe('2.50000000');
  });

  it('changes it when an update actually says so', async () => {
    const created = await service.createProduct(
      {
        name: 'Markup changed',
        description: null,
        enabled: true,
        spreadMarkupPerLot: '1.00000000',
        sortOrder: 0,
      },
      TEST_ACTOR,
    );

    const updated = await service.updateProduct(
      created.id,
      {
        name: 'Markup changed',
        description: null,
        enabled: true,
        spreadMarkupPerLot: '3.25000000',
        sortOrder: 0,
      },
      TEST_ACTOR,
    );

    expect(updated.spreadMarkupPerLot).toBe('3.25000000');
  });

  it('records BOTH sides of a markup change in the audit trail', async () => {
    /*
     * The same reason `ib.program_change` names the old programme and the new
     * one: nothing is paid from this number today, but WHO set it and WHEN is
     * the part that cannot be reconstructed afterwards from the row itself.
     *
     * A dedicated stub rather than the shared one, so this reads only the calls
     * this test caused.
     */
    const audit = auditStub();
    const scoped = new CatalogueService(
      store,
      audit as unknown as AdminAuditService,
      mt5Stub,
      groupSyncStub,
    );

    const created = await scoped.createProduct(
      {
        name: 'Markup audited',
        description: null,
        enabled: true,
        spreadMarkupPerLot: '1.00000000',
        sortOrder: 0,
      },
      TEST_ACTOR,
    );

    await scoped.updateProduct(
      created.id,
      {
        name: 'Markup audited',
        description: null,
        enabled: true,
        spreadMarkupPerLot: '4.75000000',
        sortOrder: 0,
      },
      TEST_ACTOR,
    );

    const update = audit.record.mock.calls.find((call) => call[1] === 'product.update');
    expect(update, 'no product.update audit row was written').toBeDefined();

    const changed = (
      update![4] as { changed?: Record<string, { before: unknown; after: unknown }> }
    ).changed;
    expect(changed?.spreadMarkupPerLot).toEqual({
      before: '1.00000000',
      after: '4.75000000',
    });
  });

  it('refuses a negative markup in the DATABASE, not only in a DTO', async () => {
    /*
     * A markup is what the broker ADDS. A negative one describes paying clients
     * to trade, which this system does not sell and is far likelier to be a
     * sign error — and the guarantee belongs in the column, because the DTO
     * only guards the one path that happens to go through it.
     */
    const id = await makeProduct('Markup negative');

    expect(
      await constraintViolatedBy(
        ctx.db.execute(
          sql`UPDATE trading_products SET spread_markup_per_lot = -1 WHERE id = ${id}`,
        ),
      ),
    ).toBe('trading_products_spread_markup_ck');
  });

  it('refuses a markup far past any real one, because that is a typo', async () => {
    // The bound is a typo guard rather than a commercial limit: 10,000 per lot
    // is orders of magnitude past any real markup, and well short of the
    // mistake that turns 1.5 into 150000.
    const id = await makeProduct('Markup absurd');

    expect(
      await constraintViolatedBy(
        ctx.db.execute(
          sql`UPDATE trading_products SET spread_markup_per_lot = 150000 WHERE id = ${id}`,
        ),
      ),
    ).toBe('trading_products_spread_markup_ck');
  });
});
