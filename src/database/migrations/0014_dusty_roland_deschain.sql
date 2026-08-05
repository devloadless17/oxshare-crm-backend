ALTER TABLE "admin_invites" DROP CONSTRAINT "admin_invites_token_unique";--> statement-breakpoint
ALTER TABLE "admin_invites" DROP COLUMN "token";--> statement-breakpoint
ALTER TABLE "admins" DROP COLUMN "refresh_token";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "refresh_token";