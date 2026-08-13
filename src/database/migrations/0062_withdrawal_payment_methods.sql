-- The methods a client may be PAID OUT through, as data.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── Why this is not `payment_methods` ───────────────────────────────────────
--
-- A deposit method and a withdrawal method look alike and are not the same
-- thing. `payment_methods` describes how money comes IN: it carries a currency,
-- it is what `requestDeposit` reads to decide gateway-versus-manual, and its
-- rows are wired to Rival's provider keys. Paying money OUT asks a different
-- question — what destination the client must supply, and whether the desk is
-- willing to send to that rail today — and the two answers move independently.
--
-- Overloading one table would mean a `direction` column that half the code
-- forgets to filter on, and the first time somebody enables a deposit rail it
-- would silently become a payout rail as well. That is a mistake made once and
-- discovered when money leaves.
--
-- ── Deliberately small, and deliberately not administrable ──────────────────
--
-- Key, name, logo, enabled. There is NO admin screen for this and none is
-- planned: the set is one row today and changes at the pace of commercial
-- agreements, not operations. It is seeded here and edited with SQL, which is
-- the honest shape for a table nobody is asking to manage — an admin CRUD
-- surface for a single immutable row is a screen that exists to be wrong.
--
-- `enabled` is what takes a rail out of service without deleting history: a
-- withdrawal that already went through a method must keep naming it, which is
-- also why the foreign key below RESTRICTS rather than cascades.

CREATE TABLE IF NOT EXISTS "withdrawal_payment_methods" (
  -- A stable machine key, never renamed — the same contract `payment_methods`
  -- states, and for the same reason: it is written onto transaction rows that
  -- outlive any rebrand.
  "key" varchar(40) PRIMARY KEY,
  "name" varchar(80) NOT NULL,
  -- Sized for a real URL, like `payment_methods.logo_url`. NULL is a legitimate
  -- value and the portal renders a generic wallet mark for it, so a method is
  -- never blocked on artwork.
  "logo_url" varchar(2048),
  "enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The client-facing list filters on `enabled` and orders by `sort_order`, which
-- is exactly this index — the shape `payment_methods_enabled_sort_idx` already
-- uses for the deposit side.
CREATE INDEX IF NOT EXISTS "withdrawal_payment_methods_enabled_sort_idx"
  ON "withdrawal_payment_methods" ("enabled", "sort_order");
--> statement-breakpoint

-- Whish Money, the one rail offered today.
--
-- ON CONFLICT DO NOTHING so re-running this migration against a database where
-- an operator has since renamed or disabled the row does not resurrect the
-- original values — the seed establishes the row, it does not own it.
INSERT INTO "withdrawal_payment_methods" ("key", "name", "sort_order")
VALUES ('whish', 'Whish Money', 0)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

-- Which rail a withdrawal was requested through.
--
-- A SEPARATE column from `method_key`, which points at `payment_methods` and
-- belongs to deposits. One column cannot carry two foreign keys, and making
-- `method_key` nullable-tolerant across two tables would remove the only thing
-- that makes either reference meaningful.
--
-- NULLABLE, because every withdrawal written before this migration has no
-- method to name. Backfilling them to 'whish' would be inventing a fact about
-- money that has already moved — those rows carry `provider` instead, and the
-- admin list falls back to it.
--
-- RESTRICT: a method that any withdrawal has ever named cannot be deleted. The
-- operator disables it, which is what `enabled` is for.
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "withdrawal_method_key" varchar(40)
  REFERENCES "withdrawal_payment_methods" ("key") ON DELETE RESTRICT;
