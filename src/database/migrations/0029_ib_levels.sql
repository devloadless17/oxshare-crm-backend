-- The IB payout ladder.
--
-- Rows here are the DEPTH of the earnings chain, not a cap on partner count:
-- level 1 is a partner dealing with the broker directly, level 2 was recruited
-- by an L1, and revenue from a client flows upward through as many levels as
-- exist. Two rows means "pay the direct partner and their parent, then stop".
--
-- ── Why the rate carries a MODEL ────────────────────────────────────────────
--
-- Checked against several forex-CRM vendors before settling this: brokers run
-- fixed per-lot rebates OR revenue-share percentages, and many run both across
-- different programmes. A percentage-only column would have needed a migration
-- on a table that partner records reference, the first time the business
-- changed its mind. So `payout_model` decides what `rate_value` means, and it
-- is NOT NULL.
--
-- CPA — a one-off payment per funded client — is deliberately not a third
-- value. It is a per-client event with its own qualification rules, not a
-- per-level rate, and folding it in would make one column mean three things.
--
-- ── Seeded with TWO levels ──────────────────────────────────────────────────
--
-- The requested default, and the common shape in this industry. The split is
-- 70/30 rather than 50/50 because the partner who actually introduced the
-- client does the work; an override matching their share gives an L1 no reason
-- to keep recruiting clients directly. Both figures are operator-editable from
-- the admin screen — a starting point, not a rule.
--
-- Under revenue_share the enabled levels must total <= 100. That is enforced in
-- `IbLevelsService`, not by a CHECK: a row-level constraint cannot see the
-- other rows, and a trigger would be a second place to look for one rule.

CREATE TYPE "public"."ib_payout_model" AS ENUM('revenue_share', 'per_lot');--> statement-breakpoint

CREATE TABLE "ib_levels" (
	"level" integer PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"payout_model" "ib_payout_model" DEFAULT 'revenue_share' NOT NULL,
	-- 12,4 because it holds both a percentage (30.0000) and a per-lot amount
	-- ($2.5000), and per-lot rates are quoted in cents at the low end.
	"rate_value" numeric(12, 4) DEFAULT '0' NOT NULL,
	"max_direct_partners" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- `max_direct_partners` is NULL on both: unlimited until an operator decides
-- otherwise. A number invented here would be a limit nobody asked for, applied
-- to every partner, and discovered only when an approval was refused.
INSERT INTO "ib_levels" ("level", "name", "payout_model", "rate_value", "max_direct_partners", "enabled") VALUES
	(1, 'Master Partner', 'revenue_share', 70.0000, NULL, true),
	(2, 'Sub Partner', 'revenue_share', 30.0000, NULL, true);
