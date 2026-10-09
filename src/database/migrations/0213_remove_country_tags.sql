-- 0213 — Country TAGS are removed (the owner, 9 Oct 2026). The client's country stays.
--
-- 0193 made every client carry a derived country tag, so a "Lebanon desk" could
-- hold the Lebanon tag. Production showed nobody uses it: every client is in one
-- country and no administrator's territory holds a country tag. It only put a
-- country chip on every row and a Countries tab admins could misread. A tag now
-- means one thing again: whose book (who is responsible for) the client is.
--
-- KEPT: `users.country` (NOT NULL, FK to `countries`) and the clients list's
-- country FILTER. "Lebanese clients" is a filter, not a territory.
--
-- ⚠️ NARROW BEFORE STRIPPING. Since 0154 a territory with tags is restricted to
-- them, and only an EMPTY one falls back to `sees_all_clients`. A territory that
-- held ONLY country tags, with the flag still on, would widen to every client
-- once they are gone. So the flag is turned off for exactly those rows first:
-- they narrow to nothing, never widen. Admins, invites and API keys alike.
--
-- Roll forward only: the previous build reads `client_tag_memberships`.

UPDATE "admins" a SET "sees_all_clients" = false
 WHERE EXISTS (SELECT 1 FROM "admin_client_tag_scopes" s JOIN "client_tags" t ON t."id" = s."tag_id"
                WHERE s."admin_id" = a."id" AND t."country_code" IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM "admin_client_tag_scopes" s JOIN "client_tags" t ON t."id" = s."tag_id"
                    WHERE s."admin_id" = a."id" AND t."country_code" IS NULL);--> statement-breakpoint

UPDATE "admin_invites" i SET
  "scoped_tag_ids" = (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements_text(i."scoped_tag_ids") e
                       WHERE e NOT IN (SELECT "id"::text FROM "client_tags" WHERE "country_code" IS NOT NULL)),
  "sees_all_clients" = CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(i."scoped_tag_ids") e
                  WHERE e NOT IN (SELECT "id"::text FROM "client_tags" WHERE "country_code" IS NOT NULL))
    THEN i."sees_all_clients" ELSE false END
 WHERE jsonb_typeof(i."scoped_tag_ids") = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(i."scoped_tag_ids") e
                WHERE e IN (SELECT "id"::text FROM "client_tags" WHERE "country_code" IS NOT NULL));--> statement-breakpoint

UPDATE "api_keys" k SET
  "scoped_tag_ids" = (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements_text(k."scoped_tag_ids") e
                       WHERE e NOT IN (SELECT "id"::text FROM "client_tags" WHERE "country_code" IS NOT NULL)),
  "sees_all_clients" = CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(k."scoped_tag_ids") e
                  WHERE e NOT IN (SELECT "id"::text FROM "client_tags" WHERE "country_code" IS NOT NULL))
    THEN k."sees_all_clients" ELSE false END
 WHERE jsonb_typeof(k."scoped_tag_ids") = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(k."scoped_tag_ids") e
                WHERE e IN (SELECT "id"::text FROM "client_tags" WHERE "country_code" IS NOT NULL));--> statement-breakpoint

DELETE FROM "admin_client_tag_scopes"
 WHERE "tag_id" IN (SELECT "id" FROM "client_tags" WHERE "country_code" IS NOT NULL);--> statement-breakpoint

DROP VIEW IF EXISTS "client_tag_memberships";--> statement-breakpoint
DROP TRIGGER IF EXISTS "client_tags_country_fixed" ON "client_tags";--> statement-breakpoint
DROP FUNCTION IF EXISTS client_tags_country_fixed();--> statement-breakpoint
DROP TRIGGER IF EXISTS "client_tag_assignments_no_country" ON "client_tag_assignments";--> statement-breakpoint
DROP FUNCTION IF EXISTS client_tag_assignments_no_country();--> statement-breakpoint

DELETE FROM "client_tags" WHERE "country_code" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "client_tags_country_code_uq";--> statement-breakpoint
ALTER TABLE "client_tags" DROP COLUMN IF EXISTS "country_code";
