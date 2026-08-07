-- The commission engine's ledger of what partners have earned.
--
-- Hand-written rather than generated, matching 0027 onwards: the committed
-- drizzle snapshots stop at 0026, so `drizzle-kit generate` diffs against a
-- baseline thirteen migrations stale and prompts to rename a dozen unrelated
-- enums. The DDL here is the same shape `schema.ts` declares.
--
-- ── What this brings back, and what it deliberately does not ────────────────
--
-- Migration 0028 dropped `commission_accruals` along with `deals`, `ib_programs`
-- and the whole commission engine. Its teardown note recorded the guarantee that
-- went with it: `ledger_entries_wallet_reference_uq` was the ONLY database-level
-- guard against a replayed credit, and "the money rebuild MUST reintroduce an
-- idempotency key before any payment provider is connected".
--
-- That constraint came back in 0033. This migration adds the second one, for the
-- layer above it: `ib_accruals_source_earner_uq` is what makes a replayed
-- deposit callback accrue once rather than twice.
--
-- This is NOT a restore of the old table. That one keyed off `deals.id` and read
-- its rates from `ib_programs`, and both are gone with the MT5 bridge — a
-- restore would be an engine that can never run. This one keys off whatever
-- moved the money (`source_type` / `source_id`) and reads rates from `ib_levels`.
--
-- ── Why accruals exist at all, rather than crediting the wallet directly ────
--
-- A commission is EARNED at one moment and PAYABLE at another. Crediting the
-- partner the instant a client deposits would make the commission irreversible
-- before the revenue behind it settled, and a reversed deposit would leave a
-- partner holding money recoverable only by a compensating entry with no record
-- of what it compensates. So: `pending` on accrual, `confirmed` once credited,
-- `reversed` when the underlying revenue is undone. The ROW is the record; the
-- wallet credit is a consequence of it.

CREATE TYPE "public"."ib_accrual_status" AS ENUM('pending', 'confirmed', 'reversed');
--> statement-breakpoint

CREATE TABLE "ib_accruals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The partner who earned it, and the client whose activity generated it.
  -- RESTRICT on both, matching every other FK to `users` that money references:
  -- a person with financial history is never deleted out from under the rows
  -- that explain their balance.
  "ib_user_id" uuid NOT NULL,
  "client_user_id" uuid NOT NULL,
  -- What moved the money. 'transaction' today; a deal feed brings its own.
  -- varchar rather than an enum because the set grows with each revenue source,
  -- and adding a string should not be a migration.
  "source_type" varchar(50) NOT NULL,
  "source_id" uuid NOT NULL,
  -- Depth above the client (1 = introducer, 2 = their parent) and the rung held
  -- at the time. BOTH stored, because the hierarchy can be reassigned later and
  -- an accrual must stay explainable against the tree as it was when earned.
  "depth" integer NOT NULL,
  "level" integer NOT NULL,
  -- The rate applied, so the arithmetic is reproducible from the row alone
  -- without re-reading a levels table that may since have been edited.
  "rate_value" numeric(12, 4) NOT NULL,
  -- §6.1: NUMERIC(28,8) throughout, never a float, a string at every boundary.
  "base_amount" numeric(28, 8) NOT NULL,
  "amount" numeric(28, 8) NOT NULL,
  "currency" varchar(10) NOT NULL,
  "status" "ib_accrual_status" DEFAULT 'pending' NOT NULL,
  -- The ledger entry that paid it. NULL while pending; written in the SAME
  -- transaction as the credit, so "confirmed with no entry" is unreachable.
  "ledger_entry_id" uuid,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- A commission is a share of revenue and can never be negative. A clawback is
  -- a REVERSAL of the row, not a negative accrual — the same reasoning that
  -- makes `ledger_entries` append-only with compensating rows.
  CONSTRAINT "ib_accruals_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "ib_accruals_depth_range" CHECK ("depth" >= 1 AND "depth" <= 2)
);
--> statement-breakpoint

ALTER TABLE "ib_accruals" ADD CONSTRAINT "ib_accruals_ib_user_id_users_id_fk"
  FOREIGN KEY ("ib_user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "ib_accruals" ADD CONSTRAINT "ib_accruals_client_user_id_users_id_fk"
  FOREIGN KEY ("client_user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "ib_accruals" ADD CONSTRAINT "ib_accruals_currency_currencies_code_fk"
  FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- RESTRICT, like every other reference to a ledger entry: the entry is the
-- evidence that this accrual was paid, and deleting it would leave a confirmed
-- accrual pointing at nothing.
ALTER TABLE "ib_accruals" ADD CONSTRAINT "ib_accruals_ledger_entry_id_ledger_entries_id_fk"
  FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

-- ⚠️ THE IDEMPOTENCY GUARANTEE (§6.3), and the reason this file exists.
--
-- One accrual per earner per source event. A replayed provider callback, a
-- retried job and a double-clicked approval all collapse onto the same row —
-- the insert is ON CONFLICT DO NOTHING, never a check-then-insert, because
-- every check-then-insert loses under concurrency.
--
-- `depth` is deliberately NOT part of the key: one partner cannot legitimately
-- earn twice from one event, and including it would let a cycle in the tree pay
-- somebody at both depth 1 and depth 2 for the same deposit.
CREATE UNIQUE INDEX "ib_accruals_source_earner_uq"
  ON "ib_accruals" USING btree ("source_type", "source_id", "ib_user_id");
--> statement-breakpoint

-- "What has this partner earned?" — the partner overview's own query.
CREATE INDEX "ib_accruals_ib_user_idx"
  ON "ib_accruals" USING btree ("ib_user_id", "created_at");
--> statement-breakpoint

-- The hourly confirm job: everything still pending, oldest first.
CREATE INDEX "ib_accruals_status_idx"
  ON "ib_accruals" USING btree ("status", "created_at");
