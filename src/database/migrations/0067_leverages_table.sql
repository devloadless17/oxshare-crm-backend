-- The leverage ladder becomes a table, and `trading_settings.leverages` goes.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── What it was ─────────────────────────────────────────────────────────────
--
-- `trading_settings.leverages`, a `varchar(200)` holding `50,100,200,500`. Its
-- own note argued a CSV was enough: "nothing queries into it, and the CSV is
-- exactly what the operator typed, which is what should come back when they
-- reopen the form."
--
-- Both halves stopped being true. An operator withdrawing 500:1 for a
-- regulatory change could only delete it from the string, which says nothing
-- about the accounts already open on it — and a delimited list has nowhere to
-- put `enabled`, so "we never offered this" and "we stopped offering this" are
-- the same state. It is the argument `currencies` and `ib_levels` already won.
--
-- ── The backfill reads the CSV, it does not assume the default ──────────────
--
-- Every deployment's row is split on its own value, so an operator who set
-- `100,400` gets exactly those two rungs — seeding a fixed default here would
-- silently discard a ladder somebody chose. `ordinality` carries the CSV's
-- position into `sort_order`, because the order in that string WAS the order
-- the client saw and it is the one thing the format got right.
--
-- `NULLIF(trim(...), '')` drops empty segments, so a trailing comma or a
-- double separator does not become a leverage of 0. `regexp_replace` is not
-- needed: `parseLeverages` in the application already refused anything
-- non-numeric, so a row reaching here is digits and commas.
--
-- The INSERT is guarded by `NOT EXISTS`, so re-running against a database that
-- already has rows — a re-applied migration, a restored dump — adds nothing.
--
-- ── The column is DROPPED in the same statement-set ─────────────────────────
--
-- Not deprecated. Leaving it behind leaves a stale copy that the next person
-- may read, which is exactly how `payout_model` and the two-value currency enum
-- went wrong: a second source of truth that nothing updates and everything
-- believes. There is no period here where the table and the column can
-- disagree, because after this there is no column.
CREATE TABLE IF NOT EXISTS "leverages" (
  "ratio" integer PRIMARY KEY NOT NULL,
  "label" varchar(40),
  "enabled" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "leverages_enabled_sort_idx"
  ON "leverages" ("enabled", "sort_order");
--> statement-breakpoint

-- Backfill from whatever this deployment actually holds.
INSERT INTO "leverages" ("ratio", "sort_order")
SELECT DISTINCT ON (value::integer)
       value::integer AS ratio,
       (position - 1) * 10 AS sort_order
  FROM "trading_settings",
       LATERAL unnest(string_to_array("trading_settings"."leverages", ','))
         WITH ORDINALITY AS parts(value, position)
 WHERE NULLIF(trim(value), '') IS NOT NULL
   AND trim(value) ~ '^[0-9]+$'
   AND NOT EXISTS (SELECT 1 FROM "leverages")
 ORDER BY value::integer, position;
--> statement-breakpoint

-- A platform with no `trading_settings` row at all — a fresh database mid-setup
-- — would otherwise end up with an empty ladder and no way to open an account.
-- These are the four the column defaulted to.
INSERT INTO "leverages" ("ratio", "sort_order")
SELECT ratio, sort_order
  FROM (VALUES (50, 0), (100, 10), (200, 20), (500, 30)) AS seed(ratio, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM "leverages");
--> statement-breakpoint

ALTER TABLE "trading_settings" DROP COLUMN IF EXISTS "leverages";
