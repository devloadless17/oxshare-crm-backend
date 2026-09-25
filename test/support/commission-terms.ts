import { sql } from 'drizzle-orm';
import type { MoneyTestContext } from '../money-setup';

/**
 * Fixtures for the commission model since 0140: a product's COMMISSION TYPE
 * carries the money per lot, and each rung of the ladder takes a share of it.
 *
 * ## Why every accrual suite needs a product now
 *
 * Until 0140 a rung carried an absolute amount, so a trade on an account linked
 * to no product still paid. Now the amount lives on the product's type, and an
 * unlinked account is REFUSED by the engine — deliberately, because nothing
 * says what its trades pay. A fixture that forgets the product therefore sees
 * every trade deferred rather than paid, which is the right behaviour and the
 * wrong test. These helpers make the product the one line it should be.
 */

type Db = MoneyTestContext['db'];

/** One rung's shares, as percentages of the product's type. */
export interface RungShares {
  commission: string;
  rebate?: string;
}

/**
 * Set the whole ladder, level 1 first.
 *
 * Every existing rung is zeroed first: a share left on level 3 by a previous
 * case would pay a partner the current one never configured, and these suites
 * share a database. Rungs are created as needed and never deleted —
 * `ib_accruals.level_id` is ON DELETE RESTRICT, so a rung that has paid cannot
 * go, and a zero share is the same thing to the engine.
 */
export async function setLadderShares(db: Db, rungs: readonly RungShares[]): Promise<void> {
  await db.execute(
    sql`UPDATE ib_levels SET commission_share = 0, rebate_share = 0, enabled = true`,
  );

  for (const [index, rung] of rungs.entries()) {
    await db.execute(sql`
      INSERT INTO ib_levels (level, name, commission_share, rebate_share, enabled)
      VALUES (${index + 1}, ${'Level ' + String(index + 1)}, ${rung.commission},
              ${rung.rebate ?? '0'}, true)
      ON CONFLICT (level) DO UPDATE
        SET commission_share = EXCLUDED.commission_share,
            rebate_share = EXCLUDED.rebate_share,
            enabled = true
    `);
  }
}

/**
 * A commission type and a REAL product sold on it, and optionally the trading
 * accounts (by MT5 login) put onto that product.
 *
 * Re-runnable by name, so a suite can call it in `beforeAll` and again in a
 * case that changes the amounts.
 */
export async function seedProductTerms(
  db: Db,
  terms: {
    name: string;
    commissionPerLot: string;
    rebatePerLot?: string;
    enabled?: boolean;
    /** MT5 logins whose `trading_accounts` rows are linked to the product. */
    logins?: readonly string[];
  },
): Promise<{ typeId: string; productId: string }> {
  const { rows: types } = await db.execute<{ id: string }>(sql`
    INSERT INTO ib_commission_types (name, commission_per_lot, rebate_per_lot, enabled)
    VALUES (${terms.name}, ${terms.commissionPerLot}, ${terms.rebatePerLot ?? '0'},
            ${terms.enabled ?? true})
    ON CONFLICT (name) DO UPDATE
      SET commission_per_lot = EXCLUDED.commission_per_lot,
          rebate_per_lot = EXCLUDED.rebate_per_lot,
          enabled = EXCLUDED.enabled
    RETURNING id
  `);
  const typeId = types[0].id;

  const { rows: products } = await db.execute<{ id: string }>(sql`
    INSERT INTO trading_products (name, enabled, type, sort_order, commission_type_id)
    VALUES (${terms.name}, true, 'real', 900, ${typeId})
    ON CONFLICT (name) DO UPDATE SET commission_type_id = EXCLUDED.commission_type_id
    RETURNING id
  `);
  const productId = products[0].id;

  if (terms.logins && terms.logins.length > 0) {
    for (const login of terms.logins) {
      await db.execute(
        sql`UPDATE trading_accounts SET product_id = ${productId} WHERE login = ${login}`,
      );
    }
  }

  return { typeId, productId };
}

/** Put EVERY trading account onto one product — for suites whose accounts are made inline. */
export async function linkEveryAccountTo(db: Db, productId: string): Promise<void> {
  await db.execute(sql`UPDATE trading_accounts SET product_id = ${productId}`);
}
