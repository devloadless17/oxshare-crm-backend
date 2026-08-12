-- The terms a client may open an account on, moved out of the environment.
--
-- Leverage came from MT5_CLIENT_LEVERAGES and the demo funding ceiling from a
-- constant compiled into two apps. Both are commercial decisions rather than
-- deployment details, and the account caps are new: nothing bounded how many
-- accounts one client could open, which on the demo endpoint is a free account
-- generator on the broker's own server.
--
-- Singleton in the same shape as general_settings and smtp_settings: the check
-- constraint on a boolean primary key admits exactly one row.
CREATE TABLE IF NOT EXISTS "trading_settings" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "leverages" varchar(200) DEFAULT '50,100,200,500' NOT NULL,
  "max_live_accounts" integer DEFAULT 5 NOT NULL,
  "max_demo_accounts" integer DEFAULT 5 NOT NULL,
  "max_demo_deposit" numeric(28, 8) DEFAULT '1000000' NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trading_settings_singleton" CHECK ("trading_settings"."id")
);

-- No seed row. An absent row means "nothing configured, use the defaults",
-- which is what the store reports and what the service turns into the same
-- numbers the column defaults carry — so the first save writes the row rather
-- than editing one nobody chose.
