-- 0224 — network access belongs to each administrator, not to the console (13 Oct 2026).
--
-- RBAC-08 was one list of networks for every administrator, plus an exemption list of people
-- who could connect from anywhere (0192), managed on its own "Network access" page. The owner
-- asked for it per person instead: inviting or editing an administrator sets the addresses
-- THAT administrator may use, or lets them in from anywhere. The page goes; these two columns
-- replace it.
--
--   access_anywhere  true → any network. false → only `allowed_ips`.
--   allowed_ips      canonical IPv4 CIDRs (a single address is stored as /32).
--
-- The column default is `true` so an administrator created outside the invite (seed scripts,
-- test fixtures) is not locked out by a column nobody set; the invite and the edit screen
-- always write both.
--
-- Carried over so nobody's access changes on deploy:
--   * the global list was EMPTY (the control was off) → everyone keeps access from anywhere;
--   * otherwise an exempt administrator keeps access from anywhere, and everyone else may use
--     exactly the networks the global list admitted.
-- admin@oxshare.com, the owner, may connect from anywhere regardless.
--
-- The page's two permission keys, `settings.security.view` and `settings.security.edit`, opened
-- that page and nothing else, so they leave the catalogue and every stored permission set.
-- Who may set an administrator's networks is whoever may invite or edit them.
--
-- The two old tables are left in place and no longer read, so the previous build still runs
-- while this one deploys and the data survives a rollback. A later migration can drop them.

ALTER TABLE "admins" ADD COLUMN IF NOT EXISTS "access_anywhere" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN IF NOT EXISTS "allowed_ips" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_invites" ADD COLUMN IF NOT EXISTS "access_anywhere" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_invites" ADD COLUMN IF NOT EXISTS "allowed_ips" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "admins" a
SET "access_anywhere" = EXISTS (SELECT 1 FROM "admin_ip_allowlist_exemptions" e WHERE e."admin_id" = a."id"),
    "allowed_ips" = (SELECT COALESCE(jsonb_agg(l."cidr" ORDER BY l."created_at"), '[]'::jsonb) FROM "admin_ip_allowlist" l)
WHERE EXISTS (SELECT 1 FROM "admin_ip_allowlist");--> statement-breakpoint
UPDATE "admins" SET "access_anywhere" = true WHERE lower("email") = 'admin@oxshare.com';--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'settings.security.view' - 'settings.security.edit';--> statement-breakpoint
UPDATE "admins" SET "permissions" = "permissions" - 'settings.security.view' - 'settings.security.edit';--> statement-breakpoint
UPDATE "admin_invites" SET "permissions" = "permissions" - 'settings.security.view' - 'settings.security.edit' WHERE "permissions" IS NOT NULL;--> statement-breakpoint
UPDATE "api_keys" SET "permissions" = "permissions" - 'settings.security.view' - 'settings.security.edit';
