-- 0059 · An API key carries the territory of the admin who minted it.
--
-- Escalation the 13 Aug scoped walk found: a key authenticated as UNRESTRICTED
-- in territory regardless of who created it, so a tag-scoped admin holding
-- `apikeys.create` + `clients.view` could mint a key that read the WHOLE client
-- base — laundering their own scope away through a machine credential.
--
-- The fix mirrors `admin_invites.scoped_tag_ids` (migration 0023): the creator's
-- territory is SNAPSHOT onto the key at creation and fed to `clientScope` at
-- authentication. A column, not a live join to the creator's scope — a key must
-- not silently change territory when its creator's does (and must keep working
-- after its creator is deleted). An empty list still means unrestricted, so a
-- key minted by an unrestricted admin stays unrestricted: the reporting-job
-- case this feature exists for is unchanged.
--
-- Existing keys predate scoping and were all created by unrestricted admins
-- (issuing was master-only until the permission rework), so NULL/empty = the
-- historical unrestricted behaviour, which is the safe backfill here.
ALTER TABLE "api_keys" ADD COLUMN "scoped_tag_ids" jsonb;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "sees_untriaged" boolean NOT NULL DEFAULT true;
