-- 0198 — ONE sign-up link per administrator, named by a readable slug (6 Oct 2026).
--
-- 0195 gave links a life of their own: any number per administrator, each with
-- its OWN copy of tags. That put an administrator's book in two places — their
-- territory (admin_client_tag_scopes) and every link's tag list — and the copy
-- drifted: give an administrator a new tag, or move them to another desk, and
-- every link they had handed out kept tagging clients into the old book, with
-- nothing anywhere saying so. The owner's ruling (6 Oct 2026): each
-- administrator has exactly one link, and a sign-up through it gets that
-- administrator's tags AS THEY ARE AT THAT MOMENT — read live from their
-- territory, never stored on the link. One home for an administrator's book.
--
-- The link is /join/<signup_slug>: a readable word (the owner: "a slug word for
-- each admin"), made from the administrator's name on creation — `omar-farah`,
-- `omar-farah-2` on a clash — and changeable by them on their profile. It is not
-- a secret: whoever it is sent to sees it, and using somebody's link only puts
-- you in their book. Lowercase letters, digits, `-` and `_`, 3–32 characters,
-- unique. Every writer gets one: a BEFORE INSERT trigger fills it from the name
-- (the empty-string default is a placeholder the trigger always replaces).
--
-- `users.signed_up_via_admin_id` records which administrator's link brought a
-- client — written once at registration, never changed (trigger), carried over
-- from 0195's link attribution. 0195's tables, trigger and keys (`links.view`,
-- `links.create`, `links.manage`) go: the link is the administrator's own, shown
-- on their profile and on the Admin users page.
--
-- Not reversible by the previous build (it reads 0195's tables). Production
-- never ran 0195, so nothing there is lost.

CREATE OR REPLACE FUNCTION signup_slug_for(admin_name text, admin_id uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  base text;
  candidate text;
  n integer := 1;
BEGIN
  base := trim(both '-' from regexp_replace(lower(coalesce(admin_name, '')), '[^a-z0-9]+', '-', 'g'));
  base := trim(both '-' from left(base, 28));
  IF length(base) < 3 THEN
    base := 'admin-' || substr(replace(admin_id::text, '-', ''), 1, 6);
  END IF;
  candidate := base;
  WHILE EXISTS (SELECT 1 FROM admins WHERE signup_slug = candidate AND id <> admin_id) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  RETURN candidate;
END $$;--> statement-breakpoint

ALTER TABLE "admins" ADD COLUMN IF NOT EXISTS "signup_slug" varchar(32) DEFAULT '' NOT NULL;--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  -- Oldest first, so the longest-serving administrator keeps the plain name.
  FOR r IN SELECT id, name FROM admins WHERE signup_slug = '' ORDER BY created_at, id LOOP
    UPDATE admins SET signup_slug = signup_slug_for(r.name, r.id) WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admins_signup_slug_uq" ON "admins" ("signup_slug");--> statement-breakpoint
ALTER TABLE "admins" DROP CONSTRAINT IF EXISTS "admins_signup_slug_ck";--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_signup_slug_ck"
  CHECK ("signup_slug" ~ '^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$');--> statement-breakpoint
CREATE OR REPLACE FUNCTION admins_signup_slug_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signup_slug IS NULL OR NEW.signup_slug = '' THEN
    NEW.signup_slug := signup_slug_for(NEW.name, NEW.id);
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "admins_signup_slug_fill" ON "admins";--> statement-breakpoint
CREATE TRIGGER "admins_signup_slug_fill" BEFORE INSERT ON "admins"
  FOR EACH ROW EXECUTE FUNCTION admins_signup_slug_fill();--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signed_up_via_admin_id" uuid
  REFERENCES "admins"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_signed_up_via_idx" ON "users" ("signed_up_via_admin_id");--> statement-breakpoint
-- 0195's attribution, carried over to the administrator who owned the link.
UPDATE "users" u SET "signed_up_via_admin_id" = l."owner_admin_id"
  FROM "acquisition_links" l
 WHERE l."id" = u."acquisition_link_id" AND u."signed_up_via_admin_id" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_signed_up_via_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signed_up_via_admin_id IS DISTINCT FROM OLD.signed_up_via_admin_id THEN
    RAISE EXCEPTION 'Which administrator''s link brought a client is history and cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_signed_up_via_immutable" ON "users";--> statement-breakpoint
CREATE TRIGGER "users_signed_up_via_immutable" BEFORE UPDATE OF "signed_up_via_admin_id" ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_signed_up_via_immutable();--> statement-breakpoint

-- 0195, retired.
DROP TRIGGER IF EXISTS "users_acquisition_link_immutable" ON "users";--> statement-breakpoint
DROP FUNCTION IF EXISTS users_acquisition_link_immutable();--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "acquisition_link_id";--> statement-breakpoint
DROP TABLE IF EXISTS "acquisition_link_tags";--> statement-breakpoint
DROP FUNCTION IF EXISTS acquisition_link_tags_no_country();--> statement-breakpoint
DROP TABLE IF EXISTS "acquisition_links";--> statement-breakpoint

-- Its three keys leave every stored grant: roles, administrators, pending
-- invites and API keys. Nothing replaces them — your own link is yours, and
-- reading anybody's is the Admin users page (admins.view).
UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(e.v ORDER BY e.v), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions) e(v)
   WHERE e.v NOT IN ('links.view', 'links.create', 'links.manage'))
 WHERE permissions ?| ARRAY['links.view', 'links.create', 'links.manage'];--> statement-breakpoint
UPDATE admins SET permissions = (
  SELECT COALESCE(jsonb_agg(e.v ORDER BY e.v), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions) e(v)
   WHERE e.v NOT IN ('links.view', 'links.create', 'links.manage'))
 WHERE permissions ?| ARRAY['links.view', 'links.create', 'links.manage'];--> statement-breakpoint
UPDATE admin_invites SET permissions = (
  SELECT COALESCE(jsonb_agg(e.v ORDER BY e.v), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions) e(v)
   WHERE e.v NOT IN ('links.view', 'links.create', 'links.manage'))
 WHERE permissions IS NOT NULL AND permissions ?| ARRAY['links.view', 'links.create', 'links.manage'];--> statement-breakpoint
UPDATE api_keys SET permissions = (
  SELECT COALESCE(jsonb_agg(e.v ORDER BY e.v), '[]'::jsonb)
    FROM jsonb_array_elements_text(permissions) e(v)
   WHERE e.v NOT IN ('links.view', 'links.create', 'links.manage'))
 WHERE permissions ?| ARRAY['links.view', 'links.create', 'links.manage'];
