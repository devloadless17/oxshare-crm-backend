-- Products get a TYPE: `real` or `demo`, and the demo side collapses to one.
--
-- Until now "real vs demo" lived one level down, on the group (`environment`),
-- and a single product could carry both — the imported 'Standard' did. Three
-- rules replace that:
--
--   1. A product is `real` or `demo`, fixed at creation.
--   2. At most ONE demo product exists (partial unique index below), and it is
--      offered to EVERY client for demo accounts — agency or no agency. Demo
--      resolution in `ProductsStore.offeredTo` no longer consults the agency.
--   3. Agencies carry real products only. The demo product cannot be assigned
--      to one, because it is already offered to everybody.
--
-- ── The data move ──────────────────────────────────────────────────────────
--
-- Every existing product becomes `real` (the column default). One demo product
-- is then established — an existing product literally named 'Demo' is reused if
-- it carries no live groups, otherwise a fresh row is created — and every demo
-- group in the catalogue moves onto it. Products that lose their demo groups
-- stay `real` with fewer (possibly zero) groups: a visible, ordinary state the
-- admin table already renders, and the operator can delete the empty ones.
--
-- The demo product is created even when NO demo groups exist yet: the global
-- demo slot must exist for `SelfServiceGroups.importLegacyEnvGroups` to have a
-- demo-typed target when a fresh deployment imports MT5_CLIENT_GROUPS_DEMO on
-- first boot.
--
-- The one destructive branch: `trading_product_groups_slot_unique` is
-- (product_id, environment, currency), so two demo groups in the SAME currency
-- coming from different products collide when consolidated. The move keeps the
-- oldest per currency and drops the later row with a NOTICE naming the MT5
-- group — two rows both saying "demo · USD" on one product is a choice the
-- constraint already declares meaningless. Detection query to run BEFORE
-- deploying, and pre-clean if it returns rows:
--
--   SELECT currency, count(*) FROM trading_product_groups
--    WHERE environment = 'demo' GROUP BY 1 HAVING count(*) > 1;

DO $$ BEGIN
  CREATE TYPE "public"."product_type" AS ENUM('real', 'demo');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

ALTER TABLE "trading_products" ADD COLUMN IF NOT EXISTS "type" "product_type" DEFAULT 'real' NOT NULL;
--> statement-breakpoint

-- Safe to create before the move: no row is 'demo' yet at this point.
CREATE UNIQUE INDEX IF NOT EXISTS "trading_products_single_demo_uq"
  ON "trading_products" ("type") WHERE "type" = 'demo';
--> statement-breakpoint

DO $$
DECLARE
  demo_id uuid;
  new_name text;
  grp record;
BEGIN
  -- Nothing to establish if a demo product already exists (re-run safety).
  SELECT id INTO demo_id FROM trading_products WHERE type = 'demo' LIMIT 1;

  IF demo_id IS NULL THEN
    -- Reuse a product an operator already named 'Demo' — but only if it
    -- carries no live groups, which would contradict the type it is taking.
    SELECT p.id INTO demo_id
      FROM trading_products p
     WHERE lower(p.name) = 'demo'
       AND NOT EXISTS (
         SELECT 1 FROM trading_product_groups g
          WHERE g.product_id = p.id AND g.environment = 'live'
       )
     LIMIT 1;

    IF demo_id IS NOT NULL THEN
      UPDATE trading_products
         SET type = 'demo', enabled = true, updated_at = now()
       WHERE id = demo_id;
    ELSE
      -- First free name wins; `name` is UNIQUE. All three taken means someone
      -- has built a naming scheme this migration should not guess at — the
      -- INSERT then fails loudly rather than inventing a fourth.
      SELECT v.candidate INTO new_name
        FROM (VALUES ('Demo'), ('Demo Accounts'), ('Demo Product')) v(candidate)
       WHERE NOT EXISTS (
         SELECT 1 FROM trading_products p WHERE lower(p.name) = lower(v.candidate)
       )
       LIMIT 1;

      INSERT INTO trading_products (name, description, enabled, type, sort_order)
      VALUES (
        new_name,
        'Practice accounts on virtual funds. The single demo product — offered to every client regardless of agency.',
        true,
        'demo',
        COALESCE((SELECT max(sort_order) + 1 FROM trading_products), 0)
      )
      RETURNING id INTO demo_id;
    END IF;
  END IF;

  -- Move every demo group onto the demo product, oldest first. A slot
  -- collision (same currency arriving twice) keeps the earliest row — the
  -- oldest operator decision — and drops the later one, with a NOTICE.
  FOR grp IN
    SELECT g.id, g.mt5_group
      FROM trading_product_groups g
     WHERE g.environment = 'demo' AND g.product_id <> demo_id
     ORDER BY g.created_at, g.id
  LOOP
    BEGIN
      UPDATE trading_product_groups SET product_id = demo_id WHERE id = grp.id;
    EXCEPTION WHEN unique_violation THEN
      DELETE FROM trading_product_groups WHERE id = grp.id;
      RAISE NOTICE 'dropped demo group % — its currency is already on the demo product', grp.mt5_group;
    END;
  END LOOP;

  -- Agencies carry real products only. Clears any link the reused 'Demo'
  -- product may have had; new links are refused by the service.
  DELETE FROM agency_products WHERE product_id = demo_id;
END $$;
