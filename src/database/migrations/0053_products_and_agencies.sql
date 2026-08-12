-- What the broker sells, and who is allowed to sell it.
--
--     Agency (وكالة)   name, description
--       └─ Products     "Standard", "ECN"
--            └─ Groups  demo\Standard-USD · real\Standard-USD · real\Standard-EUR
--                 └─ Accounts
--
-- Replaces MT5_CLIENT_GROUPS_LIVE / _DEMO, a comma-separated environment
-- variable that could express one flat list and nothing else. A partner needs
-- to be told what they may sell, and a client needs to be offered what their
-- partner sells; neither question can be asked of a string in a .env file.
--
-- The seed at the bottom is what makes this deployable: it lifts whatever those
-- variables currently name into a product called "Standard", so the portal
-- offers exactly what it offered before the migration ran.

CREATE TABLE IF NOT EXISTS "trading_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(80) NOT NULL,
  "description" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trading_products_name_unique" UNIQUE ("name")
);

CREATE TABLE IF NOT EXISTS "trading_product_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "trading_products"("id") ON DELETE cascade,
  "environment" "trading_environment" NOT NULL,
  "mt5_group" varchar(100) NOT NULL,
  "currency" varchar(10) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- One product per group, platform-wide: two products claiming the same group
  -- makes "which product is this account under" unanswerable, and that question
  -- decides whose commission it pays.
  CONSTRAINT "trading_product_groups_group_unique" UNIQUE ("mt5_group"),
  CONSTRAINT "trading_product_groups_slot_unique" UNIQUE ("product_id", "environment", "currency")
);

CREATE INDEX IF NOT EXISTS "trading_product_groups_product_idx"
  ON "trading_product_groups" ("product_id");

CREATE TABLE IF NOT EXISTS "agencies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(80) NOT NULL,
  "description" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agencies_name_unique" UNIQUE ("name")
);

CREATE TABLE IF NOT EXISTS "agency_products" (
  "agency_id" uuid NOT NULL REFERENCES "agencies"("id") ON DELETE cascade,
  -- restrict, asymmetric with the cascade above and deliberately so: deleting a
  -- programme takes its own rows with it, deleting a product an agency still
  -- sells would silently strip partners of what they were appointed to sell.
  "product_id" uuid NOT NULL REFERENCES "trading_products"("id") ON DELETE restrict,
  CONSTRAINT "agency_products_pkey" PRIMARY KEY ("agency_id", "product_id")
);

CREATE INDEX IF NOT EXISTS "agency_products_product_idx" ON "agency_products" ("product_id");

-- The partner's appointment, and the applicant's request.
ALTER TABLE "ib_accounts"
  ADD COLUMN IF NOT EXISTS "agency_id" uuid REFERENCES "agencies"("id") ON DELETE restrict;

ALTER TABLE "ib_applications"
  ADD COLUMN IF NOT EXISTS "agency_id" uuid REFERENCES "agencies"("id") ON DELETE restrict;

CREATE INDEX IF NOT EXISTS "ib_accounts_agency_idx" ON "ib_accounts" ("agency_id");

-- ── Seed: carry the environment variable's groups across ─────────────────────
--
-- Written as a DO block rather than plain INSERTs because the groups are not
-- known at authoring time — they are whatever this deployment has in
-- MT5_CLIENT_GROUPS_LIVE / _DEMO, and a migration cannot read a .env file.
--
-- So the row is created EMPTY here and the application fills it: on boot,
-- `SelfServiceGroups` finds no product, reads the variables, and writes the
-- groups it finds into this product. That keeps the one-time import beside the
-- code that knows how to parse the variable, and makes it re-runnable.
--
-- A deployment with neither variable set gets a product with no groups, which
-- reads correctly on the admin screen as "nothing configured yet" — the same
-- thing an empty variable meant.
INSERT INTO "trading_products" ("name", "description", "sort_order")
SELECT 'Standard', 'Imported from MT5_CLIENT_GROUPS_LIVE / _DEMO when products replaced them.', 0
WHERE NOT EXISTS (SELECT 1 FROM "trading_products");
