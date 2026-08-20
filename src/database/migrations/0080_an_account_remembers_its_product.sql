-- An account REMEMBERS the product it was opened under.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── What was there before ──────────────────────────────────────────────────
--
-- Nothing on `trading_accounts` named a product. `TradingService` resolved one
-- at READ time by joining the account's `mt5_group` against
-- `trading_product_groups.mt5_group`, case-insensitively, and that join is
-- correct today for a good reason: the catalogue is UNIQUE on `mt5_group`
-- platform-wide, so the question "which product is this account under" has
-- exactly one answer.
--
-- It has exactly one answer NOW. That is the whole problem.
--
-- ── Why a derived answer is the wrong kind of answer ───────────────────────
--
-- The join reports the CURRENT catalogue, not the one the account was opened
-- against. Three ordinary operator actions therefore rewrite the past:
--
--   * detaching a group from a product — every account in it silently becomes
--     product-less, and the portal card stops showing a product it showed
--     yesterday;
--   * attaching that group to a DIFFERENT product — every existing account
--     retroactively changes product, including for the schema comment's own
--     stated purpose, "that question is what decides whose commission it pays";
--   * renaming the group on the MT5 server — the string stops matching and the
--     answer goes NULL, with nothing in this system having been touched.
--
-- None of the three is an error anybody would be warned about, and none leaves
-- a trace: the account rows look identical before and after. A client who chose
-- "Standard" on the open-account form chose it at a moment, and this column is
-- what makes that moment survive the catalogue being edited afterwards.
--
-- ── NULLABLE, and the read-time join STAYS ─────────────────────────────────
--
-- NULL is a real state rather than a gap to be filled. An operator may open an
-- account directly into any MT5 group, including one the catalogue does not
-- sell — `Mt5AccountsService.createAccount` takes a raw group string and always
-- has. Those accounts have no product and never did.
--
-- So `TradingService` now reads COALESCE(by-id, by-group): this column when the
-- account has one, the join when it does not. Dropping the join instead would
-- regress every row opened before today to "no product" on the client's own
-- account card, which is the em-dash failure the `product` field was added to
-- fix in the first place.
--
-- ── ON DELETE SET NULL, not RESTRICT ───────────────────────────────────────
--
-- The other direction of the same rule the products table already states: "a
-- disabled product stops being OFFERED and keeps its accounts trading". A
-- product an operator deletes must not take live trading accounts with it, and
-- must not become undeletable because somebody once opened an account on it.
-- The account survives with no product, which is the state it would have had if
-- the catalogue had never listed the group.
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS product_id uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_product_id_trading_products_id_fk"
    FOREIGN KEY ("product_id") REFERENCES "public"."trading_products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trading_accounts_product_idx" ON "trading_accounts" ("product_id");
--> statement-breakpoint

-- ── BACKFILL from the join this column replaces ────────────────────────────
--
-- The best answer available for an existing row: what the read-time join would
-- have returned the instant before this migration ran. Case-insensitive, for
-- the reason `PRODUCT_JOIN_ON` gives — the stored group comes back from the
-- bridge and the catalogue's was typed by an operator, so the two can differ in
-- casing alone and an exact match would resolve those to NULL.
--
-- Accounts whose group is in no product stay NULL, which is correct: nothing
-- knows what product they were opened under because there was never one.
--
-- This is a SNAPSHOT and not a repair job. It runs once; from here the column
-- is written at account creation and nothing recomputes it, because recomputing
-- it from the catalogue is precisely the behaviour this migration removes.
UPDATE trading_accounts a
SET product_id = g.product_id
FROM trading_product_groups g
WHERE a.mt5_group IS NOT NULL
  AND lower(g.mt5_group) = lower(a.mt5_group)
  AND a.product_id IS NULL;
