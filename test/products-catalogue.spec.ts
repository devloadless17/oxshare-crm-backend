import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CatalogueService } from '../src/modules/products/catalogue.service';
import { IbCommissionTypesService } from '../src/modules/ib/ib-commission-types.service';
import { ProductsStore } from '../src/store/products.store';
import { ConflictError, NotFoundError, ValidationError } from '../src/common/errors/domain-errors';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import type { Mt5AccountsService } from '../src/modules/trading/mt5/mt5-accounts.service';
import type { Mt5GroupSyncService } from '../src/modules/trading/mt5/mt5-group-sync.service';
import { auditStub, auditStubAs, TEST_ACTOR } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { UNRESTRICTED } from '../src/common/security/client-scope';

/**
 * The product-type rules migration 0088 introduced, asserted against a real
 * Postgres running the committed migrations.
 *
 * Three rules, each with a database or service guarantee worth pinning:
 *
 *   1. ANY number of demo products (0201 dropped 0088's one-demo index), and a
 *      group's minimum deposit only on live groups (service + CHECK).
 *   2. Agencies carry REAL products only — refused on write, filtered on read.
 *   3. Demo offering is GLOBAL — `offeredTo(demo)` ignores the client's agency
 *      entirely and reads every enabled demo product.
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
  // A second USD live group, for the one-group-per-currency rule.
  { name: 'real\\Pro-USD', currency: 'USD' },
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

/** A live product is offered only once it has a commission type (6 Oct 2026). */
async function giveType(productId: string) {
  const type = await new IbCommissionTypesService(ctx.db, auditStubAs()).create(
    { name: `Terms ${productId}`, description: null, commissionPerLot: '10', rebatePerLot: '3' },
    TEST_ACTOR,
  );
  await ctx.db.execute(
    sql`UPDATE trading_products SET commission_type_id = ${type.id} WHERE id = ${productId}`,
  );
}

async function makeAgency(name: string): Promise<string> {
  const agency = await service.createAgency(
    { name, description: null, enabled: true, sortOrder: 0 },
    TEST_ACTOR,
  );
  return agency.id;
}

async function makeUser(email: string, referredBy?: number): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, referred_by_ib_user_id)
    VALUES (${email}, 'x', 'Test', 'Client', ${referredBy ?? null})
    RETURNING id
  `);
  return rows[0].id;
}

async function makePartner(email: string, agencyId: string): Promise<number> {
  const partnerId = await makeUser(email);
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, agency_id, program_id)
      VALUES (${partnerId}, ${'PC-' + email.slice(0, 20)}, ${agencyId},
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

describe('any number of demo products (0201)', () => {
  it('two demo products coexist, and every client is offered both', async () => {
    const a = await makeProduct('Demo A', 'demo');
    const b = await makeProduct('Demo B', 'demo');
    // One group may back several products (0142).
    for (const id of [a, b]) {
      await service.attachGroup(
        id,
        { environment: 'demo', mt5Group: 'demo\\Standard-USD' },
        TEST_ACTOR,
      );
    }

    const client = await makeUser('two-demos@test.local');
    const offered = await store.offeredTo(client, 'demo');
    expect(offered.map((offer) => offer.productId).sort()).toEqual([a, b].sort());
  });
});

describe("a group's minimum deposit (0201)", () => {
  it('is stored on a live group, changed in place, and cleared with null', async () => {
    const id = await makeProduct('Standard');
    const attached = await service.attachGroup(
      id,
      { environment: 'live', mt5Group: 'real\\Standard-USD', minDeposit: '100' },
      TEST_ACTOR,
    );
    const [group] = attached.groups;
    expect(group.minDeposit).toBe('100.00000000');

    const raised = await service.updateGroup(id, group.id, { minDeposit: '250.5' }, TEST_ACTOR);
    expect(raised.groups[0].minDeposit).toBe('250.50000000');

    const cleared = await service.updateGroup(id, group.id, { minDeposit: null }, TEST_ACTOR);
    expect(cleared.groups[0].minDeposit).toBeNull();
  });

  it('refuses zero', async () => {
    const id = await makeProduct('Standard');
    await expect(
      service.attachGroup(
        id,
        { environment: 'live', mt5Group: 'real\\Standard-USD', minDeposit: '0' },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/above zero/);
  });

  it('is refused on a demo group — by the service and by the CHECK', async () => {
    const demoId = await makeProduct('Demo A', 'demo');
    await expect(
      service.attachGroup(
        demoId,
        { environment: 'demo', mt5Group: 'demo\\Standard-USD', minDeposit: '10' },
        TEST_ACTOR,
      ),
    ).rejects.toThrow(/no minimum deposit/);

    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`
          INSERT INTO trading_product_groups (product_id, environment, mt5_group, currency, min_deposit)
          VALUES (${demoId}, 'demo', 'demo\\X', 'USD', 10)
        `),
      ),
    ).toBe('trading_product_groups_min_deposit_ck');
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

/*
 * ── WHAT AN ACCOUNT ACTUALLY IS, AS OPPOSED TO WHAT WAS ASKED FOR ──────────
 *
 * `trading_accounts.environment` gates whether a trade pays partner commission,
 * and it used to be written from the REQUEST while `mt5Group` and `productId`
 * beside it were read back from the broker's own response. This lookup is what
 * lets the account service verify it instead of believing it.
 *
 * The bug that forced it: a deployment whose catalogue holds a single LIVE
 * group answers every open with that group — demo requests included — so an
 * account requested as demo sat in a live group, was filed as demo, and every
 * trade on it accrued real commission and a real rebate.
 */
describe('a group knows whether it is live or demo', () => {
  it('reports the environment the catalogue sells the group as', async () => {
    const realId = await makeProduct('Standard');
    const demoId = await makeProduct('Demo A', 'demo');

    await service.attachGroup(
      realId,
      { environment: 'live', mt5Group: 'real\\Standard-USD' },
      TEST_ACTOR,
    );
    await service.attachGroup(
      demoId,
      { environment: 'demo', mt5Group: 'demo\\Standard-USD' },
      TEST_ACTOR,
    );

    expect(await store.environmentForGroup('real\\Standard-USD')).toBe('live');
    expect(await store.environmentForGroup('demo\\Standard-USD')).toBe('demo');
  });

  it('matches case-insensitively, as MT5 group paths do', async () => {
    const realId = await makeProduct('Standard');
    await service.attachGroup(
      realId,
      { environment: 'live', mt5Group: 'real\\Standard-USD' },
      TEST_ACTOR,
    );

    // A browser round trip can change the casing and nothing else.
    expect(await store.environmentForGroup('REAL\\standard-usd')).toBe('live');
  });

  it('answers NULL for a group the catalogue does not sell', async () => {
    /*
     * The admin path can open an account directly into a bespoke or internal
     * group. There is nothing to verify against, so this refuses to guess — the
     * caller falls back to the requested value and logs that it did.
     */
    expect(await store.environmentForGroup('test\\API\\0-cl')).toBeNull();
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

describe('offeredTo: who sees which live products (owner, 6 Oct 2026)', () => {
  /*
   * Gold (the main partner's agency) sells Standard; Silver sells ECN; Raw has
   * NO commission type. The sub-partner's own row says Silver on purpose — the
   * MAIN partner's agency must win for everybody under him.
   */
  async function fixture() {
    const gold = await makeAgency('Gold');
    const silver = await makeAgency('Silver');
    const standard = await makeProduct('Standard');
    const ecn = await makeProduct('ECN');
    const raw = await makeProduct('Raw');
    const demoId = await makeProduct('Demo A', 'demo');
    await giveType(standard);
    await giveType(ecn);
    for (const [id, env, group] of [
      [standard, 'live', 'real\\Standard-USD'],
      [ecn, 'live', 'real\\ECN-USD'],
      [raw, 'live', 'real\\Raw-USD'],
      [demoId, 'demo', 'demo\\Standard-USD'],
    ] as const) {
      await service.attachGroup(id, { environment: env, mt5Group: group }, TEST_ACTOR);
    }
    await service.setAgencyProducts(gold, [standard], TEST_ACTOR);
    await service.setAgencyProducts(silver, [ecn], TEST_ACTOR);

    const main = await makePartner('main@offered.local', gold);
    const sub = await makePartner('sub@offered.local', silver);
    await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = ${main} WHERE id = ${sub}`);
    await ctx.db.execute(
      sql`UPDATE ib_accounts SET parent_ib_user_id = ${main}, level = 2 WHERE user_id = ${sub}`,
    );
    return {
      main,
      sub,
      underMain: await makeUser('under-main@offered.local', main),
      underSub: await makeUser('under-sub@offered.local', sub),
      direct: await makeUser('direct@offered.local'),
      demoId,
    };
  }

  const groups = async (userId: number, env: 'live' | 'demo' = 'live') =>
    (await store.offeredTo(userId, env)).map((o) => o.mt5Group).sort();

  it('an individual sees only live products with NO commission type', async () => {
    const { direct } = await fixture();
    expect(await groups(direct)).toEqual(['real\\Raw-USD']);
  });

  it('a main partner opening his own account sees only products with no commission type', async () => {
    const { main } = await fixture();
    expect(await groups(main)).toEqual(['real\\Raw-USD']);
  });

  it('a sub-partner opening his own account sees his MAIN partner’s agency', async () => {
    const { sub } = await fixture();
    expect(await groups(sub)).toEqual(['real\\Standard-USD']);
  });

  it('a client under the main partner sees the main partner’s agency', async () => {
    const { underMain } = await fixture();
    expect(await groups(underMain)).toEqual(['real\\Standard-USD']);
  });

  it('a client under a sub-partner sees the MAIN partner’s agency, not the sub-partner’s', async () => {
    const { underSub } = await fixture();
    expect(await groups(underSub)).toEqual(['real\\Standard-USD']);
  });

  it('inside a tree, an agency product with no commission type is not offered', async () => {
    const { underMain } = await fixture();
    const [gold] = (await store.listAgencies()).filter((a) => a.name === 'Gold');
    const raw = (await service.listProducts()).find((p) => p.name === 'Raw')!.id;
    const standard = (await service.listProducts()).find((p) => p.name === 'Standard')!.id;
    await service.setAgencyProducts(gold.id, [standard, raw], TEST_ACTOR);
    expect(await groups(underMain)).toEqual(['real\\Standard-USD']);
  });

  it('inside a tree whose main partner has no agency: every product with a type', async () => {
    const { underMain, main } = await fixture();
    await ctx.db.execute(sql`UPDATE ib_accounts SET agency_id = NULL WHERE user_id = ${main}`);
    expect(await groups(underMain)).toEqual(['real\\ECN-USD', 'real\\Standard-USD']);
  });

  it('demo is the same for everybody, and disabling it closes it for everybody', async () => {
    const f = await fixture();
    for (const id of [f.direct, f.main, f.sub, f.underMain, f.underSub]) {
      expect(await groups(id, 'demo')).toEqual(['demo\\Standard-USD']);
    }
    await ctx.db.execute(sql`UPDATE trading_products SET enabled = false WHERE id = ${f.demoId}`);
    expect(await groups(f.underSub, 'demo')).toEqual([]);
  });
});

/**
 * ── A product is sold on a COMMISSION TYPE (0140) ──────────────────────────
 *
 * The rate card lives on `ib_commission_types`; the product only points at
 * one. These pin the pointer's round trip and its three refusals — an unknown
 * type, a type on the demo product, and deleting or disabling a type a product
 * is still sold on — not the arithmetic, which is `commission.spec.ts`'s.
 */
describe('a product is sold on a commission type', () => {
  let types: IbCommissionTypesService;

  beforeAll(() => {
    types = new IbCommissionTypesService(ctx.db, auditStubAs());
  });

  async function makeType(name: string): Promise<string> {
    const type = await types.create(
      { name, description: null, commissionPerLot: '10', rebatePerLot: '3' },
      TEST_ACTOR,
    );
    return type.id;
  }

  it('carries no type until one is assigned, and says so with null', async () => {
    const id = await makeProduct('Untyped product');
    const [product] = (await service.listProducts()).filter((p) => p.id === id);

    expect(product.commissionTypeId).toBeNull();
  });

  it('is put on a type, and an update that omits the field keeps it', async () => {
    const typeId = await makeType('Typed terms');
    const created = await service.createProduct(
      { name: 'Typed product', description: null, enabled: true, commissionTypeId: typeId },
      TEST_ACTOR,
    );
    expect(created.commissionTypeId).toBe(typeId);

    /* A PUT from a client that predates the field must not strip the terms. */
    const renamed = await service.updateProduct(
      created.id,
      { name: 'Typed product (renamed)', description: null, enabled: true },
      TEST_ACTOR,
    );
    expect(renamed.commissionTypeId).toBe(typeId);

    /* An explicit null is the way to say "this product pays nobody". */
    const cleared = await service.updateProduct(
      created.id,
      { name: 'Typed product (renamed)', description: null, enabled: true, commissionTypeId: null },
      TEST_ACTOR,
    );
    expect(cleared.commissionTypeId).toBeNull();
  });

  it('lists the products sold on a type beside it', async () => {
    const typeId = await makeType('Listed terms');
    await service.createProduct(
      { name: 'Listed product', description: null, enabled: true, commissionTypeId: typeId },
      TEST_ACTOR,
    );

    const type = (await types.listAll()).find((row) => row.id === typeId);
    expect(type?.productNames).toEqual(['Listed product']);
  });

  it('refuses a type that does not exist rather than letting the key answer', async () => {
    await expect(
      service.createProduct(
        {
          name: 'Ghost-typed product',
          description: null,
          enabled: true,
          commissionTypeId: '00000000-0000-4000-8000-000000000000',
        },
        TEST_ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a type on the demo product, which never accrues', async () => {
    const typeId = await makeType('Demo-refused terms');
    const demo = (await service.listProducts()).find((p) => p.type === 'demo');
    const demoId = demo?.id ?? (await makeProduct('Demo for types', 'demo'));

    await expect(
      service.updateProduct(
        demoId,
        {
          name: demo?.name ?? 'Demo for types',
          description: null,
          enabled: true,
          commissionTypeId: typeId,
        },
        TEST_ACTOR,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses to delete or disable a type a product is still sold on', async () => {
    const typeId = await makeType('Held terms');
    await service.createProduct(
      { name: 'Held product', description: null, enabled: true, commissionTypeId: typeId },
      TEST_ACTOR,
    );

    await expect(types.remove(typeId, TEST_ACTOR, UNRESTRICTED)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(types.update(typeId, { enabled: false }, TEST_ACTOR)).rejects.toBeInstanceOf(
      ConflictError,
    );
    /* A rename is not a disable, and goes through. */
    const renamed = await types.update(typeId, { name: 'Held terms (renamed)' }, TEST_ACTOR);
    expect(renamed.name).toBe('Held terms (renamed)');
  });

  it('records the type change in the audit diff, by id', async () => {
    const typeId = await makeType('Audited terms');
    const audit = auditStub();
    const scoped = new CatalogueService(
      store,
      audit as unknown as AdminAuditService,
      mt5Stub,
      groupSyncStub,
    );

    const created = await scoped.createProduct(
      { name: 'Type audited', description: null, enabled: true, sortOrder: 0 },
      TEST_ACTOR,
    );
    await scoped.updateProduct(
      created.id,
      { name: 'Type audited', description: null, enabled: true, commissionTypeId: typeId },
      TEST_ACTOR,
    );

    /* The one edit that changes what every partner is paid on this product. */
    const update = audit.record.mock.calls.find((call) => call[1] === 'product.update');
    expect(update, 'no product.update audit row was written').toBeDefined();
    const changed = (
      update![4] as { changed?: Record<string, { before: unknown; after: unknown }> }
    ).changed;
    expect(changed?.commissionTypeId).toEqual({ before: null, after: typeId });
  });

  it('keeps every decimal place of the amounts, as strings', async () => {
    const type = await types.create(
      { name: 'Precise terms', commissionPerLot: '7.12345678', rebatePerLot: '0.5' },
      TEST_ACTOR,
    );
    expect(type.commissionPerLot).toBe('7.12345678');
    expect(type.rebatePerLot).toBe('0.50000000');
    expect(typeof type.commissionPerLot).toBe('string');
  });

  it('refuses an amount far past any real rate card, because that is a typo', async () => {
    const typeId = await makeType('Absurd terms');
    expect(
      await constraintViolatedBy(
        ctx.db.execute(
          sql`UPDATE ib_commission_types SET commission_per_lot = 150000 WHERE id = ${typeId}`,
        ),
      ),
    ).toBe('ib_commission_types_commission_range');
  });
});

/*
 * ATTACHING AND DETACHING GROUPS — every answer the Products form can get.
 *
 * On 26 Sep 2026 an operator attaching a group got a bare 409 "That record
 * already exists." from the database. Each case here goes through the service
 * against the real constraints, and every refusal must be a ValidationError
 * with a reason — never a database error — and must leave the rows untouched.
 */
describe('attaching and detaching MT5 groups', () => {
  async function rows(productId: string) {
    const { rows: found } = await ctx.db.execute<{ mt5_group: string; currency: string }>(sql`
      SELECT mt5_group, currency FROM trading_product_groups
       WHERE product_id = ${productId} ORDER BY mt5_group
    `);
    return found.map((row) => `${row.mt5_group} ${row.currency}`);
  }

  const live = (mt5Group: string) => ({ environment: 'live' as const, mt5Group });

  it('attaches a group, with the currency MT5 reports and the server’s spelling', async () => {
    const standard = await makeProduct('Attach Standard');

    const product = await service.attachGroup(standard, live('REAL\\standard-usd'), TEST_ACTOR);

    expect(product.groups.map((group) => group.mt5Group)).toEqual(['real\\Standard-USD']);
    expect(await rows(standard)).toEqual(['real\\Standard-USD USD']);
  });

  it('lets the same group back a second product (0142)', async () => {
    const standard = await makeProduct('Shared Standard');
    const premium = await makeProduct('Shared Premium');

    await service.attachGroup(standard, live('real\\Standard-USD'), TEST_ACTOR);
    await service.attachGroup(premium, live('real\\Standard-USD'), TEST_ACTOR);

    expect(await rows(standard)).toEqual(['real\\Standard-USD USD']);
    expect(await rows(premium)).toEqual(['real\\Standard-USD USD']);
  });

  it('refuses the same group twice on one product, whatever its casing', async () => {
    const standard = await makeProduct('Twice Standard');
    await service.attachGroup(standard, live('real\\Standard-USD'), TEST_ACTOR);

    await expect(
      service.attachGroup(standard, live('Real\\STANDARD-usd'), TEST_ACTOR),
    ).rejects.toThrow(/already attached to 'Twice Standard'/);
    expect(await rows(standard)).toEqual(['real\\Standard-USD USD']);
  });

  /* The 409 the operator hit, now a reason they can act on. */
  it('refuses a second group in the same currency, naming the one already there', async () => {
    const standard = await makeProduct('Slot Standard');
    await service.attachGroup(standard, live('real\\Standard-USD'), TEST_ACTOR);

    const attempt = service.attachGroup(standard, live('real\\Pro-USD'), TEST_ACTOR);

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(service.attachGroup(standard, live('real\\Pro-USD'), TEST_ACTOR)).rejects.toThrow(
      /already has a live USD group, "real\\Standard-USD"/,
    );
    expect(await rows(standard)).toEqual(['real\\Standard-USD USD']);
  });

  it('takes a group in another currency beside it', async () => {
    const standard = await makeProduct('Two Currencies');
    await service.attachGroup(standard, live('real\\Standard-USD'), TEST_ACTOR);
    await service.attachGroup(standard, live('real\\Standard-EUR'), TEST_ACTOR);

    expect(await rows(standard)).toEqual(['real\\Standard-EUR EUR', 'real\\Standard-USD USD']);
  });

  /* The Products form's own order on save: detach first, then attach. */
  it('swaps one USD group for another when the old one is detached first', async () => {
    const standard = await makeProduct('Swap Standard');
    const withOld = await service.attachGroup(standard, live('real\\Standard-USD'), TEST_ACTOR);
    const oldId = withOld.groups[0]?.id ?? '';

    await service.detachGroup(standard, oldId, TEST_ACTOR);
    await service.attachGroup(standard, live('real\\Pro-USD'), TEST_ACTOR);

    expect(await rows(standard)).toEqual(['real\\Pro-USD USD']);
  });

  it('refuses a group MT5 does not report, and an unknown product', async () => {
    const standard = await makeProduct('Unknown Group');

    await expect(service.attachGroup(standard, live('real\\Nowhere'), TEST_ACTOR)).rejects.toThrow(
      /MT5 does not report a group called "real\\Nowhere"/,
    );
    await expect(
      service.attachGroup(
        '00000000-0000-4000-8000-000000000000',
        live('real\\Standard-USD'),
        TEST_ACTOR,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows(standard)).toEqual([]);
  });

  it('detaches a group from one product and leaves it on the other', async () => {
    const standard = await makeProduct('Detach Standard');
    const premium = await makeProduct('Detach Premium');
    const onStandard = await service.attachGroup(standard, live('real\\Standard-USD'), TEST_ACTOR);
    await service.attachGroup(premium, live('real\\Standard-USD'), TEST_ACTOR);

    await service.detachGroup(standard, onStandard.groups[0]?.id ?? '', TEST_ACTOR);

    expect(await rows(standard)).toEqual([]);
    expect(await rows(premium)).toEqual(['real\\Standard-USD USD']);
  });

  it('refuses to detach a group that is not on the product', async () => {
    const standard = await makeProduct('Detach Missing');
    const premium = await makeProduct('Detach Other');
    const onPremium = await service.attachGroup(premium, live('real\\Standard-USD'), TEST_ACTOR);

    await expect(
      service.detachGroup(standard, onPremium.groups[0]?.id ?? '', TEST_ACTOR),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await rows(premium)).toEqual(['real\\Standard-USD USD']);
  });

  it('records who attached and detached what', async () => {
    const audit = auditStub();
    const audited = new CatalogueService(store, audit as never, mt5Stub, groupSyncStub);
    const standard = await makeProduct('Audited Standard');

    const attached = await audited.attachGroup(standard, live('real\\Standard-USD'), TEST_ACTOR);
    await audited.detachGroup(standard, attached.groups[0]?.id ?? '', TEST_ACTOR);

    const actions = audit.record.mock.calls.map((call) => String(call[1]));
    expect(actions).toEqual(['product.group_attach', 'product.group_detach']);
  });
});

/*
 * THE ORDER IS NOT ASKED FOR ANY MORE (owner, 26 Sep 2026). The console sends
 * no position: a new row goes after the last one, and an edited row stays
 * exactly where it was.
 */
describe('positions without an order field', () => {
  async function productOrder(): Promise<string[]> {
    return (await service.listProducts()).map((product) => product.name);
  }

  // As the console creates them now: no position at all.
  const newProduct = async (name: string) =>
    (await service.createProduct({ name, description: null, enabled: true }, TEST_ACTOR)).id;
  const newAgency = async (name: string) =>
    (await service.createAgency({ name, description: null, enabled: true }, TEST_ACTOR)).id;

  it('appends a new product, and keeps an edited one in its place', async () => {
    const first = await newProduct('Order First');
    await newProduct('Order Second');
    await newProduct('Order Third');

    await service.updateProduct(
      first,
      { name: 'Order First', description: 'edited', enabled: false },
      TEST_ACTOR,
    );

    expect(await productOrder()).toEqual(['Order First', 'Order Second', 'Order Third']);
  });

  it('appends a new agency, and keeps an edited one in its place', async () => {
    const first = await newAgency('Agency First');
    await newAgency('Agency Second');

    await service.updateAgency(
      first,
      { name: 'Agency First', description: 'edited', enabled: true },
      TEST_ACTOR,
    );

    const names = (await service.listAgencies()).map((agency) => agency.name);
    expect(names.indexOf('Agency First')).toBeLessThan(names.indexOf('Agency Second'));
  });

  it('puts a new commission type after the last one', async () => {
    const types = new IbCommissionTypesService(ctx.db, auditStubAs());
    const first = await types.create(
      { name: 'Order type A', description: null, commissionPerLot: '10', rebatePerLot: '3' },
      TEST_ACTOR,
    );
    const second = await types.create(
      { name: 'Order type B', description: null, commissionPerLot: '10', rebatePerLot: '3' },
      TEST_ACTOR,
    );

    expect(second.sortOrder).toBeGreaterThan(first.sortOrder);
  });
});

describe('Arabic names and descriptions (0179)', () => {
  it('stores a product’s Arabic, keeps it on a PUT that omits it, and clears blank', async () => {
    const created = await service.createProduct(
      { name: 'Standard', nameAr: '  قياسي ', enabled: true },
      TEST_ACTOR,
    );
    expect(created.nameAr).toBe('قياسي');
    expect((await service.listProducts()).find((p) => p.id === created.id)?.nameAr).toBe('قياسي');

    const renamed = await service.updateProduct(
      created.id,
      { name: 'Standard+', enabled: true },
      TEST_ACTOR,
    );
    expect(renamed.nameAr).toBe('قياسي');

    const cleared = await service.updateProduct(
      created.id,
      { name: 'Standard+', nameAr: '   ', enabled: true },
      TEST_ACTOR,
    );
    expect(cleared.nameAr).toBeNull();
  });

  it('stores an agency’s Arabic and serves it, with the products’ Arabic index for index', async () => {
    const standard = await service.createProduct(
      { name: 'Standard', nameAr: 'قياسي', enabled: true },
      TEST_ACTOR,
    );
    const ecn = await service.createProduct({ name: 'ECN', enabled: true }, TEST_ACTOR);
    const agency = await service.createAgency(
      { name: 'Gold', nameAr: 'ذهبي', descriptionAr: '  ', enabled: true },
      TEST_ACTOR,
    );
    expect(agency).toMatchObject({ nameAr: 'ذهبي', descriptionAr: null });
    await service.setAgencyProducts(agency.id, [standard.id, ecn.id], TEST_ACTOR);

    const kept = await service.updateAgency(
      agency.id,
      { name: 'Gold+', descriptionAr: 'وصف', enabled: true },
      TEST_ACTOR,
    );
    expect(kept).toMatchObject({ nameAr: 'ذهبي', descriptionAr: 'وصف' });

    const [open] = await service.listOpenAgencies();
    expect(open).toMatchObject({ nameAr: 'ذهبي', descriptionAr: 'وصف' });
    const pairs = open.products.map((name, i) => [name, open.productsAr[i]]);
    expect(pairs.sort()).toEqual([
      ['ECN', null],
      ['Standard', 'قياسي'],
    ]);
  });

  it('offers a product with its Arabic name', async () => {
    const id = (
      await service.createProduct({ name: 'Standard', nameAr: 'قياسي', enabled: true }, TEST_ACTOR)
    ).id;
    await service.attachGroup(
      id,
      { environment: 'live', mt5Group: 'real\\Standard-USD' },
      TEST_ACTOR,
    );
    const client = await makeUser('arabic@offered.local');
    const [offer] = await store.offeredTo(client, 'live');
    expect(offer).toMatchObject({ productName: 'Standard', productNameAr: 'قياسي' });
  });
});
