-- Partner applications, partner accounts, and the wallet that holds a balance.
--
-- ── Two tables for one partner, on purpose ──────────────────────────────────
--
-- `ib_applications` is the REQUEST; `ib_accounts` is the GRANT. A single table
-- with a status column makes "is this person a partner" a two-part question,
-- and the day one caller asks only the first half, a rejected applicant is a
-- partner. Here the question is `SELECT FROM ib_accounts` and there is no
-- second half. It also lets a rejected applicant re-apply without overwriting
-- the refusal they were shown.
--
-- ── The wallet is back, smaller than it was ─────────────────────────────────
--
-- 0028 dropped `wallets` together with `ledger_entries`, `transactions` and
-- `transfers`. This restores only the balance holder: the partner programme
-- needs somewhere for a commission to land, and registration needs a wallet to
-- open.
--
-- ⚠️ The idempotency guarantee has NOT come back with it. `ledger_entries`
-- carried ON CONFLICT (wallet, reference_type, reference_id) — the only
-- database-level guard against a replayed deposit crediting a client twice.
-- Nothing writes to `balance` yet, so nothing is at risk today, but the first
-- code that credits it must restore the ledger and that constraint alongside
-- (§6.2, §6.3). A service-level "have I seen this reference before?" is not a
-- substitute; a service check is exactly what the constraint existed to survive.

CREATE TYPE "public"."ib_application_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint

CREATE TABLE "ib_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"motivation" text,
	-- Self-reported and unverified. Labelled as such on the review screen, so a
	-- reviewer does not read it as a figure the platform stands behind.
	"expected_volume" varchar(120),
	"website" varchar(2048),
	"status" "ib_application_status" DEFAULT 'pending' NOT NULL,
	-- Stored already composed (configured reason + optional note), because that
	-- is the sentence the client was shown. Re-deriving it later from parts that
	-- an operator may since have edited would show them a different one.
	"rejection_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "ib_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"level" integer NOT NULL,
	-- NULL means they deal with the broker directly — the top of a chain.
	"parent_ib_user_id" uuid,
	"referral_code" varchar(50) NOT NULL,
	-- Suspension keeps the code and the tree and stops the earning. Deleting the
	-- row instead would orphan every client attributed beneath them.
	"active" boolean DEFAULT true NOT NULL,
	"application_id" uuid,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ib_accounts_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint

CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" varchar(10) NOT NULL,
	-- 28,8 per §6.1 — eight places because a crypto balance needs them, and a
	-- column that cannot hold one has to be migrated under a live balance later.
	"balance" numeric(28, 8) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The last line between a bug in a debit path and a client silently owing
	-- the broker money. Expressible per row, so it belongs in the database.
	CONSTRAINT "wallets_balance_non_negative" CHECK ("wallets"."balance" >= 0)
);
--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────────────
--
-- `restrict` throughout, matching every other table that references a client:
-- a DELETE FROM users should fail loudly rather than quietly take a partner
-- hierarchy or a balance with it.

ALTER TABLE "ib_applications" ADD CONSTRAINT "ib_applications_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "ib_accounts" ADD CONSTRAINT "ib_accounts_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "ib_accounts" ADD CONSTRAINT "ib_accounts_level_ib_levels_level_fk"
	FOREIGN KEY ("level") REFERENCES "public"."ib_levels"("level") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- A REAL constraint this time. The deleted `ib_profiles.parent_ib_id` was a bare
-- uuid, so a parent could point at a row that had never existed. This chain is
-- walked per commission calculation; a dangling link in it is a payout that
-- silently stops halfway up.
--
-- Postgres still will not stop a CYCLE — a self-FK only checks the target
-- exists. `wouldCreateCycle` in the service is what does, on every reassignment.
ALTER TABLE "ib_accounts" ADD CONSTRAINT "ib_accounts_parent_fk"
	FOREIGN KEY ("parent_ib_user_id") REFERENCES "public"."ib_accounts"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "ib_accounts" ADD CONSTRAINT "ib_accounts_application_id_ib_applications_id_fk"
	FOREIGN KEY ("application_id") REFERENCES "public"."ib_applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk"
	FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "wallets" ADD CONSTRAINT "wallets_currency_currencies_code_fk"
	FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ── Indexes ─────────────────────────────────────────────────────────────────

-- At most one PENDING application per user. PARTIAL, because the rule applies
-- only to `pending` — a user may have any number of rejected attempts behind
-- them. A read-then-insert loses to a double-submit: two clicks, two requests,
-- both read zero, both insert, and the same person appears twice in the queue.
CREATE UNIQUE INDEX "ib_applications_one_pending_uq" ON "ib_applications" ("user_id") WHERE "ib_applications"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ib_applications_status_submitted_idx" ON "ib_applications" ("status","submitted_at");--> statement-breakpoint

-- The hot read on approval: "how many partners does this parent already hold?",
-- which is what enforces `ib_levels.max_direct_partners`.
CREATE INDEX "ib_accounts_parent_idx" ON "ib_accounts" ("parent_ib_user_id");--> statement-breakpoint
CREATE INDEX "ib_accounts_level_idx" ON "ib_accounts" ("level");--> statement-breakpoint

-- One wallet per user per currency, in the database. "Open a wallet if they
-- have none" is a read-then-insert, and two concurrent registrations of the
-- same account otherwise leave a client with two USD wallets and a balance
-- split across them. The insert expects this and treats the conflict as success.
CREATE UNIQUE INDEX "wallets_user_currency_uq" ON "wallets" ("user_id","currency");--> statement-breakpoint
CREATE INDEX "wallets_user_idx" ON "wallets" ("user_id");--> statement-breakpoint

-- 'partner' joins 'kyc' and 'withdrawal': the reject dialog loads its options by
-- context, and without this the partner reviewer gets an empty list.
--
-- The reasons themselves are seeded in `seed.ts`, and that is not a preference.
-- `ADD VALUE` is legal inside a transaction on PG12+ (0027 records the same
-- rule), but the new label cannot be USED until that transaction COMMITS — and
-- Drizzle's migrator runs every pending migration inside ONE transaction. So an
-- INSERT with context 'partner' fails not only below this line but from any
-- later migration file too; moving it to 0031 was tried and failed with
-- 55P04 'New enum values must be committed before they can be used'. Seeds run
-- after migration commits, which is the only place that insert is legal on a
-- fresh database.
ALTER TYPE "public"."rejection_context" ADD VALUE 'partner';
