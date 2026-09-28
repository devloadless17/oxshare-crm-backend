-- ============================================================================
-- An API key carries its creator's FIELD MASK, like it carries their territory
-- ============================================================================
--
-- Keys authenticated with an EMPTY mask: "masking is a per-admin display
-- concern and a key is a machine reader". The consequence was a laundering
-- path — an administrator whose role hides client emails, holding
-- `apikeys.create`, could mint a key and read every email through it. The
-- territory was already snapshot onto the key for exactly this reason (#7);
-- the mask was not.
--
-- Existing keys take their creator's CURRENT effective mask (a personal
-- override, else the role's), which closes the path retroactively rather than
-- only for keys minted from now on. A key whose creator is gone keeps `[]`.
-- Re-runnable.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "masked_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "api_keys" k
  SET "masked_fields" = COALESCE(a."masked_fields", r."masked_fields", '[]'::jsonb)
  FROM "admins" a
  LEFT JOIN "roles" r ON r."id" = a."role_id"
  WHERE a."id" = k."created_by";
