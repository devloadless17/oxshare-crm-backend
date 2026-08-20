import { sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { tradingAccounts, tradingProductGroups, tradingProducts } from '../database/schema';

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
 * At most one row, because `trading_product_groups_group_unique` makes the group
 * unique platform-wide — the constraint whose stated purpose is that this
 * question has a single answer, since it "decides whose commission it pays".
 */
export const PRODUCT_GROUP_JOIN_ON = sql`lower(${tradingProductGroups.mt5Group}) = lower(${tradingAccounts.mt5Group})`;

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
