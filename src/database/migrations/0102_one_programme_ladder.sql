-- ─────────────────────────────────────────────────────────────────────────────
-- ONE catalogue of terms, with the ladder inside it. `ib_levels` is dropped.
--
-- FR-IB-06 asks for "an administrable catalogue of named IB programs (a tier
-- ladder), each defining a name, ordering position, commission and rebate
-- values, and a mode", and says a programme replaces "any per-partner bespoke
-- plan". FR-IB-17 says the per-level split is "configured per the agreed program
-- ladder". That is one catalogue. This schema had two.
--
-- ── What `ib_levels` still was, and why keeping it cost more than it paid ────
--
-- 0086 moved every rate onto named programmes and 0084 placed every partner on
-- one. What the ladder held afterwards was a rung NAME, an `enabled` flag, and a
-- `rate_value` that decided nothing — a column that reads exactly like the
-- number a partner is paid by, sitting one join away from the number that
-- actually pays them. `backend/CLAUDE.md` had to carry the sentence "do not read
-- it as what anybody earns", which is the documentation you write when a schema
-- is lying.
--
-- The flag was doing real work, and that is the part worth naming: it bounded
-- the hierarchy. `resolveLevel` refused to place a partner below the deepest
-- enabled rung, so "how many levels may exist" was a platform-wide setting that
-- happened to live in a table of rates. FR-IB-17 puts that decision somewhere
-- else — on the programme — and this migration moves it there.
--
-- ── The ladder becomes `ib_program_tiers`, keyed on DEPTH ────────────────────
--
-- One row per depth per programme. `depth = 1` is the partner who introduced
-- the trading client, `depth = 2` is that partner's parent, upward from there.
-- The ROW COUNT is how far that programme's earnings reach, so extending a
-- programme by one level is inserting one row rather than editing a constant in
-- a source file — which is what FR-IB-16 means by the agreed method being
-- CONFIGURED.
--
-- This replaces `level1_rate` / `level2_rate`, whose fixed pair of columns wrote
-- the two-level cap into the schema. The engine's matching `MAX_CHAIN_DEPTH = 2`
-- and `ib_accruals_depth_range` did the same thing twice more, so a broker
-- asking for three levels needed a migration, an engine change, and a constant
-- edit — and got a failed INSERT if anyone missed the third.
--
-- ── Nothing moves economically ──────────────────────────────────────────────
--
-- Each existing programme's `level1_rate` becomes its depth-1 tier and
-- `level2_rate` its depth-2 tier. A rate of zero produces NO ROW: under the new
-- model a tier is a claim that this programme reaches that depth, and a
-- zero-rate tier claims a reach that pays nothing. `calculate` already skipped a
-- zero rate and said so, so omitting the row is the same behaviour with a
-- schema that agrees with it.
--
-- The commission paid the day after this migration is the commission paid the
-- day before. The operator changes the economics when the operator decides to,
-- not because a migration ran.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The tier ladder ──────────────────────────────────────────────────────

CREATE TABLE "ib_program_tiers" (
  "program_id" uuid NOT NULL,
  "depth" integer NOT NULL,
  "rate" numeric(12, 4) DEFAULT '0' NOT NULL,
  -- (programme, depth) IS the identity. A programme paying two rates at depth 2
  -- is not a row anybody could interpret, so there is no surrogate key to let it
  -- exist.
  CONSTRAINT "ib_program_tiers_program_id_depth_pk" PRIMARY KEY ("program_id", "depth"),
  -- A tier that pays nothing is not a configured zero — it is a row that should
  -- not exist. The row COUNT is this programme's reach, so a zero at depth 3
  -- claims a reach the programme does not have and strands depth 4 beneath it.
  CONSTRAINT "ib_program_tiers_rate_positive" CHECK ("rate" > 0),
  -- Matches `MAX_CHAIN_DEPTH` and `ib_accruals_depth_range`. A cycle guard, not
  -- a policy: how far earnings travel is the tier count, not this bound.
  CONSTRAINT "ib_program_tiers_depth_range" CHECK ("depth" BETWEEN 1 AND 10)
);
--> statement-breakpoint

-- CASCADE, unlike almost every reference in this schema. A tier is not a record
-- of something that happened; it is a line of a rate card, meaningless without
-- the card. The PROGRAMME is still `restrict`-protected by
-- `ib_accounts.program_id`, so this cascade is only ever reached for a programme
-- nobody stands on.
ALTER TABLE "ib_program_tiers"
  ADD CONSTRAINT "ib_program_tiers_program_id_ib_programs_id_fk"
  FOREIGN KEY ("program_id") REFERENCES "ib_programs"("id") ON DELETE cascade;
--> statement-breakpoint

-- ── 2. Carry the existing rates across, unchanged ───────────────────────────

INSERT INTO "ib_program_tiers" ("program_id", "depth", "rate")
SELECT "id", 1, "level1_rate" FROM "ib_programs" WHERE "level1_rate" > 0;
--> statement-breakpoint

INSERT INTO "ib_program_tiers" ("program_id", "depth", "rate")
SELECT "id", 2, "level2_rate" FROM "ib_programs" WHERE "level2_rate" > 0;
--> statement-breakpoint

-- A programme whose rates were BOTH zero now has no tiers, and that is correct
-- rather than a gap: it paid nobody before and pays nobody now. The service
-- refuses to save such a programme going forward (`assertModeIsPayable`), but a
-- row already in the database is not rewritten by a migration inventing a number
-- the broker never chose. `rebate_only` programmes legitimately have no tiers.

-- ── 3. The per-trade ceiling moves from a CHECK to a constraint trigger ─────
--
-- `ib_programs_share_fits` summed three columns on one row. The rates are rows
-- in another table now, and a CHECK cannot see them.
--
-- ⚠️ READ WHAT THIS GUARANTEES, because it is narrower than what it replaced.
--
-- It bounds ONE PROGRAMME's own tiers plus its rebate. On a single trade the
-- earners may hold DIFFERENT programmes — the introducer's depth-1 tier, their
-- parent's depth-2 tier, the introducer's rebate — so no per-programme rule can
-- bound what one trade pays out in total. That guarantee is `checkPlausible` in
-- the engine, which refuses an accrual set exceeding the revenue, plus
-- `ibMaxRevenueSharePct`, which scales the legs pro rata beneath it.
--
-- This is the configuration-time floor: it catches the operator typing 70 at
-- every depth of a five-tier programme, at the moment they can still fix it.
CREATE OR REPLACE FUNCTION "ib_programs_assert_share_fits"() RETURNS trigger AS $$
DECLARE
  target uuid;
  total  numeric(14, 4);
BEGIN
  target := COALESCE(NEW."program_id", OLD."program_id");

  SELECT COALESCE(SUM(t."rate"), 0) + COALESCE(MAX(p."rebate_rate"), 0)
    INTO total
    FROM "ib_programs" p
    LEFT JOIN "ib_program_tiers" t ON t."program_id" = p."id"
   WHERE p."id" = target;

  IF total > 100 THEN
    /*
     * `USING CONSTRAINT` is what makes this indistinguishable from a CHECK to
     * every caller. Without it the error carries no `constraint` field, so the
     * exception filter reports it as an unhandled 500 rather than as the
     * refusal it is — and a test asserting "which constraint refused this" has
     * nothing to read.
     */
    RAISE EXCEPTION
      'IB programme % pays out % of the broker''s revenue across its tiers and rebate; the total cannot exceed 100%%',
      target, total || '%'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ib_program_tiers_share_fits';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- DEFERRABLE INITIALLY DEFERRED, and that is load-bearing.
--
-- Editing a ladder rewrites its rows: the service deletes the tiers and inserts
-- the new set in one transaction. Checked per statement, swapping 60/40 for
-- 40/60 fires mid-rewrite against a half-written ladder and refuses an edit that
-- is valid at both ends. Deferred, it is asked once at COMMIT — which is the
-- only moment the question has a meaningful answer.
CREATE CONSTRAINT TRIGGER "ib_program_tiers_share_fits"
  AFTER INSERT OR UPDATE OR DELETE ON "ib_program_tiers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ib_programs_assert_share_fits"();
--> statement-breakpoint

-- The rebate is on the programme, so changing IT can breach the same ceiling
-- without any tier being touched.
CREATE OR REPLACE FUNCTION "ib_programs_rebate_share_fits"() RETURNS trigger AS $$
DECLARE
  total numeric(14, 4);
BEGIN
  SELECT COALESCE(SUM("rate"), 0) + NEW."rebate_rate"
    INTO total
    FROM "ib_program_tiers"
   WHERE "program_id" = NEW."id";

  IF total > 100 THEN
    RAISE EXCEPTION
      'IB programme % pays out % of the broker''s revenue across its tiers and rebate; the total cannot exceed 100%%',
      NEW."id", total || '%'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ib_programs_rebate_share_fits';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "ib_programs_rebate_share_fits"
  AFTER INSERT OR UPDATE OF "rebate_rate" ON "ib_programs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ib_programs_rebate_share_fits"();
--> statement-breakpoint

-- ── 4. The fixed pair of rate columns goes ──────────────────────────────────
--
-- Both CHECKs named them, and Postgres would drop the constraints with the
-- columns. Dropped explicitly so the intent is in the migration rather than in
-- a reader's memory of what DROP COLUMN implies.
ALTER TABLE "ib_programs" DROP CONSTRAINT IF EXISTS "ib_programs_share_fits";
--> statement-breakpoint
ALTER TABLE "ib_programs" DROP CONSTRAINT IF EXISTS "ib_programs_rates_non_negative";
--> statement-breakpoint

ALTER TABLE "ib_programs" DROP COLUMN "level1_rate";
--> statement-breakpoint
ALTER TABLE "ib_programs" DROP COLUMN "level2_rate";
--> statement-breakpoint

-- The rebate keeps a floor of its own; only its ceiling moved to the trigger.
ALTER TABLE "ib_programs"
  ADD CONSTRAINT "ib_programs_rebate_non_negative" CHECK ("rebate_rate" >= 0);
--> statement-breakpoint

-- ── 5. An accrual records the PROGRAMME that paid it, not a rung ────────────
--
-- `level` stored the rung the earner stood on, "so an accrual stays explainable
-- against the hierarchy as it was when earned". Since 0084 the rung explained
-- nothing — the programme decided the rate — so the row preserved an answer to
-- a question nobody could still ask, while WHICH TERMS PAID THIS was recoverable
-- only by reading the partner's CURRENT programme: the one thing most likely to
-- have changed since.
--
-- With `program_id`, `depth` and `rate_value` together, a disputed payout is
-- settled from the row alone.
ALTER TABLE "ib_accruals" ADD COLUMN "program_id" uuid;
--> statement-breakpoint

ALTER TABLE "ib_accruals"
  ADD CONSTRAINT "ib_accruals_program_id_ib_programs_id_fk"
  FOREIGN KEY ("program_id") REFERENCES "ib_programs"("id") ON DELETE restrict;
--> statement-breakpoint

-- Backfill what is recoverable: the programme the earner is on TODAY. That is a
-- guess about the past and is only made where the partner still holds an
-- account. It stays NULLABLE for exactly that reason — NOT NULL would force a
-- fabricated value onto every row this cannot honestly resolve, and a NULL here
-- reads as "accrued before the column existed", which is true, rather than as
-- "paid by no terms", which never happens.
UPDATE "ib_accruals" a
   SET "program_id" = c."program_id"
  FROM "ib_accounts" c
 WHERE c."user_id" = a."ib_user_id"
   AND a."program_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "ib_accruals" DROP COLUMN "level";
--> statement-breakpoint

-- 1..10, widened from 1..2. The old bound wrote the two-level cap into the
-- database, and would have turned FR-IB-17's multi-level distribution into a
-- failed INSERT at depth 3 — the worst place to meet a ceiling, because the
-- statement carries every legitimate earner on the same trade down with it.
ALTER TABLE "ib_accruals" DROP CONSTRAINT IF EXISTS "ib_accruals_depth_range";
--> statement-breakpoint
ALTER TABLE "ib_accruals"
  ADD CONSTRAINT "ib_accruals_depth_range" CHECK ("depth" >= 1 AND "depth" <= 10);
--> statement-breakpoint

-- ── 6. A partner's placement is their PARENT, and nothing else ──────────────
--
-- `ib_accounts.level` named a rung in a table that is about to not exist. What
-- remains is `parent_ib_user_id`, which is the real structure: a partner's DEPTH
-- is a fact about the trade being paid on — how many hops above the client they
-- stand — not a number stored against them. Keeping both let the two disagree,
-- and only one of them was ever the one the money used.
--
-- The FK and `ib_accounts_level_idx` drop with the column.
ALTER TABLE "ib_accounts" DROP COLUMN "level";
--> statement-breakpoint

-- "Who is on these terms?" — asked before a programme may be disabled or
-- deleted, and to report the partner count beside each programme (FR-IB-06).
-- Previously served incidentally by scanning; a real index now that the level
-- index it sat beside is gone.
CREATE INDEX IF NOT EXISTS "ib_accounts_program_idx" ON "ib_accounts" ("program_id");
--> statement-breakpoint

-- ── 7. The second catalogue ─────────────────────────────────────────────────

DROP TABLE "ib_levels";
--> statement-breakpoint

-- ── 8. The keys that opened a screen that no longer exists ──────────────────
--
-- `ib.levels.create` / `.edit` / `.delete` are enforced by no route after this.
-- Left in place they would sit in the Roles screen as three grantable powers
-- over nothing, and `permission-drift.ts` would report them as catalog drift on
-- every boot.
--
-- Whoever held them is granted the PROGRAMME equivalent, because that is what
-- replaced the surface — an operator who could shape the ladder can still shape
-- the ladder, and silently narrowing somebody's access during a refactor is a
-- privilege change nobody asked for. `ib.programs.*` was already granted to
-- `Administrator` by 0087; this covers every OTHER role that held the level keys.
--
-- All four stores, for 0044's reason: a key left in `api_keys` or
-- `admin_invites` is silent and lasts until a nightly job 403s.
--
-- ⚠️ NO `pg_temp` HELPER — 0068 earned that warning and 0075, 0085 and 0087 all
-- repeat it. `pg_temp` is session-local and the runner does not guarantee one
-- session per migration, so a factored-out helper can vanish between its
-- creation and the statements using it, each of which then succeeds against zero
-- rows rather than failing loudly. The expression is repeated in full.

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
          WHERE e.v NOT IN ('ib.levels.create', 'ib.levels.edit', 'ib.levels.delete')
         UNION SELECT * FROM unnest(
           CASE WHEN permissions ?| ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete']
                THEN ARRAY['ib.programs.create', 'ib.programs.edit', 'ib.programs.delete']
                ELSE ARRAY[]::text[]
           END
         )
       ) keys(k)
   )
 WHERE permissions ?| ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete'];
--> statement-breakpoint

UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
          WHERE e.v NOT IN ('ib.levels.create', 'ib.levels.edit', 'ib.levels.delete')
         UNION SELECT * FROM unnest(
           CASE WHEN permissions ?| ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete']
                THEN ARRAY['ib.programs.create', 'ib.programs.edit', 'ib.programs.delete']
                ELSE ARRAY[]::text[]
           END
         )
       ) keys(k)
   )
 WHERE permissions ?| ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete'];
--> statement-breakpoint

UPDATE admin_invites
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k
           FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
          WHERE e.v NOT IN ('ib.levels.create', 'ib.levels.edit', 'ib.levels.delete')
         UNION SELECT * FROM unnest(
           CASE WHEN permissions ?| ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete']
                THEN ARRAY['ib.programs.create', 'ib.programs.edit', 'ib.programs.delete']
                ELSE ARRAY[]::text[]
           END
         )
       ) keys(k)
   )
 WHERE permissions ?| ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete'];
--> statement-breakpoint

-- API KEYS ARE NARROWED, NOT REMAPPED, and that asymmetry is deliberate.
--
-- 0087 declined to WIDEN a machine credential on the same reasoning: nobody
-- asked an integration to rewrite partner economics, and a machine credential
-- that quietly gains a power is found during an incident rather than a review.
-- Removing a dead key is the opposite kind of change and is safe; handing the
-- key's successor to a script is not.
UPDATE api_keys
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(k)
      WHERE e.k NOT IN ('ib.levels.create', 'ib.levels.edit', 'ib.levels.delete')
   )
 WHERE permissions ?| ARRAY['ib.levels.create', 'ib.levels.edit', 'ib.levels.delete'];
