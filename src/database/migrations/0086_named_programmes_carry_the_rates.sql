-- ─────────────────────────────────────────────────────────────────────────────
-- Named IB programmes: the record FR-IB-05, FR-IB-06 and FR-IB-16 all hang off.
--
-- Until now a partner's economics came from their RUNG: `ib_levels` maps a level
-- number to one percentage, so every level-1 partner is paid identically and
-- there is nowhere at all to put a client rebate. The FSD asks for something
-- different — "each IB sits on a named program driving commission/rebate", with
-- a mode deciding which legs pay.
--
-- ## The rates are per DEPTH, not per rung
--
-- `level1_rate` is what this partner earns from their OWN clients; `level2_rate`
-- is what they earn from a sub-partner's clients. That is what "level 1 / level
-- 2 commission" means everywhere in this industry, and it is what makes a
-- programme portable: the same programme pays the same way wherever in a chain
-- its holder happens to stand.
--
-- The old ladder keyed the rate on the rung the earner OCCUPIES, which answers a
-- different question and cannot express "I pay my sub-IBs' business at 10%".
--
-- ## Seeded from the live ladder, so no number moves
--
-- The Default programme copies the enabled level-1 and level-2 rates as they
-- stand and every existing partner is placed on it. Commission paid the day
-- after this migration is identical to the day before; the operator changes the
-- economics when the operator decides to, not because a migration ran.
--
-- An empty ladder seeds 0/0, which is the behaviour an empty ladder already has:
-- `calculate` skips a level with no configured terms and nobody earns. Inventing
-- 60/40 here would put rates into a broker's system that nobody chose.
--
-- ## `ib_levels` is NOT dropped
--
-- It still owns placement — which rung a partner is on, what it is called, and
-- whether new partners may be placed there. Only the RATE moves. Dropping it
-- would take the ladder's names and its enabled flag with it.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "ib_program_mode" AS ENUM('commission_only', 'rebate_only', 'hybrid');
--> statement-breakpoint

CREATE TABLE "ib_programs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(80) NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "mode" "ib_program_mode" DEFAULT 'commission_only' NOT NULL,
  "level1_rate" numeric(12, 4) DEFAULT '0' NOT NULL,
  "level2_rate" numeric(12, 4) DEFAULT '0' NOT NULL,
  "rebate_rate" numeric(12, 4) DEFAULT '0' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ib_programs_name_unique" UNIQUE("name"),
  CONSTRAINT "ib_programs_rates_non_negative" CHECK (
    "level1_rate" >= 0 AND "level2_rate" >= 0 AND "rebate_rate" >= 0
  ),
  -- THE BROKER'S FLOOR, in the schema rather than in everyone's memory. Every
  -- leg is a share of the same revenue, so they add: a programme paying 70 + 30
  -- + a 10 rebate hands out 110% of what the house earned on that trade. The
  -- app's own cap (`ibMaxRevenueSharePct`) scales below this; this is the line
  -- past which no configuration is allowed to go at all.
  CONSTRAINT "ib_programs_share_fits" CHECK (
    "level1_rate" + "level2_rate" + "rebate_rate" <= 100
  )
);
--> statement-breakpoint

-- The Default programme, carrying the ladder's current economics.
INSERT INTO "ib_programs" ("name", "sort_order", "mode", "level1_rate", "level2_rate", "rebate_rate")
SELECT
  'Default',
  0,
  'commission_only',
  COALESCE((SELECT "rate_value" FROM "ib_levels" WHERE "level" = 1 AND "enabled"), 0),
  COALESCE((SELECT "rate_value" FROM "ib_levels" WHERE "level" = 2 AND "enabled"), 0),
  0;
--> statement-breakpoint

ALTER TABLE "ib_accounts" ADD COLUMN "program_id" uuid;
--> statement-breakpoint

-- `restrict`: a programme with partners standing on it is not deletable. Same
-- rule the level ladder already carries, and for the same reason — deleting the
-- terms out from under somebody who is being paid by them is data loss.
ALTER TABLE "ib_accounts"
  ADD CONSTRAINT "ib_accounts_program_id_ib_programs_id_fk"
  FOREIGN KEY ("program_id") REFERENCES "ib_programs"("id") ON DELETE restrict;
--> statement-breakpoint

UPDATE "ib_accounts"
   SET "program_id" = (SELECT "id" FROM "ib_programs" WHERE "name" = 'Default')
 WHERE "program_id" IS NULL;
--> statement-breakpoint

-- NOT NULL only after the backfill: FR-IB-06 says each partner sits on exactly
-- one programme, and a nullable column would leave "no programme" as a state the
-- engine has to have an opinion about on every trade.
ALTER TABLE "ib_accounts" ALTER COLUMN "program_id" SET NOT NULL;
--> statement-breakpoint

-- ── The rebate leg needs a row of its own ────────────────────────────────────
--
-- A rebate is owed to the CLIENT, not to the partner, but it is produced by the
-- same event, matures through the same settlement window, and must be as
-- idempotent as a commission. So it is an accrual with a different `kind` and a
-- different beneficiary at confirmation, rather than a second table that would
-- need its own copy of all three properties.
--
-- `ib_user_id` on a rebate row is the partner whose programme produced it —
-- the attribution, not the beneficiary. `client_user_id` is who gets paid.
CREATE TYPE "ib_accrual_kind" AS ENUM('commission', 'rebate');
--> statement-breakpoint

ALTER TABLE "ib_accruals" ADD COLUMN "kind" "ib_accrual_kind" DEFAULT 'commission' NOT NULL;
--> statement-breakpoint

-- The uniqueness guarantee gains `kind`. Without it a deal's rebate row and its
-- commission row collide on (source, source_id, ib_user_id) and the second one
-- is silently dropped by the ON CONFLICT — which would look exactly like a
-- working rebate that never pays.
ALTER TABLE "ib_accruals" DROP CONSTRAINT IF EXISTS "ib_accruals_source_earner_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "ib_accruals_source_earner_uq";
--> statement-breakpoint
ALTER TABLE "ib_accruals"
  ADD CONSTRAINT "ib_accruals_source_earner_uq"
  UNIQUE ("source_type", "source_id", "ib_user_id", "kind");
