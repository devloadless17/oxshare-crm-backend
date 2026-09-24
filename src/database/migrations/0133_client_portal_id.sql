-- Give every client a PORTAL ID: a human number, starting at 1,000,000.
--
-- ── What it is, and what it is not ──────────────────────────────────────────
--
-- The client's old platform numbered clients 1, 2, 3 … up to about 200,000, and
-- that number is how the broker and its clients refer to an account. This adds
-- the same kind of number here. It is what staff see, what a client sees on
-- their profile, and what the client search finds.
--
-- It is NOT the primary key. `users.id` stays a UUID and every foreign key keeps
-- pointing at it (tech-lead decision, 24 Sep 2026). Two reasons that matter:
--
--   - Fourteen tables reference a client, several of them on the money path.
--     Re-keying all of them to gain a display number would be a large change for
--     no behavioural benefit.
--   - A sequential number is GUESSABLE. As long as URLs and API routes keep
--     addressing clients by UUID, walking the numbers reveals nothing. The
--     portal ID must never become an access key — it identifies a client to a
--     human, the UUID identifies it to the system.
--
-- ── Why 1,000,000 ───────────────────────────────────────────────────────────
--
-- The old platform's clients will be imported WITH their original numbers
-- (1 … ~200,000). New clients therefore start at 1,000,000, so the two ranges
-- cannot meet whenever the import happens — including after real clients have
-- registered here.
--
-- ⚠️ THE IMPORT MUST REFUSE ANY OLD ID ≥ 1,000,000. The sequence owns that range;
-- an imported number inside it would collide with a future registration. The
-- unique index below would catch the collision, but only at the moment a new
-- client tries to register — the wrong time to find out.
--
-- Imported rows set `portal_id` explicitly, which a column DEFAULT permits; the
-- sequence is not consulted and does not move.
--
-- ── Gaps are expected ───────────────────────────────────────────────────────
--
-- A Postgres sequence is not rolled back with a failed transaction, so a
-- registration that fails after drawing a number leaves a gap (1,000,005 then
-- 1,000,007). Numbers are always unique and always increasing, never guaranteed
-- contiguous — agreed with the owner as acceptable; a gap-free counter would
-- serialise every registration behind a lock.
--
-- ── Existing clients ────────────────────────────────────────────────────────
--
-- Numbered in the order they joined, from 1,000,000. Computed with
-- `row_number()` rather than by calling `nextval()` inside the UPDATE, because
-- Postgres does not promise to evaluate `nextval()` in the order the rows were
-- sorted — the numbers would be unique but not in joining order. The sequence is
-- then moved past the highest number assigned.
--
-- Additive and non-destructive: safe to run on a database with data in it.

CREATE SEQUENCE IF NOT EXISTS "users_portal_id_seq"
  AS integer
  START WITH 1000000
  MINVALUE 1000000
  NO CYCLE;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "portal_id" integer;

WITH "ordered" AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "rn"
    FROM "users"
   WHERE "portal_id" IS NULL
)
UPDATE "users" AS "u"
   SET "portal_id" = (
         SELECT GREATEST(coalesce(max("portal_id"), 999999), 999999) FROM "users"
       ) + "o"."rn"
  FROM "ordered" AS "o"
 WHERE "u"."id" = "o"."id";

-- Move the sequence past what was just assigned. Skipped on an empty table: the
-- sequence then hands out 1,000,000 first, and setval() below MINVALUE would fail.
SELECT setval('"users_portal_id_seq"', "m", true)
  FROM (SELECT max("portal_id") AS "m" FROM "users" WHERE "portal_id" >= 1000000) AS "x"
 WHERE "m" IS NOT NULL;

ALTER TABLE "users" ALTER COLUMN "portal_id" SET DEFAULT nextval('"users_portal_id_seq"');
ALTER TABLE "users" ALTER COLUMN "portal_id" SET NOT NULL;
ALTER SEQUENCE "users_portal_id_seq" OWNED BY "users"."portal_id";

CREATE UNIQUE INDEX IF NOT EXISTS "users_portal_id_uq" ON "users" ("portal_id");

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_portal_id_positive" CHECK ("portal_id" > 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
