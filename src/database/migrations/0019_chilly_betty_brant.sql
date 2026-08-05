ALTER TABLE "refresh_tokens" ADD COLUMN "user_agent" varchar(400);--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "ip" varchar(64);