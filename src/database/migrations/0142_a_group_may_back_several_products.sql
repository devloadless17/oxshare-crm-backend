-- ============================================================================
-- An MT5 group may back SEVERAL products
-- ============================================================================
--
-- Asked for directly (25 Sep 2026): "a group can only be attached to one
-- product; if it is already attached to one I should still be able to attach
-- it to another."
--
-- `trading_product_groups_group_unique` made a group unique platform-wide, so
-- that "which product is this account under" could be read off the account's
-- group. Since 0141 that question also decides the account's COMMISSION TYPE,
-- so it still needs one answer — it just can no longer come from the group
-- alone. It now comes from the choice made when the account is opened:
--
--   portal self-service  the client picks a product; the portal sends its id.
--   admin "open account" the operator picks the product when the group is sold
--                        by more than one; refused rather than guessed.
--
-- Either way it is written to `trading_accounts.product_id` (the 0080 snapshot),
-- which is what every reader uses first. The group match is only the fallback
-- for accounts with no recorded product, and it now takes the OLDEST attachment
-- so a list cannot show one account twice.
--
-- What stays unique: one product may not carry the same group twice (the new
-- index, case-insensitive like every group lookup), and a product still has at
-- most one group per environment and currency (`slot_unique`, unchanged).

BEGIN;

ALTER TABLE trading_product_groups DROP CONSTRAINT IF EXISTS trading_product_groups_group_unique;

CREATE UNIQUE INDEX IF NOT EXISTS trading_product_groups_product_group_uq
  ON trading_product_groups (product_id, lower(mt5_group));

-- The group lookup the account-open and fallback paths make, now that the
-- unique constraint's index is gone.
CREATE INDEX IF NOT EXISTS trading_product_groups_group_idx
  ON trading_product_groups (lower(mt5_group));

COMMIT;
