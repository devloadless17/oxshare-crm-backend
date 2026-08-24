import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import {
  agencies,
  agencyProducts,
  ibAccounts,
  tradingProductGroups,
  tradingProducts,
  users,
} from '../database/schema';

/**
 * Products, the MT5 groups behind them, and the agencies that sell them.
 *
 * ONE store for the cluster, on the same reasoning as `AppSettingsStore`: these
 * four tables are read and written together and no caller wants one without the
 * others. A product with no groups is not a product anybody can open an account
 * on, and an agency is defined by the products it carries.
 *
 * ## The one method that matters
 *
 * `offeredTo` is the whole point of the cluster: given a client, what may they
 * open? Everything else exists so an operator can answer it correctly.
 */

export interface ProductGroupRow {
  id: string;
  environment: 'live' | 'demo';
  mt5Group: string;
  currency: string;
}

export interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /**
   * Fixed at creation. `demo` exists at most once and is offered globally;
   * see the column comment in schema.ts for the full rule set.
   */
  type: 'real' | 'demo';
  /**
   * A decimal STRING, never a number. It is `NUMERIC(28,8)` and it is money —
   * §6 forbids it becoming a float anywhere between the form and the column,
   * and a markup of `1.5` that arrives as `1.4999999999` is the kind of wrong
   * that survives review because it looks almost right.
   */
  spreadMarkupPerLot: string;
  sortOrder: number;
  groups: ProductGroupRow[];
}

export interface AgencyRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  sortOrder: number;
  productIds: string[];
}

/** One thing a client may open: a group, and the product it belongs to. */
export interface OfferedGroup {
  productId: string;
  productName: string;
  mt5Group: string;
  currency: string;
}

@Injectable()
export class ProductsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /* ── Products ─────────────────────────────────────────────────────────── */

  async listProducts(): Promise<ProductRow[]> {
    const rows = await this.db
      .select()
      .from(tradingProducts)
      .orderBy(asc(tradingProducts.sortOrder), asc(tradingProducts.name));

    if (rows.length === 0) return [];

    /*
     * Two queries and a join in memory, rather than one query with a LEFT JOIN.
     *
     * The join returns a product's columns once per group and the caller has to
     * de-duplicate them; with a handful of products and a handful of groups
     * each, the second round trip costs less than the code that would unpick
     * the first one wrongly.
     */
    const groups = await this.db
      .select()
      .from(tradingProductGroups)
      .where(
        inArray(
          tradingProductGroups.productId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(tradingProductGroups.environment), asc(tradingProductGroups.currency));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      spreadMarkupPerLot: row.spreadMarkupPerLot,
      type: row.type,
      sortOrder: row.sortOrder,
      groups: groups
        .filter((group) => group.productId === row.id)
        .map((group) => ({
          id: group.id,
          environment: group.environment,
          mt5Group: group.mt5Group,
          currency: group.currency,
        })),
    }));
  }

  async createProduct(values: {
    name: string;
    description: string | null;
    enabled: boolean;
    type: 'real' | 'demo';
    spreadMarkupPerLot: string;
    sortOrder: number;
  }): Promise<ProductRow> {
    const [row] = await this.db.insert(tradingProducts).values(values).returning();
    return { ...row, groups: [] };
  }

  /**
   * `type` is deliberately absent from the values: it is fixed at creation.
   *
   * `spreadMarkupPerLot` is NOT — a markup is exactly the commercial term that
   * gets renegotiated, so it lives in the update path and the caller audits
   * both sides of the change.
   */
  async updateProduct(
    id: string,
    values: {
      name: string;
      description: string | null;
      enabled: boolean;
      spreadMarkupPerLot: string;
      sortOrder: number;
    },
  ): Promise<ProductRow | null> {
    const [row] = await this.db
      .update(tradingProducts)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(tradingProducts.id, id))
      .returning();

    if (!row) return null;
    const groups = await this.groupsOf(id);
    return { ...row, groups };
  }

  /** Returns false when nothing matched, so the caller can 404 rather than lie. */
  async deleteProduct(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(tradingProducts)
      .where(eq(tradingProducts.id, id))
      .returning({ id: tradingProducts.id });
    return deleted.length > 0;
  }

  async groupsOf(productId: string): Promise<ProductGroupRow[]> {
    const rows = await this.db
      .select()
      .from(tradingProductGroups)
      .where(eq(tradingProductGroups.productId, productId))
      .orderBy(asc(tradingProductGroups.environment), asc(tradingProductGroups.currency));

    return rows.map((row) => ({
      id: row.id,
      environment: row.environment,
      mt5Group: row.mt5Group,
      currency: row.currency,
    }));
  }

  async addGroup(values: {
    productId: string;
    environment: 'live' | 'demo';
    mt5Group: string;
    currency: string;
  }): Promise<ProductGroupRow> {
    const [row] = await this.db.insert(tradingProductGroups).values(values).returning();
    return {
      id: row.id,
      environment: row.environment,
      mt5Group: row.mt5Group,
      currency: row.currency,
    };
  }

  async removeGroup(productId: string, groupId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(tradingProductGroups)
      .where(
        and(eq(tradingProductGroups.id, groupId), eq(tradingProductGroups.productId, productId)),
      )
      .returning({ id: tradingProductGroups.id });
    return deleted.length > 0;
  }

  /* ── Agencies ─────────────────────────────────────────────────────────── */

  async listAgencies(): Promise<AgencyRow[]> {
    const rows = await this.db
      .select()
      .from(agencies)
      .orderBy(asc(agencies.sortOrder), asc(agencies.name));

    if (rows.length === 0) return [];

    /*
     * The join to products drops links to non-real products. The service
     * refuses to CREATE such a link and migration 0088 deleted the existing
     * ones, so this filter is the read-side guarantee against a row that
     * arrived by hand: an agency lists real products only, everywhere.
     */
    const links = await this.db
      .select({ agencyId: agencyProducts.agencyId, productId: agencyProducts.productId })
      .from(agencyProducts)
      .innerJoin(tradingProducts, eq(tradingProducts.id, agencyProducts.productId))
      .where(
        and(
          inArray(
            agencyProducts.agencyId,
            rows.map((row) => row.id),
          ),
          eq(tradingProducts.type, 'real'),
        ),
      );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      sortOrder: row.sortOrder,
      productIds: links.filter((link) => link.agencyId === row.id).map((link) => link.productId),
    }));
  }

  async createAgency(values: {
    name: string;
    description: string | null;
    enabled: boolean;
    sortOrder: number;
  }): Promise<AgencyRow> {
    const [row] = await this.db.insert(agencies).values(values).returning();
    return { ...row, productIds: [] };
  }

  async updateAgency(
    id: string,
    values: { name: string; description: string | null; enabled: boolean; sortOrder: number },
  ): Promise<AgencyRow | null> {
    const [row] = await this.db
      .update(agencies)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(agencies.id, id))
      .returning();

    if (!row) return null;
    return { ...row, productIds: await this.productIdsOf(id) };
  }

  async deleteAgency(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(agencies)
      .where(eq(agencies.id, id))
      .returning({ id: agencies.id });
    return deleted.length > 0;
  }

  async productIdsOf(agencyId: string): Promise<string[]> {
    const rows = await this.db
      .select({ productId: agencyProducts.productId })
      .from(agencyProducts)
      .innerJoin(tradingProducts, eq(tradingProducts.id, agencyProducts.productId))
      .where(and(eq(agencyProducts.agencyId, agencyId), eq(tradingProducts.type, 'real')));
    return rows.map((row) => row.productId);
  }

  /**
   * Replace an agency's products wholesale.
   *
   * Delete-then-insert inside ONE transaction. The alternative — diffing the
   * incoming list against the stored one — is more code for the same result,
   * and a partial application of that diff leaves an agency selling a set
   * nobody chose. The window where the agency has no products has to not exist,
   * hence the transaction.
   */
  async setAgencyProducts(agencyId: string, productIds: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(agencyProducts).where(eq(agencyProducts.agencyId, agencyId));
      if (productIds.length > 0) {
        await tx
          .insert(agencyProducts)
          .values(productIds.map((productId) => ({ agencyId, productId })));
      }
    });
  }

  /* ── The resolution ───────────────────────────────────────────────────── */

  /**
   * Which agency, if any, governs what this client may open.
   *
   * Null covers three different situations that all resolve the same way: the
   * client came in directly, or their partner predates agencies, or their
   * partner has none assigned. All three mean "no agency narrows this", and the
   * caller offers the full catalogue.
   */
  async agencyForClient(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ agencyId: ibAccounts.agencyId })
      .from(users)
      .innerJoin(ibAccounts, eq(ibAccounts.userId, users.referredByIbUserId))
      .where(eq(users.id, userId))
      .limit(1);

    return row?.agencyId ?? null;
  }

  /**
   * Everything this client may open in one environment.
   *
   * ## The rule, in one place
   *
   * LIVE: a client under a partner is offered their partner's agency's real
   * products and nothing else. A client under nobody is offered every enabled
   * real product. There is no third case and no per-product visibility flag —
   * see the note on `trading_products` about the state such a flag would
   * create.
   *
   * DEMO: the single demo product, for EVERYBODY. Practice accounts are not a
   * commercial decision an agency makes, so the agency is never consulted —
   * which is also why the demo product cannot be assigned to one.
   *
   * DISABLED products are excluded from every branch. A disabled product keeps
   * its open accounts trading and stops being sold, which is the same rule a
   * disabled currency and a disabled IB level follow.
   */
  async offeredTo(userId: string, environment: 'live' | 'demo'): Promise<OfferedGroup[]> {
    const agencyId = environment === 'live' ? await this.agencyForClient(userId) : null;

    const rows = await this.db
      .select({
        productId: tradingProducts.id,
        productName: tradingProducts.name,
        sortOrder: tradingProducts.sortOrder,
        mt5Group: tradingProductGroups.mt5Group,
        currency: tradingProductGroups.currency,
      })
      .from(tradingProductGroups)
      .innerJoin(tradingProducts, eq(tradingProducts.id, tradingProductGroups.productId))
      .where(
        and(
          eq(tradingProductGroups.environment, environment),
          eq(tradingProducts.enabled, true),
          eq(tradingProducts.type, environment === 'demo' ? 'demo' : 'real'),
          ...(agencyId
            ? [
                inArray(
                  tradingProducts.id,
                  this.db
                    .select({ id: agencyProducts.productId })
                    .from(agencyProducts)
                    .where(eq(agencyProducts.agencyId, agencyId)),
                ),
              ]
            : []),
        ),
      )
      .orderBy(
        asc(tradingProducts.sortOrder),
        asc(tradingProducts.name),
        asc(tradingProductGroups.currency),
      );

    return rows.map((row) => ({
      productId: row.productId,
      productName: row.productName,
      mt5Group: row.mt5Group,
      currency: row.currency,
    }));
  }

  /** Every group any product claims, for the "already taken" check in the UI. */
  async claimedGroups(): Promise<string[]> {
    const rows = await this.db
      .select({ mt5Group: tradingProductGroups.mt5Group })
      .from(tradingProductGroups);
    return rows.map((row) => row.mt5Group);
  }

  /**
   * Which product currently sells this MT5 group, if any.
   *
   * Called at ACCOUNT-OPEN time and nowhere else, to snapshot
   * `trading_accounts.product_id`. That is the whole contract: it answers "what
   * is the catalogue selling this group as, right now", and the caller writes
   * the answer down so nothing has to ask again. A caller that re-ran this to
   * refresh an existing account would reintroduce exactly the moving answer 0080
   * exists to stop.
   *
   * CASE-INSENSITIVE, matching `PRODUCT_JOIN_ON` in `TradingService`. The group
   * being looked up comes back from the bridge and the catalogue's was typed by
   * an operator, so the two can differ in casing alone — and MT5 treats group
   * paths case-insensitively, so an exact match would answer NULL for a group
   * that is plainly listed.
   *
   * NULL is a normal answer, not a failure: an account may be opened directly
   * into a group no product carries. The caller stores NULL rather than
   * refusing.
   *
   * One row at most, because `trading_product_groups_group_unique` makes the
   * group unique platform-wide — the constraint whose stated purpose is that
   * "which product is this account under" has a single answer.
   */
  async productIdForGroup(mt5Group: string): Promise<string | null> {
    const [row] = await this.db
      .select({ productId: tradingProductGroups.productId })
      .from(tradingProductGroups)
      .where(sql`lower(${tradingProductGroups.mt5Group}) = lower(${mt5Group})`)
      .limit(1);

    return row?.productId ?? null;
  }
}
