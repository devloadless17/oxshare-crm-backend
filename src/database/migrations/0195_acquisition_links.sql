-- 0195 — sign-up links owned by an administrator (6 Oct 2026).
--
-- The buyer's old CRM gives every admin a link of their own: a client who signs
-- up through it arrives carrying that admin's tags, so the client is in that
-- admin's book from the first second — no triage, no hand assignment. Here a tag
-- is also a territory (admin_client_tag_scopes), so "tagged O_F" IS "visible to
-- the O_F desk".
--
-- `acquisition_links`: a public CODE (the link is /join/<code>), a name, the
-- administrator who OWNS it, and `disabled_at` (a disabled link, or one whose
-- owner is suspended, tags nobody — the client still signs up, with their
-- country tag only).
--
-- `acquisition_link_tags`: what a sign-up through it is tagged with. Tag FK
-- RESTRICT, like a territory: a tag on a live link cannot vanish under it. A
-- country tag is refused (it is derived from the client's country, 0193).
--
-- `users.acquisition_link_id`: which link a client came through. Written once,
-- at registration, and never changed (trigger) — attribution is history.
--
-- RESTRICT on the owner: an administrator who owns links cannot be deleted
-- until their links are handed to somebody else. Ownership of the CLIENTS is a
-- tag, so nothing about them changes when a person leaves.
--
-- New keys `links.view`, `links.create` (your own links, tags from your own
-- territory) and `links.manage` (anyone's), granted to the Administrator role
-- and the two bootstrap accounts like every key before them (0122's recipe).
-- Additive: the previous build ignores all of it.

CREATE TABLE IF NOT EXISTS "acquisition_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" varchar(16) NOT NULL,
  "name" varchar(100) NOT NULL,
  "owner_admin_id" uuid NOT NULL REFERENCES "admins"("id") ON DELETE RESTRICT,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "disabled_at" timestamp with time zone,
  CONSTRAINT "acquisition_links_code_uq" UNIQUE ("code"),
  CONSTRAINT "acquisition_links_code_ck" CHECK ("code" ~ '^[A-Z0-9]{4,16}$'),
  CONSTRAINT "acquisition_links_name_ck" CHECK (length(btrim("name")) > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acquisition_links_owner_idx" ON "acquisition_links" ("owner_admin_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "acquisition_link_tags" (
  "link_id" uuid NOT NULL REFERENCES "acquisition_links"("id") ON DELETE CASCADE,
  "tag_id" uuid NOT NULL REFERENCES "client_tags"("id") ON DELETE RESTRICT,
  PRIMARY KEY ("link_id", "tag_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acquisition_link_tags_tag_idx" ON "acquisition_link_tags" ("tag_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION acquisition_link_tags_no_country() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM client_tags WHERE id = NEW.tag_id AND country_code IS NOT NULL) THEN
    RAISE EXCEPTION 'A country tag follows the client''s country and cannot be put on a link'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "acquisition_link_tags_no_country" ON "acquisition_link_tags";--> statement-breakpoint
CREATE TRIGGER "acquisition_link_tags_no_country" BEFORE INSERT OR UPDATE ON "acquisition_link_tags"
  FOR EACH ROW EXECUTE FUNCTION acquisition_link_tags_no_country();--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "acquisition_link_id" uuid
  REFERENCES "acquisition_links"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_acquisition_link_idx" ON "users" ("acquisition_link_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_acquisition_link_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.acquisition_link_id IS DISTINCT FROM OLD.acquisition_link_id THEN
    RAISE EXCEPTION 'Which link a client signed up through is history and cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_acquisition_link_immutable" ON "users";--> statement-breakpoint
CREATE TRIGGER "users_acquisition_link_immutable" BEFORE UPDATE OF "acquisition_link_id" ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_acquisition_link_immutable();--> statement-breakpoint

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT unnest(ARRAY['links.view', 'links.create', 'links.manage'])
       ) keys(k)
   )
 WHERE name = 'Administrator';--> statement-breakpoint
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT unnest(ARRAY['links.view', 'links.create', 'links.manage'])
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');
