-- ─────────────────────────────────────────────────────────────────────────────
-- The commission layer is RESET and rebuilt from the Phase 1 FSD.
--
-- `ib_programs` and `ib_program_tiers` are dropped and recreated rather than
-- altered. They had reached their present shape through 0004 → 0033 → 0086 →
-- 0102 → 0103 → 0104 → 0105, and each step was a correction of the one before:
-- rates moved off a level ladder onto programmes, the ladder was folded into
-- the programme, then four settings that competed with it were removed one at
-- a time. The SHAPE that survived is right. The history is not worth carrying,
-- and the seeded economics were never anybody's decision — see the rates below.
--
-- ── What is NOT reset, and why that is not a half-measure ────────────────────
--
-- `ib_applications`, `ib_accounts`, `ib_accruals` and the referral attribution
-- stay. They are not the confused part: FR-IB-11 requires the accrual ledger to
-- be APPEND-ONLY and immutable, FR-IB-14 requires "exactly one durable
-- attribution ... per referred user", and FR-IB-17 requires the stored
-- hierarchy. Dropping a table whose entire specified purpose is that it is
-- never rewritten, in order to rewrite it, would destroy the requirement rather
-- than implement it.
--
-- The two accrual rows in this database are dev fixtures and ARE cleared —
-- their `program_id` points at programmes that stop existing four statements
-- from here, and an earnings row that cannot say what paid it is the exact
-- thing 0102 added that column to prevent. `ledger_entries` is untouched: it is
-- append-only by TRIGGER, and the compensating-entry rule is not suspended
-- because a migration would find it convenient.
--
-- ── What is genuinely new ───────────────────────────────────────────────────
--
--   ib_programs.revenue_basis          FR-IB-16, finally configured where the
--                                      requirement says it lives — in the
--                                      catalogue, not a constant in a source
--                                      file and not the Trading settings form.
--
--   trading_settings.ib_max_total_...  The ceiling on what one trade may cost
--                                      in total. NOT an FSD requirement; it is
--                                      the control every IB platform treats as
--                                      mandatory, and the reason is four lines
--                                      down.
--
-- ── The seeded rates were 60% and 40%, and that is why the cap is back ──────
--
-- One programme existed — "Default" — carrying depth 1 at 60% and depth 2 at
-- 40%. Those numbers arrived in 0086 by COPYING the old `ib_levels` rows, and
-- nothing since has looked at them. They are not a rate card: the two tiers are
-- independent shares of the same broker revenue and they ADD, so any two-deep
-- chain on that programme paid out 100% and the broker kept nothing.
--
-- Nothing refused it. `checkPlausible` refuses a total ABOVE the revenue, and
-- exactly 100% is not above it. The per-programme share trigger allows a sum of
-- 100 for the same reason. The configuration was reachable, silent, and wrong.
--
-- Published cascades are one substantial direct rate with much smaller
-- overrides above it — $7.00 / $1.50 / $0.50 per lot, or $5 with a $2 override
-- — and direct revenue share sits in a 20–40% band. The three programmes seeded
-- below follow that shape. They are a STARTING POINT a broker is expected to
-- edit, which is the difference between a default and a decision.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The total payout ceiling ─────────────────────────────────────────────
--
-- A percentage of the broker's revenue on ONE trade, counting every commission
-- leg plus the client's rebate.
--
-- It is on `trading_settings` and not on a programme deliberately, and this is
-- the same test 0105 applied to `ib_max_levels`: a programme states what ONE
-- partner is paid, and the earners on a single trade may hold different
-- programmes. A per-programme ceiling could not see the other legs, so it could
-- not bound the total — which is the only thing worth bounding. 0104 removed
-- four IB settings from this table because each DUPLICATED the catalogue; this
-- one CONSTRAINS it, and a constraint cannot live inside the thing it bounds.
--
-- 100 is the default: it changes nobody's economics on the day this lands, and
-- it still catches the case that has no legitimate reading — paying out more
-- than the trade earned. A broker protecting margin sets it to 60 or 70.
ALTER TABLE "trading_settings"
  ADD COLUMN IF NOT EXISTS "ib_max_total_payout_pct" numeric(12, 4) DEFAULT '100' NOT NULL;
--> statement-breakpoint

ALTER TABLE "trading_settings" DROP CONSTRAINT IF EXISTS "trading_settings_ib_max_total_payout_ck";
--> statement-breakpoint

ALTER TABLE "trading_settings"
  ADD CONSTRAINT "trading_settings_ib_max_total_payout_ck"
  CHECK ("ib_max_total_payout_pct" > 0 AND "ib_max_total_payout_pct" <= 100);
--> statement-breakpoint

-- ── 2 & 3. The RESET, and it runs ONCE ──────────────────────────────────────
--
-- Everything destructive in this migration is behind one test: does
-- `ib_programs.revenue_basis` already exist? If it does, this migration has
-- already run and the catalogue below is the CURRENT one — carrying real
-- programmes an operator has since edited and real earnings that reference
-- them. Dropping and reseeding at that point is not a reset, it is data loss.
--
-- ⚠️ THIS GUARD IS NOT DEFENSIVE PADDING. backend/CLAUDE.md documents the exact
-- way a migration gets re-applied here: a renumbered migration leaves a
-- database's watermark ahead of the journal, and the repair is to DELETE the
-- bookkeeping row and re-run. A migration that wipes `ib_accruals`
-- unconditionally turns that ordinary repair into a permanent loss of every
-- partner's earnings history.
--
-- What it clears on the FIRST run, and why each is safe there:
--
--   ib_accruals   Every row references a programme that stops existing three
--                 statements later. `program_id` is the record of WHICH TERMS
--                 PAID THIS, and an earnings row that cannot answer that is the
--                 thing 0102 added the column to prevent. On this database that
--                 is two dev fixtures against the 60/40 programme.
--
--                 `ledger_entries` is NOT touched. It is append-only by TRIGGER
--                 and the compensating-entry rule is not suspended because a
--                 migration would find it convenient.
--
--   the two FKs   `ib_accounts` and `ib_accruals` both point at the catalogue
--                 with RESTRICT — which is exactly what stops a programme being
--                 deleted out from under the partners standing on it. Dropped
--                 here and re-added in step 7, RESTRICT again, unchanged.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ib_programs' AND column_name = 'revenue_basis'
  ) THEN
    RAISE NOTICE '0106: the catalogue is already rebuilt; skipping the reset';
    RETURN;
  END IF;

  DELETE FROM "ib_accruals";

  ALTER TABLE "ib_accounts" DROP CONSTRAINT IF EXISTS "ib_accounts_program_id_ib_programs_id_fk";
  ALTER TABLE "ib_accruals" DROP CONSTRAINT IF EXISTS "ib_accruals_program_id_ib_programs_id_fk";

  -- NOT NULL comes off so the partners can let go of a programme that is about
  -- to stop existing. It goes back on in step 7, once every one of them has
  -- been re-seated — FR-IB-06 says each partner sits on "exactly one named
  -- program", and a partner with no terms is a partner nothing can pay.
  ALTER TABLE "ib_accounts" ALTER COLUMN "program_id" DROP NOT NULL;
  UPDATE "ib_accounts" SET "program_id" = NULL;

  DROP TABLE IF EXISTS "ib_program_tiers";
  DROP TABLE IF EXISTS "ib_programs";
END
$$;
--> statement-breakpoint

-- ── 4. The revenue basis vocabulary ─────────────────────────────────────────
--
-- FR-IB-04 and FR-IB-16 both say commission is derived from the SPREAD. This
-- platform computes on MT5's charged commission + swap, because MT5 reports no
-- per-deal spread revenue — there is no figure to compute from and none to
-- check a result against. `trading_products.spread_markup_per_lot` is the
-- desk's own markup and is what a spread basis multiplies.
--
-- ⚠️ THE ORDER IS IRREVERSIBLE. Under `spread`, a product whose markup is still
-- 0 produces zero revenue, and a zero-revenue deal is MARKED DONE rather than
-- retried, because MT5's amounts are final when reported. Selecting this basis
-- before the markups are populated drains the queue paying nothing, for good,
-- and switching back recovers none of it. Nothing can detect the mistake: a
-- zero markup is also a legitimate raw-spread product.
--
-- Which is exactly why the default below is `commission_swap` and why this is a
-- per-programme choice an operator makes on one programme at a time, rather
-- than a platform switch that re-prices every partner at once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ib_revenue_basis') THEN
    CREATE TYPE "ib_revenue_basis" AS ENUM ('commission_swap', 'spread', 'commission_swap_spread');
  END IF;
END
$$;
--> statement-breakpoint

-- ── 5. The catalogue, rebuilt ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ib_programs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- FR-IB-06: "a name". Unique because it is what an operator picks in a list
  -- and what a partner is told they are on; two Golds is an unanswerable
  -- support call.
  "name" varchar(80) NOT NULL UNIQUE,

  -- FR-IB-06: "ordering position". Lowest first, and the lowest ENABLED one is
  -- what a new partner is appointed on when a reviewer expresses no preference.
  "sort_order" integer DEFAULT 0 NOT NULL,

  -- FR-IB-05: "each program shall declare a mode — commission-only,
  -- rebate-only, or hybrid — that determines which legs accrue."
  "mode" "ib_program_mode" DEFAULT 'commission_only' NOT NULL,

  -- FR-IB-05: the rebate is "configurable per program (dynamic, not a fixed
  -- per-lot figure)". A % of the same broker revenue the tiers take theirs
  -- from, on the HEADER rather than per depth: there is exactly one trading
  -- client per trade, standing in exactly one relationship — with their
  -- introducer — so a rebate per depth would be several answers to a question
  -- that has one.
  "rebate_rate" numeric(12, 4) DEFAULT '0' NOT NULL,

  -- FR-IB-16: the commission method, configured in the catalogue. See step 4
  -- for why the default is the status quo and why it is per programme.
  "revenue_basis" "ib_revenue_basis" DEFAULT 'commission_swap' NOT NULL,

  -- FR-IB-06: "flagged as selectable", and it means both halves — a disabled
  -- programme cannot be assigned to a new partner AND stops paying. A switch
  -- that leaves the money flowing is decorative.
  "enabled" boolean DEFAULT true NOT NULL,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- FR-IB-06's "tier ladder" and FR-IB-17's "per-level split ... configured per
-- the agreed program ladder".
--
-- DEPTH IS MEASURED FROM THE CLIENT. `depth = 1` is the partner who introduced
-- the trading client; `depth = 2` is that partner's parent. A row answers "what
-- does the holder earn when the trade belongs to a client N hops below them" —
-- a property of the TERMS, true wherever in a chain the holder stands. A
-- rung-keyed ladder could not say that: a sub-partner who introduced a client
-- themselves took the level-2 rate on their own business, so recruiting
-- somebody quietly cut what they earned.
--
-- THE ROW COUNT IS HOW FAR THIS PROGRAMME REACHES. Two rows pays own clients
-- and sub-partners' and stops. There is no separate depth column that could
-- disagree with the rates.
--
-- HOW MANY rows are allowed is `trading_settings.ib_max_levels` — default 2,
-- per Feature List Rev 9 IB-17: "no level beyond L2" — enforced in the service,
-- because a CHECK cannot count the other rows of its own table.
CREATE TABLE IF NOT EXISTS "ib_program_tiers" (
  "program_id" uuid NOT NULL,
  "depth" integer NOT NULL,

  -- The holder's share of the broker's revenue at this depth, as a %.
  -- NUMERIC, never a float: §6.1 applies to anything that TOUCHES an amount,
  -- and a rate held as a float reintroduces the error one multiplication later.
  "rate" numeric(12, 4) DEFAULT '0' NOT NULL,

  -- (programme, depth) IS the identity. A programme paying two different rates
  -- at depth 2 is not a row anybody could interpret.
  CONSTRAINT "ib_program_tiers_pk" PRIMARY KEY ("program_id", "depth"),

  -- A tier that pays nothing is not a configured zero — it is a row that should
  -- not exist. The row count is the programme's reach, so a zero at depth 2
  -- claims a reach the programme does not have.
  CONSTRAINT "ib_program_tiers_rate_positive" CHECK ("rate" > 0),

  -- Bounded to what `ib_accruals_depth_range` and the engine's cycle guard
  -- store. Wider than `ib_max_levels` on purpose: raising the ceiling is then a
  -- form, not a migration.
  CONSTRAINT "ib_program_tiers_depth_range" CHECK ("depth" BETWEEN 1 AND 10)
);
--> statement-breakpoint

-- CASCADE, unlike almost every reference in this schema: a tier is not a record
-- of something that happened, it is a line of a rate card and is meaningless
-- without the card. The programme itself is not cascaded into —
-- `ib_accounts.program_id` is `restrict`, so a programme partners stand on
-- cannot be deleted at all, and this is only ever reached for one nobody is on.
ALTER TABLE "ib_program_tiers"
  DROP CONSTRAINT IF EXISTS "ib_program_tiers_program_id_ib_programs_id_fk";
--> statement-breakpoint

ALTER TABLE "ib_program_tiers"
  ADD CONSTRAINT "ib_program_tiers_program_id_ib_programs_id_fk"
  FOREIGN KEY ("program_id") REFERENCES "ib_programs"("id") ON DELETE cascade;
--> statement-breakpoint

-- ── 6. Seed a catalogue that is a rate card ─────────────────────────────────
--
-- Three programmes, differing mainly in the direct rate. The override barely
-- moves, which is the whole shape: a partner earns most on the clients they
-- personally brought in, and a smaller amount on business that reached the
-- broker through somebody below them.
--
-- Two tiers each, because `ib_max_levels` defaults to 2 and a seed that
-- immediately violated the ceiling would be refused by the form that has to
-- edit it next.
INSERT INTO "ib_programs" ("name", "sort_order", "mode", "rebate_rate", "enabled")
VALUES
  ('Standard', 0, 'commission_only', '0', true),
  ('Gold',     1, 'commission_only', '0', true),
  ('Partner',  2, 'commission_only', '0', true)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint

INSERT INTO "ib_program_tiers" ("program_id", "depth", "rate")
SELECT p."id", v."depth", v."rate"
FROM "ib_programs" p
JOIN (VALUES
  ('Standard', 1, 25.0000), ('Standard', 2, 5.0000),
  ('Gold',     1, 30.0000), ('Gold',     2, 8.0000),
  ('Partner',  1, 40.0000), ('Partner',  2, 10.0000)
) AS v("name", "depth", "rate") ON v."name" = p."name"
ON CONFLICT ("program_id", "depth") DO NOTHING;
--> statement-breakpoint

-- ── 7. Re-seat every partner ────────────────────────────────────────────────
--
-- Onto the lowest-sorted enabled programme, which is what a reviewer expressing
-- no preference gets at approval. Then NOT NULL comes back: FR-IB-06 says each
-- partner sits on "exactly one named program", and a partner with no terms is a
-- partner nothing can pay.
UPDATE "ib_accounts"
SET "program_id" = (
  SELECT "id" FROM "ib_programs" WHERE "enabled" ORDER BY "sort_order", "name" LIMIT 1
)
WHERE "program_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "ib_accounts" ALTER COLUMN "program_id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "ib_accounts"
  DROP CONSTRAINT IF EXISTS "ib_accounts_program_id_ib_programs_id_fk";
--> statement-breakpoint

ALTER TABLE "ib_accounts"
  ADD CONSTRAINT "ib_accounts_program_id_ib_programs_id_fk"
  FOREIGN KEY ("program_id") REFERENCES "ib_programs"("id") ON DELETE restrict;
--> statement-breakpoint

-- `ib_accruals.program_id` stays NULLABLE, unlike the account's. It records
-- which terms paid a row, and rows written before 0102 have no answer — an
-- invented one would be worse than the gap. RESTRICT so a programme that has
-- ever paid anybody cannot be deleted: the earnings row would otherwise lose
-- the only record of what it was calculated under.
ALTER TABLE "ib_accruals"
  DROP CONSTRAINT IF EXISTS "ib_accruals_program_id_ib_programs_id_fk";
--> statement-breakpoint

ALTER TABLE "ib_accruals"
  ADD CONSTRAINT "ib_accruals_program_id_ib_programs_id_fk"
  FOREIGN KEY ("program_id") REFERENCES "ib_programs"("id") ON DELETE restrict;
--> statement-breakpoint

-- ── 8. The per-programme share ceiling ──────────────────────────────────────
--
-- One programme's tiers plus its rebate may not exceed 100% of the revenue.
-- A DEFERRED CONSTRAINT TRIGGER and not a CHECK, because the rates live in
-- another table now and a CHECK cannot see them; DEFERRABLE because editing a
-- ladder rewrites its rows, and a per-statement check refuses a swap that is
-- valid at both ends.
--
-- This is NARROWER than the new `ib_max_total_payout_pct` and does not replace
-- it: on a single trade the earners may hold different programmes, so no
-- per-programme rule can bound what one trade costs. Both exist because they
-- bound different things — this one refuses terms nobody could honour, that one
-- refuses a CHAIN the broker cannot afford.
CREATE OR REPLACE FUNCTION "ib_program_share_fits"() RETURNS trigger AS $$
DECLARE
  target uuid;
  total  numeric(12, 4);
  label  text;
BEGIN
  -- One function, two tables, so the key is read from whichever fired it.
  -- `ib_programs` identifies the programme by `id`; `ib_program_tiers` by
  -- `program_id`. Reading the wrong one is not a wrong answer, it is an
  -- undefined-column error raised on the money path at COMMIT.
  IF TG_TABLE_NAME = 'ib_programs' THEN
    target := COALESCE(NEW."id", OLD."id");
  ELSE
    target := COALESCE(NEW."program_id", OLD."program_id");
  END IF;

  -- The programme may already be gone: a DELETE cascade removes the card and
  -- its lines together, and the row trigger still fires for every line.
  -- Nothing to bound, so nothing to refuse.
  IF NOT EXISTS (SELECT 1 FROM "ib_programs" WHERE "id" = target) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(t."rate"), 0) + MAX(p."rebate_rate"), MAX(p."name")
  INTO total, label
  FROM "ib_programs" p
  LEFT JOIN "ib_program_tiers" t ON t."program_id" = p."id"
  WHERE p."id" = target;

  IF total > 100 THEN
    -- The percent sign is CONCATENATED, never written into the format string.
    -- In plpgsql `%` is the placeholder and `%%` is a literal, so a message
    -- reading "pays out %%" silently consumes the next argument and the number
    -- never appears — which is how this trigger once reported "%105.0000".
    RAISE EXCEPTION
      'IB programme "%" would pay out % of the broker''s revenue on one trade, which is more than it earns',
      label, total || '%'
      -- TG_NAME, so the error names the trigger that ACTUALLY fired rather than
      -- the shared function behind both. One rule, two write paths: a tier
      -- insert reports `ib_program_tiers_share_fits` and a rebate edit reports
      -- `ib_programs_share_fits`, and each points at an object that exists and
      -- can be looked up. A single hard-coded name would send whoever reads the
      -- log to a trigger that is not the one they tripped.
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "ib_program_tiers_share_fits" ON "ib_program_tiers";
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "ib_program_tiers_share_fits"
  AFTER INSERT OR UPDATE OR DELETE ON "ib_program_tiers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ib_program_share_fits"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "ib_programs_share_fits" ON "ib_programs";
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "ib_programs_share_fits"
  AFTER INSERT OR UPDATE ON "ib_programs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ib_program_share_fits"();
