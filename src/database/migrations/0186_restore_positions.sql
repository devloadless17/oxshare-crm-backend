-- 0184 — `positions` STAYS. An earlier draft of 0182 dropped it as never-written;
-- that was withdrawn because work depends on it. On a database that never ran
-- the draft (production) every statement here is a no-op. On one that did, it
-- puts the table back in its final shape: 0041, with 0129's sort index and
-- 0159's integer Portal ID `user_id`.
DO $$ BEGIN
  CREATE TYPE "public"."position_side" AS ENUM('buy', 'sell');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."position_status" AS ENUM('open', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "positions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "trading_account_id" uuid NOT NULL REFERENCES "trading_accounts"("id") ON DELETE RESTRICT,
  "ticket" varchar(50) NOT NULL,
  "symbol" varchar(40) NOT NULL,
  "side" "position_side" NOT NULL,
  "volume" numeric(18, 4) NOT NULL,
  "open_price" numeric(28, 10) NOT NULL,
  "close_price" numeric(28, 10),
  "stop_loss" numeric(28, 10),
  "take_profit" numeric(28, 10),
  "profit" numeric(28, 8),
  "swap" numeric(28, 8),
  "commission" numeric(28, 8),
  "currency" varchar(10) NOT NULL REFERENCES "currencies"("code") ON DELETE RESTRICT,
  "status" "position_status" DEFAULT 'open' NOT NULL,
  "opened_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "positions_closed_has_close_data" CHECK (
    ("status" = 'open' AND "closed_at" IS NULL)
    OR ("status" = 'closed' AND "closed_at" IS NOT NULL AND "close_price" IS NOT NULL)
  ),
  CONSTRAINT "positions_volume_positive" CHECK ("volume" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "positions_account_ticket_uq" ON "positions" ("trading_account_id", "ticket");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_user_open_idx" ON "positions" ("user_id", "opened_at") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_user_closed_idx" ON "positions" ("user_id", "closed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_account_idx" ON "positions" ("trading_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_user_closed_at_id_idx" ON "positions" ("user_id", "closed_at" DESC, "id" DESC);
