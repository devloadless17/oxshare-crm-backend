-- ============================================================================
-- One group per currency on a product, again (owner, 26 Sep 2026)
-- ============================================================================
--
-- 0146 dropped `trading_product_groups_slot_unique` so a product could hold
-- several groups in one currency. The owner reverted that decision the same day:
-- a client opening an account picks a PRODUCT and a CURRENCY and never sees a
-- group, so a second group in the same currency could never be chosen from the
-- portal — and in MT5 a group carries its own commission, swap and margin
-- terms, so it is a different offering, which is what a separate product is
-- for. The API refuses the second group again with a reason; this puts the
-- database guarantee back under it.
--
-- ## A product that already holds two groups in one currency STOPS this
--
-- Re-adding the constraint would fail on such a product with a bare
-- duplicate-key error. Instead it is refused here, naming every product, the
-- environment, the currency and the groups, so an operator can detach the ones
-- they do not want (Products → edit → detach) and run the migrations again.
-- Nothing is detached automatically: which group a product keeps is a
-- commercial decision, not one to make by picking the oldest row.

DO $$
DECLARE
  clashes text;
BEGIN
  SELECT string_agg(
           format('%s (%s %s): %s', p.name, g.environment, g.currency, g.groups),
           E'\n  ' ORDER BY p.name, g.environment, g.currency)
    INTO clashes
    FROM (
      SELECT product_id, environment, currency,
             string_agg(mt5_group, ', ' ORDER BY created_at, mt5_group) AS groups
        FROM trading_product_groups
       GROUP BY product_id, environment, currency
      HAVING count(*) > 1
    ) AS g
    JOIN trading_products AS p ON p.id = g.product_id;

  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION E'These products hold more than one group in the same currency. Detach the extra groups on the Products page, then run the migrations again:\n  %', clashes;
  END IF;
END $$;

ALTER TABLE trading_product_groups
  ADD CONSTRAINT trading_product_groups_slot_unique UNIQUE (product_id, environment, currency);
