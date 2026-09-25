-- ============================================================================
-- COMMISSION TYPES price the PRODUCT; a level is a SHARE of them
-- ============================================================================
--
-- Asked for directly (25 Sep 2026): "remove the spread from the product, add a
-- commission type under Partners — different types of commission and rebate
-- that we assign to products as a type — and handle the split between sub-IBs
-- as a percentage depending on the level".
--
-- ── WHAT MOVES WHERE ────────────────────────────────────────────────────────
--
--   before (0117)                          after (0140)
--   ─────────────────────────────────────  ──────────────────────────────────────
--   ib_levels.commission_amount_per_lot    ib_commission_types.commission_per_lot
--   ib_levels.rebate_amount_per_lot        ib_commission_types.rebate_per_lot
--   (one ladder = one product's terms)     trading_products.commission_type_id
--   ib_levels.commission_rate (unused, 0)  ib_levels.commission_share  (% of the type)
--   ib_levels.rebate_rate     (unused, 0)  ib_levels.rebate_share      (% of the type)
--   trading_products.spread_markup_per_lot GONE, with the `spread` revenue basis
--
-- A rung held an ABSOLUTE amount, so the ladder described exactly one product.
-- The moment two products are sold on different terms a rung has no single
-- number to hold. The absolute figures now live on a named COMMISSION TYPE, a
-- product points at the type it is sold on, and a rung takes a PERCENTAGE of
-- whatever the product says — one ladder pricing the whole catalogue.
--
-- ── WHAT DOES NOT CHANGE ────────────────────────────────────────────────────
--
-- The chain walk, and the rule that a rung is paid its own share on everything
-- beneath it, however deep (0112). And 0114's rule that the shares are
-- INDEPENDENT: on a sub-partner's client's trade, level 2 takes its share AND
-- level 1 takes its own in full. A ladder of 100% / 30% on a $10 type is
-- exactly the old "$10 to the main partner, $3 to the sub".
--
-- ── EXISTING ROWS ARE CONVERTED, NOT REFUSED ────────────────────────────────
--
-- One type named 'Default' is created from the amounts the ladder carried, and
-- every REAL product that has no type yet is put on it — so no product changes
-- what it pays on the day this lands. Each rung's share is its old amount as a
-- percentage of the LARGEST amount on the ladder for that leg (so every share
-- fits in 0..100):
--
--     commission: level 1 $10, level 2 $3   →  type $10;  shares 100% / 30%
--     rebate:     level 1 $2,  level 2 $3   →  type $3;   shares 66.6667% / 100%
--
-- ⚠️ A share is rounded to FOUR decimal places, so a ratio like 2/3 is
-- carried as 66.6667% and prices $2.000001 on a $3 rebate — a millionth of a
-- dollar a lot from what that rung paid before. Stated here rather than hidden:
-- review the ladder and the type after migrating, because the whole model
-- changed and the numbers were always going to be re-decided.
--
-- A ladder carrying NO amounts at all (a fresh database — 0112 seeds both rungs
-- at zero) gets no type; level 1 is set to 100% / 100% and deeper rungs to 0%,
-- so a fresh install pays the main partner what the product says the moment a
-- type is assigned, and sub-partner shares are decided deliberately.
--
-- ⚠️ ACCRUALS ARE UNTOUCHED. `ib_accruals.rate_value` holds the RESOLVED figure
-- every row was paid at, and `base_amount` the volume it was priced against;
-- both stay readable. New rows record `commission_type_id` beside `level_id`.
--
-- ⚠️ THE ENUM TYPES SURVIVE. `ib_payout_mode` and `ib_revenue_basis` are still
-- used by the historical `ib_programs` tables, which explain accruals written
-- before 0112 and are not dropped for exactly that reason.
--
-- ⚠️ NO `pg_temp` HELPER (0068). The conversion runs inside ONE DO block so it
-- cannot be split across sessions.
--
-- Re-runnable: every DDL statement is IF [NOT] EXISTS, the renames are guarded
-- by information_schema, and the conversion only runs while the old columns
-- still exist.

BEGIN;

-- ── 1. The rate card ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ib_commission_types (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               varchar(80) NOT NULL UNIQUE,
  description        text,
  enabled            boolean NOT NULL DEFAULT true,
  -- Money per standard lot, NUMERIC(28,8) like every amount here (§6.1).
  commission_per_lot numeric(28, 8) NOT NULL DEFAULT 0,
  rebate_per_lot     numeric(28, 8) NOT NULL DEFAULT 0,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamp with time zone NOT NULL DEFAULT now(),
  updated_at         timestamp with time zone NOT NULL DEFAULT now(),
  -- A typo guard, not a commercial limit: far above any real rate card, well
  -- short of the "1000" typed where "10.00" was meant.
  CONSTRAINT ib_commission_types_commission_range
    CHECK (commission_per_lot >= 0 AND commission_per_lot <= 10000),
  CONSTRAINT ib_commission_types_rebate_range
    CHECK (rebate_per_lot >= 0 AND rebate_per_lot <= 10000)
);

COMMENT ON TABLE ib_commission_types IS
  'What a product pays partners: money per lot for the partners'' commission and for the '
  'client''s rebate. Each ib_levels row takes a percentage of these. Assigned to products '
  'through trading_products.commission_type_id (0140).';

-- ── 2. A product is sold on a type; the spread markup goes ──────────────────

ALTER TABLE trading_products
  ADD COLUMN IF NOT EXISTS commission_type_id uuid
    REFERENCES ib_commission_types (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS trading_products_commission_type_idx
  ON trading_products (commission_type_id);

COMMENT ON COLUMN trading_products.commission_type_id IS
  'The rate card this product pays partners on. NULL means it pays NO partner commission — '
  'a configured state. An account linked to no product at all is refused instead (0140).';

ALTER TABLE trading_products DROP CONSTRAINT IF EXISTS trading_products_spread_markup_ck;
ALTER TABLE trading_products DROP COLUMN IF EXISTS spread_markup_per_lot;

-- ── 3. Accruals record which type priced them ───────────────────────────────

ALTER TABLE ib_accruals
  ADD COLUMN IF NOT EXISTS commission_type_id uuid
    REFERENCES ib_commission_types (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ib_accruals_commission_type_idx
  ON ib_accruals (commission_type_id);

COMMENT ON COLUMN ib_accruals.commission_type_id IS
  'Which commission type''s per-lot amount this accrual is a share of. NULL on rows written '
  'before 0140, which were priced on a level''s own per-lot amount (0140).';

-- ── 4. The ladder: rates become SHARES, amounts move to the type ────────────

ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_commission_shape;
ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_rebate_shape;
ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_share_fits;

DO $$
DECLARE
  pool_commission numeric(28, 8);
  pool_rebate     numeric(28, 8);
  type_id         uuid;
BEGIN
  -- 4a. Rename the rate columns into the shares they become. Guarded so a
  --     re-run finds them already renamed and does nothing.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'ib_levels' AND column_name = 'commission_rate') THEN
    ALTER TABLE ib_levels RENAME COLUMN commission_rate TO commission_share;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'ib_levels' AND column_name = 'rebate_rate') THEN
    ALTER TABLE ib_levels RENAME COLUMN rebate_rate TO rebate_share;
  END IF;

  -- 4b. The conversion, ONLY while the per-lot amounts are still there. On a
  --     re-run they are gone and the shares are whatever an operator has set.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'ib_levels' AND column_name = 'commission_amount_per_lot') THEN
    RETURN;
  END IF;

  -- Dynamic SQL: the column names below stop existing at the end of this
  -- migration, and a statically-referenced column would fail to plan on a
  -- database where step 4c has already run.
  EXECUTE 'SELECT COALESCE(MAX(commission_amount_per_lot), 0), COALESCE(MAX(rebate_amount_per_lot), 0) FROM ib_levels'
     INTO pool_commission, pool_rebate;

  IF pool_commission > 0 OR pool_rebate > 0 THEN
    INSERT INTO ib_commission_types (name, description, commission_per_lot, rebate_per_lot)
    VALUES (
      'Default',
      'Created by migration 0140 from the per-lot amounts the commission levels used to carry. '
      'Every real product was put on it so nothing changed what it pays. Rename it, or add '
      'the types the desk actually sells on and move the products.',
      pool_commission,
      pool_rebate
    )
    ON CONFLICT (name) DO UPDATE
      SET commission_per_lot = EXCLUDED.commission_per_lot,
          rebate_per_lot     = EXCLUDED.rebate_per_lot
    RETURNING id INTO type_id;

    -- Each rung's old amount as a percentage of the largest, four places.
    EXECUTE format(
      'UPDATE ib_levels SET '
      '  commission_share = CASE WHEN %L::numeric > 0 '
      '    THEN round(COALESCE(commission_amount_per_lot, 0) / %L::numeric * 100, 4) ELSE 0 END, '
      '  rebate_share = CASE WHEN %L::numeric > 0 '
      '    THEN round(COALESCE(rebate_amount_per_lot, 0) / %L::numeric * 100, 4) ELSE 0 END',
      pool_commission, pool_commission, pool_rebate, pool_rebate
    );

    -- Real products only: the demo product never accrues, and an agency cannot
    -- carry it, so a type on it would be a number nobody reads.
    UPDATE trading_products
       SET commission_type_id = type_id
     WHERE type = 'real' AND commission_type_id IS NULL;
  ELSE
    -- Nothing was paying. Level 1 takes the whole of whatever type a product is
    -- given; deeper rungs are a decision somebody makes on the levels page.
    UPDATE ib_levels
       SET commission_share = CASE WHEN level = 1 THEN 100 ELSE 0 END,
           rebate_share     = CASE WHEN level = 1 THEN 100 ELSE 0 END;
  END IF;
END $$;

-- 4c. The columns the modes served.
ALTER TABLE ib_levels DROP COLUMN IF EXISTS commission_mode;
ALTER TABLE ib_levels DROP COLUMN IF EXISTS commission_amount_per_lot;
ALTER TABLE ib_levels DROP COLUMN IF EXISTS rebate_mode;
ALTER TABLE ib_levels DROP COLUMN IF EXISTS rebate_amount_per_lot;
ALTER TABLE ib_levels DROP COLUMN IF EXISTS revenue_basis;

ALTER TABLE ib_levels ALTER COLUMN commission_share SET DEFAULT 0;
ALTER TABLE ib_levels ALTER COLUMN commission_share SET NOT NULL;
ALTER TABLE ib_levels ALTER COLUMN rebate_share SET DEFAULT 0;
ALTER TABLE ib_levels ALTER COLUMN rebate_share SET NOT NULL;

-- 4d. A share is a fraction of ONE figure, so it fits in 0..100. There is
--     deliberately NO cross-rung sum (see the schema header): the shares in a
--     chain are paid independently, and `ib_max_payout_per_lot` bounds the
--     total at accrual time, where the lot count is known.
ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_commission_share_range;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_commission_share_range
  CHECK (commission_share >= 0 AND commission_share <= 100);

ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_rebate_share_range;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_rebate_share_range
  CHECK (rebate_share >= 0 AND rebate_share <= 100);

COMMENT ON COLUMN ib_levels.commission_share IS
  'The partner''s percentage of the product''s commission_per_lot (0140). Paid on every trade '
  'that reaches this rung, independently of the shares beneath it.';
COMMENT ON COLUMN ib_levels.rebate_share IS
  'The client''s percentage of the product''s rebate_per_lot (0140), read from the '
  'introducer''s rung only.';

-- ── 5. Permissions: the type keys go to whoever may edit the ladder ─────────
--
-- `ib.commission_types.*` are new keys, and permissions are a STORED SNAPSHOT
-- on each role (see permission-catalog.baseline.json). Whoever holds the level
-- keys is the person who prices partners, so they get the type equivalent —
-- the same reasoning 0112 used when it swapped programme keys for level keys.
-- `permission-drift.ts` tops up the system Administrator role on boot anyway.
--
-- The expression is repeated per table rather than factored into a helper —
-- 0068's `pg_temp` warning, still in force.

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT * FROM unnest(ARRAY[
           CASE WHEN permissions ? 'ib.levels.create' THEN 'ib.commission_types.create' END,
           CASE WHEN permissions ? 'ib.levels.edit'   THEN 'ib.commission_types.edit'   END,
           CASE WHEN permissions ? 'ib.levels.delete' THEN 'ib.commission_types.delete' END
         ]) AS k WHERE k IS NOT NULL
       ) keys(k)
   )
 WHERE permissions ?| ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete'];

UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT * FROM unnest(ARRAY[
           CASE WHEN permissions ? 'ib.levels.create' THEN 'ib.commission_types.create' END,
           CASE WHEN permissions ? 'ib.levels.edit'   THEN 'ib.commission_types.edit'   END,
           CASE WHEN permissions ? 'ib.levels.delete' THEN 'ib.commission_types.delete' END
         ]) AS k WHERE k IS NOT NULL
       ) keys(k)
   )
 WHERE permissions ?| ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete'];

UPDATE admin_invites
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT * FROM unnest(ARRAY[
           CASE WHEN permissions ? 'ib.levels.create' THEN 'ib.commission_types.create' END,
           CASE WHEN permissions ? 'ib.levels.edit'   THEN 'ib.commission_types.edit'   END,
           CASE WHEN permissions ? 'ib.levels.delete' THEN 'ib.commission_types.delete' END
         ]) AS k WHERE k IS NOT NULL
       ) keys(k)
   )
 WHERE permissions ?| ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete'];

COMMIT;
