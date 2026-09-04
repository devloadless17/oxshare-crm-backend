-- ============================================================================
-- IB LEVELS replace the commission programme catalogue
-- ============================================================================
--
-- A partner's terms are decided by their LEVEL in the partner tree, not by a
-- named programme assigned to them. Level 1 is a partner who introduces clients
-- directly; level 2 is a partner recruited by a level 1; and so on, bounded by
-- `trading_settings.ib_max_levels`.
--
-- Each level carries one commission term and one rebate term, and either may be
-- a percentage of broker revenue or a flat amount per standard lot. The shape
-- the business asked for is:
--
--     level 1  — commission $X per lot,  rebate $Y per lot
--     level 2  — commission N% ,         rebate M%
--
-- ── ⚠️ THIS REVERSES 0102 AND DEVIATES FROM THE FSD ─────────────────────────
--
-- FR-IB-06 commits to "an administrable catalogue of named IB programs (a tier
-- ladder)", each partner "assigned to exactly one named program ... replacing
-- any per-partner bespoke plan". This removes that catalogue from the live path.
--
-- It is done on an explicit instruction repeated after the trade-offs below were
-- put in writing. Recorded here so the next reader finds the decision rather
-- than a contradiction.
--
-- ── WHAT CHANGES ABOUT WHO EARNS WHAT, STATED PLAINLY ───────────────────────
--
-- The chain walk is UNCHANGED: `resolveChain` still climbs `parent_ib_user_id`
-- from the client's introducer upward, so the two rules the business stated
-- still hold by construction —
--
--   * a sub-partner earns NOTHING from their parent's own clients, because they
--     never appear in that chain at all; and
--   * a parent DOES earn from clients introduced beneath them.
--
-- What changes is which number each earner is paid. Under programmes the rate
-- was chosen by DEPTH — how many hops the trade sat below that earner — so one
-- partner could be paid differently on their own clients than on a sub-
-- partner's. Under levels the rate is chosen by the earner's own POSITION IN
-- THE TREE, so a level 1 partner earns their level 1 term on everything that
-- reaches them, however deep.
--
-- That is the behaviour 0102 removed, and it is being restored deliberately: it
-- is what "static per lot for the main partner, percent for the partner under
-- him" actually describes.
--
-- ── THE PROGRAMME TABLES ARE NOT DROPPED, AND THAT IS NOT HESITATION ────────
--
-- `ib_accruals.program_id` records WHICH TERMS PAID every commission already
-- accrued. Dropping `ib_programs` would take that record with it, leaving a
-- ledger of amounts nobody can explain — on rows that have already credited real
-- wallets. The catalogue is removed from every screen and from the accrual path;
-- the tables remain as the audit trail for what was paid before this change.
--
-- New accruals record `level_id` instead. Both columns are nullable so a row
-- carries exactly the one that priced it.

BEGIN;

-- ── The ladder ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ib_levels (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The rung. 1 is a partner introducing clients directly; 2 is one recruited
  -- by a level 1. UNIQUE because a level IS its number — two rows claiming
  -- level 2 is a rate card with no defined answer.
  level                     integer NOT NULL UNIQUE,
  name                      varchar(80) NOT NULL,

  -- Disabling a level stops it paying without deleting the terms that explain
  -- accruals already written against it.
  enabled                   boolean NOT NULL DEFAULT true,

  -- ── What the PARTNER earns ────────────────────────────────────────────────
  commission_mode           ib_payout_mode NOT NULL DEFAULT 'percent',
  commission_rate           numeric(12, 4)  NOT NULL DEFAULT 0,
  commission_amount_per_lot numeric(28, 8),

  -- ── What the CLIENT gets back ─────────────────────────────────────────────
  rebate_mode               ib_payout_mode NOT NULL DEFAULT 'percent',
  rebate_rate               numeric(12, 4)  NOT NULL DEFAULT 0,
  rebate_amount_per_lot     numeric(28, 8),

  -- WHICH revenue a percentage at this level is a share of — FR-IB-16.
  --
  -- Kept per level rather than made a platform constant, because the base is
  -- half of what a partner agreed to: "30% of the spread markup" and "30% of
  -- commission and swap" are different contracts. Ignored entirely by a per-lot
  -- term, which is priced from volume and never from revenue.
  revenue_basis             varchar(30) NOT NULL DEFAULT 'commission_swap',

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_revenue_basis_ck;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_revenue_basis_ck
  CHECK (revenue_basis IN ('commission_swap', 'spread', 'commission_swap_spread'));

COMMENT ON TABLE ib_levels IS
  'The commission ladder. A partner''s terms come from their LEVEL in the partner tree rather '
  'than from an assigned programme — see 0112. Replaces ib_programs on the live path; that '
  'catalogue remains only as the record of what paid historical accruals.';

COMMENT ON COLUMN ib_levels.level IS
  'The rung, and the whole identity of the row. A partner with no parent is level 1; each '
  'recruited partner is one deeper. Bounded by trading_settings.ib_max_levels.';

-- ⚠️ `IS NOT NULL` beside `> 0` is not redundant — a CHECK evaluating to NULL
-- PASSES in Postgres, so `amount > 0` alone accepts a per-lot term with no
-- amount at all. Same trap 0111 hit and the constraint suite caught.
ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_commission_shape;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_commission_shape CHECK (
    (commission_mode = 'percent' AND commission_amount_per_lot IS NULL)
    OR
    (commission_mode = 'per_lot'
      AND commission_amount_per_lot IS NOT NULL
      AND commission_amount_per_lot >= 0)
  );

ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_rebate_shape;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_rebate_shape CHECK (
    (rebate_mode = 'percent' AND rebate_amount_per_lot IS NULL)
    OR
    (rebate_mode = 'per_lot'
      AND rebate_amount_per_lot IS NOT NULL
      AND rebate_amount_per_lot >= 0)
  );

-- A level between 1 and the structural ceiling. Wider than the POLICY ceiling
-- (`ib_max_levels`, default 2) on purpose: raising how deep a broker pays should
-- be a settings change, not a migration.
ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_level_range;
ALTER TABLE ib_levels ADD CONSTRAINT ib_levels_level_range CHECK (level BETWEEN 1 AND 10);

-- Percentages are shares of one revenue figure, so a level cannot hand out more
-- than there is. Per-lot terms are bounded instead at accrual time by
-- `ib_max_payout_per_lot`, where the lot count is known.
ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_share_fits;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_share_fits CHECK (
    (CASE WHEN commission_mode = 'percent' THEN commission_rate ELSE 0 END)
    + (CASE WHEN rebate_mode = 'percent' THEN rebate_rate ELSE 0 END)
    <= 100
  );

-- ── The shape the business asked for, seeded ────────────────────────────────
--
-- Seeded ENABLED but paying nothing where an amount is required, so the ladder
-- exists on the screen from the first boot and an operator fills in the numbers.
-- A zero term accrues nothing and `calculate` says so, which is a visible
-- "not configured yet" rather than a silent one.
INSERT INTO ib_levels (level, name, commission_mode, commission_amount_per_lot,
                       rebate_mode, rebate_amount_per_lot)
VALUES (1, 'Main Partner', 'per_lot', 0, 'per_lot', 0)
ON CONFLICT (level) DO NOTHING;

INSERT INTO ib_levels (level, name, commission_mode, commission_rate,
                       rebate_mode, rebate_rate)
VALUES (2, 'Sub Partner', 'percent', 0, 'percent', 0)
ON CONFLICT (level) DO NOTHING;

-- ── Accruals record which LEVEL paid them ───────────────────────────────────

ALTER TABLE ib_accruals
  ADD COLUMN IF NOT EXISTS level_id uuid REFERENCES ib_levels (id) ON DELETE RESTRICT;

COMMENT ON COLUMN ib_accruals.level_id IS
  'Which level''s terms produced this accrual. NULL on rows written before 0112, which carry '
  'program_id instead — a row records exactly the one that priced it.';

-- `program_id` was NOT NULL and cannot stay so: nothing writes a programme any
-- more. Existing rows keep theirs, which is the entire point of not dropping
-- the catalogue.
ALTER TABLE ib_accruals ALTER COLUMN program_id DROP NOT NULL;

-- ── The agency stops carrying a default programme ───────────────────────────
--
-- It existed so partners appointed under an agency landed on that agency's
-- terms. Levels are derived from tree position, so there is nothing to choose.

ALTER TABLE agencies DROP COLUMN IF EXISTS default_program_id;

-- ── A partner no longer names a programme ───────────────────────────────────
--
-- Kept as a nullable column rather than dropped, for the same reason the
-- catalogue is kept: it says which terms a partner WAS on before this change,
-- which is the only way to explain their historical accruals.

ALTER TABLE ib_accounts ALTER COLUMN program_id DROP NOT NULL;

-- ── A partner carries their RUNG again ──────────────────────────────────────
--
-- `ib_accounts.level` existed before 0102 and went with the old ladder. It is
-- back, because terms are chosen by it: a partner with no parent is level 1, and
-- each partner recruited by them is one deeper.
--
-- STORED rather than derived on every trade. It could be computed by walking
-- `parent_ib_user_id` to the root, but that is a recursive query per earner per
-- deal on the money path — and the answer only changes when somebody is
-- appointed, which is exactly when it is cheap to write.

ALTER TABLE ib_accounts
  ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN ib_accounts.level IS
  'The partner''s rung in the tree, and therefore which ib_levels row pays them. 1 has no parent; '
  'each recruited partner is one deeper. Written at approval from the parent''s level — see 0112.';

ALTER TABLE ib_accounts DROP CONSTRAINT IF EXISTS ib_accounts_level_range;
ALTER TABLE ib_accounts ADD CONSTRAINT ib_accounts_level_range CHECK (level BETWEEN 1 AND 10);

-- Backfill from the tree that already exists. A recursive walk rather than a
-- flat "everyone is 1": partners recruited by other partners are already linked
-- through `parent_ib_user_id`, and defaulting them all to level 1 would put
-- every sub-partner on the main partner's terms the moment this deploys.
WITH RECURSIVE tree AS (
  SELECT user_id, 1 AS lvl
    FROM ib_accounts
   WHERE parent_ib_user_id IS NULL
  UNION ALL
  SELECT child.user_id, parent.lvl + 1
    FROM ib_accounts child
    JOIN tree parent ON child.parent_ib_user_id = parent.user_id
   -- The structural ceiling, so a cycle in the data cannot spin this forever.
   WHERE parent.lvl < 10
)
UPDATE ib_accounts a
   SET level = tree.lvl
  FROM tree
 WHERE a.user_id = tree.user_id;

COMMENT ON COLUMN ib_accounts.program_id IS
  'HISTORICAL ONLY since 0112. A partner''s terms now come from their level in the tree — see '
  'ib_levels. Retained so accruals written before the change can be explained.';

-- ── The keys that opened a screen that no longer exists ─────────────────────
--
-- `ib.programs.create` / `.edit` / `.delete` are enforced by no route after
-- this. Left in place they would sit on the Roles screen as three grantable
-- powers over nothing, and `permission-drift.ts` would report them as catalog
-- drift on every boot.
--
-- Whoever held them is granted the LEVEL equivalent, because that is what
-- replaced the surface: an operator who could shape the rate card can still
-- shape the rate card. Silently narrowing somebody's access during a refactor
-- is a privilege change nobody asked for.
--
-- This is 0104's remap run backwards, and the symmetry is not a coincidence —
-- that migration moved `ib.levels.*` onto `ib.programs.*` when the catalogue
-- replaced the ladder. Its comments explain every choice repeated here.
--
-- All four stores, for 0044's reason: a key left in `api_keys` or
-- `admin_invites` is silent and lasts until a nightly job 403s.
--
-- ⚠️ NO `pg_temp` HELPER — 0068 earned that warning and every migration since
-- has repeated it. `pg_temp` is session-local and the runner does not guarantee
-- one session per migration, so a factored-out helper can vanish between its
-- creation and the statements using it, each of which then succeeds against
-- zero rows rather than failing loudly. The expression is repeated in full.

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
          WHERE e.v NOT IN ('ib.programs.create', 'ib.programs.edit', 'ib.programs.delete')
         UNION SELECT * FROM unnest(
           CASE WHEN permissions ?| ARRAY['ib.programs.create', 'ib.programs.edit', 'ib.programs.delete']
                THEN ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete']
                ELSE ARRAY[]::text[]
           END
         )
       ) keys(k)
   )
 WHERE permissions ?| ARRAY['ib.programs.create', 'ib.programs.edit', 'ib.programs.delete'];

UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
          WHERE e.v NOT IN ('ib.programs.create', 'ib.programs.edit', 'ib.programs.delete')
         UNION SELECT * FROM unnest(
           CASE WHEN permissions ?| ARRAY['ib.programs.create', 'ib.programs.edit', 'ib.programs.delete']
                THEN ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete']
                ELSE ARRAY[]::text[]
           END
         )
       ) keys(k)
   )
 WHERE permissions ?| ARRAY['ib.programs.create', 'ib.programs.edit', 'ib.programs.delete'];

UPDATE admin_invites
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
          WHERE e.v NOT IN ('ib.programs.create', 'ib.programs.edit', 'ib.programs.delete')
         UNION SELECT * FROM unnest(
           CASE WHEN permissions ?| ARRAY['ib.programs.create', 'ib.programs.edit', 'ib.programs.delete']
                THEN ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete']
                ELSE ARRAY[]::text[]
           END
         )
       ) keys(k)
   )
 WHERE permissions ?| ARRAY['ib.programs.create', 'ib.programs.edit', 'ib.programs.delete'];

-- API KEYS ARE NARROWED, NOT REMAPPED, and that asymmetry is deliberate.
--
-- 0087 declined to WIDEN a machine credential on the same reasoning, and 0104
-- repeated it: nobody asked an integration to rewrite partner economics, and a
-- machine credential that quietly gains a power is found during an incident
-- rather than during a review. Removing a dead key is the opposite kind of
-- change and is safe; handing the key's successor to a script is not.
UPDATE api_keys
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(k)
      WHERE e.k NOT IN ('ib.programs.create', 'ib.programs.edit', 'ib.programs.delete')
   )
 WHERE permissions ?| ARRAY['ib.programs.create', 'ib.programs.edit', 'ib.programs.delete'];

-- Every "who stands on this rung" read goes through this: the count beside each
-- level on the ladder screen, and the refusal to disable or delete one that
-- partners are on.
--
-- COMPOUND, with the paging tiebreaker in it, and shaped like 0037's
-- `ib_accounts_approved_at_user_idx` for the reason that one is: the list is
-- ordered `level DESC, user_id DESC`, and an index on `level` alone leaves the
-- planner an Incremental Sort to resolve the ties. `level` has a handful of
-- distinct values across the whole table, so those ties are the norm rather
-- than the exception — which is exactly the case where the second column earns
-- its place.
--
-- Unlike `referral_code`, which needs no such index: its UNIQUE constraint
-- makes the tiebreaker unreachable, so ordering by it can never tie.
CREATE INDEX IF NOT EXISTS ib_accounts_level_user_idx
  ON ib_accounts (level DESC, user_id DESC);

COMMIT;
