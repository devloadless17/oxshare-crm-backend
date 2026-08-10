-- ⚠️ NUMBERING COLLISION, and it is harmless — read this before "fixing" it.
--
-- There are TWO files numbered 0045: this one and
-- `0045_payments_keys_and_seed_role.sql`. They were authored on branches that
-- did not see each other and both had landed before the collision was noticed.
--
-- Drizzle applies migrations by the `idx` in meta/_journal.json, not by
-- filename, and the journal orders them correctly:
--
--     44  0044_permission_model
--     45  0045_payments_keys_and_seed_role
--     46  0045_mt5_deals              <- this file
--     47  0046_notifications
--
-- So the order on a fresh database is right, and on an existing one both have
-- already run. DO NOT rename this file to close the gap: drizzle keys applied
-- migrations by tag, so a rename reads as a brand-new migration and it would be
-- applied a second time on every database that already has it.
--
-- The table below is CREATE TABLE IF NOT EXISTS, so even that would be
-- survivable — but the journal would carry a duplicate for ever, and the next
-- person would have a harder puzzle than this comment.

-- Closed deals ingested from MT5 — the landing table for ARCHITECTURE §3.1's
-- push + sweep.
--
-- ── The unique index is the idempotency, and it is load-bearing ─────────────
--
-- Every deal is delivered TWICE by design: the bridge pushes it as it happens
-- and its sweep re-reads a rolling 24-hour window every five minutes, because
-- "push alone loses deals under network partition, and a lost deal is an unpaid
-- partner."
--
-- So `mt5_deals_deal_id_uq` is not a data-hygiene index — it is the mechanism.
-- Ingestion writes with ON CONFLICT DO NOTHING and reads the affected row count
-- to decide what to report. Application-level de-duplication would race itself
-- the first time both paths landed in the same instant, which on a five-minute
-- sweep happens several times a day.
--
-- ── Why the money columns are NUMERIC and arrive as strings ────────────────
--
-- `profit`, `commission` and `swap` are what the partner commission engine is
-- paid on. The MT5 Manager API deals in C doubles; the bridge converts once, at
-- that boundary, and sends decimal strings. They land here unparsed. Nothing
-- recomputes them from price and volume — the broker's server is the authority
-- on what a deal earned, and a recomputation that disagrees by a cent is a
-- dispute nobody can settle.
--
-- ── `login`, not a user id ────────────────────────────────────────────────
--
-- A deal names an MT5 login. The mapping to a client lives in
-- `trading_accounts.login` and is resolved at READ time, deliberately: a deal
-- can arrive before its account has been linked — normal during onboarding —
-- and a foreign key here would reject exactly the deal somebody needs later.
-- It is stored and picked up as soon as the link exists.

CREATE TABLE IF NOT EXISTS "mt5_deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mt5_deal_id" varchar(50) NOT NULL,
	"login" varchar(50) NOT NULL,
	"mt5_order_id" varchar(50),
	"mt5_position_id" varchar(50),
	"symbol" varchar(50) NOT NULL,
	-- MT5's own numeric action and entry, stored RAW rather than mapped to an
	-- enum. The server adds values across builds, and an enum that does not know
	-- the newest one turns an unrecognised deal into a failed insert.
	"action" integer NOT NULL,
	"entry" integer NOT NULL,
	"volume" numeric(28, 8) NOT NULL,
	"price" numeric(28, 8) NOT NULL,
	"profit" numeric(28, 8) NOT NULL,
	"commission" numeric(28, 8) NOT NULL,
	"swap" numeric(28, 8) NOT NULL,
	"comment" text,
	-- When MT5 says it happened, NOT when we heard about it. The sweep can
	-- deliver a deal hours late; the commission period it falls into is decided
	-- by this column.
	"dealt_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- 'push' or 'sweep'. Recorded so that "everything arrived via sweep for the
	-- last day" is answerable — that sentence means the push path is broken.
	"source" varchar(20) DEFAULT 'push' NOT NULL
);

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "mt5_deals_deal_id_uq" ON "mt5_deals" USING btree ("mt5_deal_id");

--> statement-breakpoint

-- The commission engine reads one login over a period; both are covered without
-- a sequential scan on a table that grows with every trade on the platform.
CREATE INDEX IF NOT EXISTS "mt5_deals_login_dealt_idx" ON "mt5_deals" USING btree ("login","dealt_at");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mt5_deals_dealt_idx" ON "mt5_deals" USING btree ("dealt_at");
