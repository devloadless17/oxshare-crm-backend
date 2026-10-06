-- 0201 — LIMITS LIVE ON THE PRODUCT (6 Oct 2026).
--
-- The owner's rules:
--
-- 1. As many DEMO products as the admin wants. 0088 allowed exactly one; its
--    partial unique index goes, and every enabled demo product is offered to
--    every client (still never through an agency).
-- 2. Each product says how many accounts ONE client may hold under it
--    (`max_accounts_per_client`, 1–100). It replaces the two platform-wide caps
--    on `trading_settings` (`max_live_accounts`, `max_demo_accounts`), which are
--    DROPPED: each product starts with the cap its environment had, so nothing
--    a client can do changes on deploy. A cap of 0 meant "no new accounts of
--    this kind online"; a product cannot be capped at 0, so those products are
--    switched off instead — the same effect for clients.
-- 3. Each LIVE group of a product may carry a MINIMUM DEPOSIT
--    (`trading_product_groups.min_deposit`), in that group's currency — one
--    amount per currency, because there is no FX source to convert one amount.
--    Every wallet→account transfer a client makes into an account opened on
--    that product and group must be at least that much. A demo group never
--    carries one: demo accounts are not funded from the wallet.
--
-- Idempotent; no transaction scope assumed. Roll-forward only (the caps' old
-- columns are gone).

DROP INDEX IF EXISTS trading_products_single_demo_uq;
--> statement-breakpoint
ALTER TABLE trading_products ADD COLUMN IF NOT EXISTS max_accounts_per_client integer;
--> statement-breakpoint
DO $$
DECLARE
  live_cap integer;
  demo_cap integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trading_settings' AND column_name = 'max_live_accounts'
  ) THEN
    EXECUTE 'SELECT max_live_accounts, max_demo_accounts FROM trading_settings LIMIT 1'
      INTO live_cap, demo_cap;
    -- No settings row means the column defaults applied: 5 and 5.
    live_cap := coalesce(live_cap, 5);
    demo_cap := coalesce(demo_cap, 5);
    UPDATE trading_products
       SET max_accounts_per_client =
             least(greatest(CASE WHEN type = 'demo' THEN demo_cap ELSE live_cap END, 1), 100),
           enabled = CASE
             WHEN (CASE WHEN type = 'demo' THEN demo_cap ELSE live_cap END) = 0 THEN false
             ELSE enabled
           END
     WHERE max_accounts_per_client IS NULL;
  END IF;
END $$;
--> statement-breakpoint
UPDATE trading_products SET max_accounts_per_client = 5 WHERE max_accounts_per_client IS NULL;
--> statement-breakpoint
ALTER TABLE trading_products ALTER COLUMN max_accounts_per_client SET DEFAULT 5;
--> statement-breakpoint
ALTER TABLE trading_products ALTER COLUMN max_accounts_per_client SET NOT NULL;
--> statement-breakpoint
ALTER TABLE trading_products DROP CONSTRAINT IF EXISTS trading_products_max_accounts_ck;
--> statement-breakpoint
ALTER TABLE trading_products ADD CONSTRAINT trading_products_max_accounts_ck
  CHECK (max_accounts_per_client BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE trading_product_groups ADD COLUMN IF NOT EXISTS min_deposit numeric(28, 8);
--> statement-breakpoint
ALTER TABLE trading_product_groups DROP CONSTRAINT IF EXISTS trading_product_groups_min_deposit_ck;
--> statement-breakpoint
ALTER TABLE trading_product_groups ADD CONSTRAINT trading_product_groups_min_deposit_ck
  CHECK (min_deposit IS NULL OR (min_deposit > 0 AND environment = 'live'));
--> statement-breakpoint
ALTER TABLE trading_settings DROP COLUMN IF EXISTS max_live_accounts;
--> statement-breakpoint
ALTER TABLE trading_settings DROP COLUMN IF EXISTS max_demo_accounts;
