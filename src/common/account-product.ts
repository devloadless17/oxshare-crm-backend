import { sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { tradingProducts } from '../database/schema';

/**
 * "Which product is this trading account under" — the one place that answers it.
 *
 * In `common/` rather than in `modules/trading/` because two modules ask: the
 * portal reads it through `TradingService` and the back office through
 * `AdminHoldingsService`. If they resolved it separately they would eventually
 * disagree, and the disagreement would surface as a client and a support agent
 * looking at the same account and reading different products off it — during the
 * commission dispute that made somebody open both screens.
 *
 * `common/` may import `database/` and must not import `modules/` (the layering
 * lint rule), which is exactly the shape of this seam: it is schema plus SQL and
 * knows nothing about either caller.
 *
 * ## Two sources, in a fixed order
 *
 * 1. `trading_accounts.product_id` — SNAPSHOTTED when the account was opened
 *    (migration 0080). This is the answer whenever it is present.
 * 2. The MT5 group the account sits in, matched against the catalogue — the
 *    FALLBACK, and the way this used to work.
 *
 * The order is the entire point and must not be flipped. The group match reports
 * the catalogue as it stands NOW: detaching a group from a product, re-pointing
 * it at a different one, or renaming it on the MT5 server each silently rewrites
 * the answer for every account already in that group, with no trace left on the
 * rows themselves. The snapshot is what makes a client's choice survive an
 * operator editing the catalogue afterwards.
 *
 * The fallback stays because dropping it would regress every account whose
 * `product_id` is NULL to "no product". After 0080's backfill that means a row
 * whose group no product carried, or one whose product has since been deleted —
 * the FK is ON DELETE SET NULL, because retiring a product must not reach into
 * accounts that are already open.
 *
 * ## Using it
 *
 * Three LEFT joins, in this order, then select `PRODUCT_NAME`:
 *
 * ```ts
 *   .from(tradingAccounts)
 *   .leftJoin(PRODUCT_BY_ID, eq(PRODUCT_BY_ID.id, tradingAccounts.productId))
 *   .leftJoin(tradingProductGroups, PRODUCT_GROUP_JOIN_ON)
 *   .leftJoin(PRODUCT_BY_GROUP, eq(PRODUCT_BY_GROUP.id, tradingProductGroups.productId))
 * ```
 *
 * LEFT throughout, so an account with neither still returns. That is a real
 * state rather than a fault: an operator can open an account directly into any
 * MT5 group, including one the catalogue does not sell.
 */

/** The product the account RECORDED at creation. */
export const PRODUCT_BY_ID = alias(tradingProducts, 'product_by_id');

/** The product the catalogue currently sells the account's group as. */
export const PRODUCT_BY_GROUP = alias(tradingProducts, 'product_by_group');

/**
 * Account group ↔ catalogue group, CASE-INSENSITIVELY.
 *
 * The stored group comes back from the bridge and the catalogue's was typed by
 * an operator, so the two can differ in casing alone — and MT5 treats group
 * paths case-insensitively. An exact join would resolve those to NULL, which is
 * indistinguishable from "this group is in no product": a wrong answer wearing
 * the costume of a right one.
 *
 * ## At most ONE row, and since 0142 the join has to make that true itself
 *
 * `trading_product_groups_group_unique` used to guarantee it: a group belonged
 * to one product platform-wide. A group may back several products now, and a
 * plain match would return the account once per product — every list built on
 * this join would show the same account twice, with two different product
 * names.
 *
 * So the join picks the OLDEST attachment of the account's group. This is the
 * FALLBACK only — every account opened since 0080 records its product, and
 * since 0142 the open paths record the product that was actually chosen — so
 * "oldest" answers only for legacy rows with no recorded product, where it is
 * the attachment that existed when they were opened.
 *
 * Hand-qualified inside the subquery: `g` is the inner table, and the outer
 * account and product-group tables are named in full so nothing can bind to
 * the wrong one (Drizzle renders bare column names in some `sql` positions).
 */
export const PRODUCT_GROUP_JOIN_ON = sql`"trading_product_groups"."id" = (
  SELECT g.id
    FROM trading_product_groups AS g
   WHERE lower(g.mt5_group) = lower("trading_accounts"."mt5_group")
   ORDER BY g.created_at, g.id
   LIMIT 1
)`;

/**
 * The product NAME to show: what was recorded, else what is derived, else NULL.
 *
 * NULL is a real state and stays NULL. Callers omit the field rather than
 * rendering an em dash — a permanent dash where a value belongs teaches a reader
 * that our data is missing rather than that the account has no product, and it
 * is the first thing they ask support about.
 */
export const PRODUCT_NAME = sql<
  string | null
>`coalesce(${PRODUCT_BY_ID.name}, ${PRODUCT_BY_GROUP.name})`;

/**
 * The same product's name in Arabic (0179) — from the SAME row `PRODUCT_NAME`
 * read, never a coalesce across the two: a recorded product with no Arabic must
 * not borrow the Arabic of whichever product the group happens to match now.
 * NULL when untranslated or when there is no product; the portal shows
 * `product` then.
 */
export const PRODUCT_NAME_AR = sql<string | null>`CASE
  WHEN ${PRODUCT_BY_ID.id} IS NOT NULL THEN ${PRODUCT_BY_ID.nameAr}
  ELSE ${PRODUCT_BY_GROUP.nameAr}
END`;

/**
 * The MINIMUM a client's transfer into this account must reach (0201), or NULL.
 *
 * Read off the offer the account was opened on: its RECORDED product, and the
 * group of that product the account sits in now (case-insensitively, as MT5
 * groups match). Live groups only — the CHECK on the column says the same. An
 * account with no recorded product, or whose group that product no longer
 * sells, has no minimum: there is no offer left to hold it to, and the
 * group-derived fallback above is for NAMING a legacy account, never for
 * refusing money into it.
 *
 * The one definition, read by `TransfersService` (the refusal), the deposit
 * door and the client's account list (the hint) alike. Needs no join: it is a
 * correlated subquery over `trading_accounts`.
 */
export const ACCOUNT_MIN_DEPOSIT = sql<string | null>`(
  SELECT g.min_deposit
    FROM trading_product_groups AS g
   WHERE g.product_id = "trading_accounts"."product_id"
     AND lower(g.mt5_group) = lower("trading_accounts"."mt5_group")
     AND g.environment = 'live'
   LIMIT 1
)`;
