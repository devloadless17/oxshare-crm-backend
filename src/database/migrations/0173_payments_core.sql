-- 0173 — THE PAYMENTS CORE: provider-neutral money state and channel switches (30 Sep 2026).
--
-- The foundation (0168) made CONFIGURATION provider-neutral: providers,
-- channels, methods, settings, the event log. The MONEY state stayed Rival's:
-- a payout's claim, its provider id, a hosted deposit's provider id and the
-- needs-a-person flag all lived in `rival_*` columns, and the code that moved
-- money read them by name. A second provider (3pay, USDT) cannot live there —
-- its invoice numbers alone are 42 characters against `rival_external_id`'s 40.
--
-- So the state every provider shares gets neutral columns, written by ONE core
-- (payout and deposit engines) that asks each adapter only how to talk to its
-- provider:
--
--   provider_payment_id        the provider's id for a hosted deposit
--   provider_payment_url /     the hosted page and when it stops accepting
--   provider_payment_expires_at  money — what the client's waiting card shows
--   provider_payout_id         the provider's id for a payout
--   provider_submitted_at      the payout CLAIM (taken before the call)
--   payout_fingerprint         for providers whose payout API has no
--                              idempotency key and echoes no reference (3pay):
--                              at most ONE unresolved payout per fingerprint
--                              (channel, destination, amount asked), so a payout
--                              whose answer was lost is findable in the
--                              provider's list — enforced below, by an index
--   provider_request_amount    what the provider was asked to move (a payout
--                              grossed up by the provider's fee)
--   provider_fee / provider_net_amount   what the provider reported it took
--                              and moved — recorded, never posted
--   provider_amount_received   a deposit's figure as the provider reported it,
--                              at full precision
--   requested_amount           what a hosted deposit's link asked for, when the
--                              credited `amount` differs (a provider that
--                              credits what ARRIVED)
--   provider_status            the provider's last word on the movement, raw
--   provider_checked_at        when the core last asked — the sweep's order
--   needs_attention / attention_reason   a person must look (every provider)
--
-- ⚠️ ROLLBACK SAFETY. The previous build reads and writes `rival_*`. Until a
-- later migration drops them, a BEFORE trigger keeps the pairs in step: the
-- attention pair on every row, the id and claim pairs on Rival's rows (the
-- only rows the previous build knows how to settle). Whichever side a
-- statement writes wins; the neutral side wins a tie.
--
-- Written for both migration modes (backend CLAUDE.md): every statement stands
-- alone and is re-runnable.

-- ── 1. The neutral columns ─────────────────────────────────────────────────
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_payment_id" varchar(128);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_payment_url" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_payment_expires_at" timestamptz;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_payout_id" varchar(128);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_submitted_at" timestamptz;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payout_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_request_amount" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_fee" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_net_amount" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_amount_received" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "requested_amount" numeric(28, 8);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_status" varchar(40);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider_checked_at" timestamptz;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "needs_attention" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "attention_reason" text;--> statement-breakpoint

-- ── 2. Backfilled from Rival's columns ─────────────────────────────────────
-- coalesce/OR keep a re-run from overwriting what the new build has written.
UPDATE "transactions"
   SET "provider_payment_id"   = coalesce("provider_payment_id", "rival_external_id"),
       "provider_payout_id"    = coalesce("provider_payout_id", "rival_withdrawal_id"),
       "provider_submitted_at" = coalesce("provider_submitted_at", "rival_submitted_at"),
       "needs_attention"       = "needs_attention" OR "rival_needs_attention",
       "attention_reason"      = coalesce("attention_reason", "rival_attention_reason")
 WHERE ("rival_external_id" IS NOT NULL AND "provider_payment_id" IS NULL)
    OR ("rival_withdrawal_id" IS NOT NULL AND "provider_payout_id" IS NULL)
    OR ("rival_submitted_at" IS NOT NULL AND "provider_submitted_at" IS NULL)
    OR ("rival_needs_attention" AND NOT "needs_attention")
    OR ("rival_attention_reason" IS NOT NULL AND "attention_reason" IS NULL);--> statement-breakpoint

-- ── 3. Idempotency and findability, in constraints ─────────────────────────
-- One provider id belongs to one movement, per provider (Rival's global
-- `transactions_rival_*_uq` stay for the previous build).
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_provider_payment_id_uq"
  ON "transactions" ("provider_code", "provider_payment_id")
  WHERE "provider_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_provider_payout_id_uq"
  ON "transactions" ("provider_code", "provider_payout_id")
  WHERE "provider_payout_id" IS NOT NULL;--> statement-breakpoint
-- THE FINGERPRINT LOCK. A provider that takes no idempotency key and echoes no
-- reference can only be searched by what it was asked (network, address,
-- amount). Two unresolved payouts with the same fingerprint would make a lost
-- answer unattributable, so the second one's claim is refused here and it waits
-- until the first resolves — a queue, never a guess. Set only for such
-- providers; cleared with the claim; out of the index once the provider's id is
-- recorded or the row leaves 'approved'.
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_payout_fingerprint_uq"
  ON "transactions" ("provider_code", "payout_fingerprint")
  WHERE "payout_fingerprint" IS NOT NULL
    AND "provider_payout_id" IS NULL
    AND "state" = 'approved';--> statement-breakpoint

-- "Needs attention" is rare by design (0165's reasoning): the tab reads this.
CREATE INDEX IF NOT EXISTS "transactions_needs_attention_created_at_id_idx"
  ON "transactions" ("created_at" DESC, "id" DESC) WHERE "needs_attention";--> statement-breakpoint
-- The reconciler's work list: open movements on a provider, least recently
-- asked first.
CREATE INDEX IF NOT EXISTS "transactions_provider_open_idx"
  ON "transactions" ("provider_code", "provider_checked_at" NULLS FIRST)
  WHERE "state" IN ('pending', 'approved') AND "provider_code" <> 'manual';--> statement-breakpoint

-- ── 4. The mirror (rollback safety; dropped with `rival_*`) ────────────────
CREATE OR REPLACE FUNCTION transactions_mirror_rival_columns() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."needs_attention" := NEW."needs_attention" OR NEW."rival_needs_attention";
    NEW."rival_needs_attention" := NEW."needs_attention";
    NEW."attention_reason" := coalesce(NEW."attention_reason", NEW."rival_attention_reason");
    NEW."rival_attention_reason" := NEW."attention_reason";
    IF NEW."provider_code" = 'rival' THEN
      NEW."provider_payment_id" := coalesce(NEW."provider_payment_id", NEW."rival_external_id");
      NEW."rival_external_id" := NEW."provider_payment_id";
      NEW."provider_payout_id" := coalesce(NEW."provider_payout_id", NEW."rival_withdrawal_id");
      NEW."rival_withdrawal_id" := NEW."provider_payout_id";
      NEW."provider_submitted_at" := coalesce(NEW."provider_submitted_at", NEW."rival_submitted_at");
      NEW."rival_submitted_at" := NEW."provider_submitted_at";
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: the side this statement changed wins; the neutral side wins a tie.
  IF NEW."needs_attention" IS DISTINCT FROM OLD."needs_attention" THEN
    NEW."rival_needs_attention" := NEW."needs_attention";
  ELSIF NEW."rival_needs_attention" IS DISTINCT FROM OLD."rival_needs_attention" THEN
    NEW."needs_attention" := NEW."rival_needs_attention";
  END IF;
  IF NEW."attention_reason" IS DISTINCT FROM OLD."attention_reason" THEN
    NEW."rival_attention_reason" := NEW."attention_reason";
  ELSIF NEW."rival_attention_reason" IS DISTINCT FROM OLD."rival_attention_reason" THEN
    NEW."attention_reason" := NEW."rival_attention_reason";
  END IF;
  IF NEW."provider_code" = 'rival' THEN
    IF NEW."provider_payment_id" IS DISTINCT FROM OLD."provider_payment_id" THEN
      NEW."rival_external_id" := NEW."provider_payment_id";
    ELSIF NEW."rival_external_id" IS DISTINCT FROM OLD."rival_external_id" THEN
      NEW."provider_payment_id" := NEW."rival_external_id";
    END IF;
    IF NEW."provider_payout_id" IS DISTINCT FROM OLD."provider_payout_id" THEN
      NEW."rival_withdrawal_id" := NEW."provider_payout_id";
    ELSIF NEW."rival_withdrawal_id" IS DISTINCT FROM OLD."rival_withdrawal_id" THEN
      NEW."provider_payout_id" := NEW."rival_withdrawal_id";
    END IF;
    IF NEW."provider_submitted_at" IS DISTINCT FROM OLD."provider_submitted_at" THEN
      NEW."rival_submitted_at" := NEW."provider_submitted_at";
    ELSIF NEW."rival_submitted_at" IS DISTINCT FROM OLD."rival_submitted_at" THEN
      NEW."provider_submitted_at" := NEW."rival_submitted_at";
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "transactions_mirror_rival_columns" ON "transactions";--> statement-breakpoint
DROP TRIGGER IF EXISTS "transactions_sync_rival_columns" ON "transactions";--> statement-breakpoint
-- NAMED to fire AFTER `transactions_route_default` (0168): Postgres fires
-- same-kind triggers in NAME order, and a legacy INSERT that names no route
-- only has `provider_code = 'rival'` once that one has run.
CREATE TRIGGER "transactions_sync_rival_columns"
  BEFORE INSERT OR UPDATE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION transactions_mirror_rival_columns();--> statement-breakpoint

-- ── 5. Admin tasks end on the neutral flag (0140, redefined) ───────────────
-- The provider-neutral payout task kinds join Rival's (still named for the
-- rows already raised).
CREATE OR REPLACE FUNCTION transactions_resolve_admin_tasks() RETURNS trigger AS $$
DECLARE
  v_actor uuid := CASE
    WHEN NEW."reviewed_by" IS DISTINCT FROM OLD."reviewed_by"
      OR NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at"
    THEN NEW."reviewed_by"
  END;
BEGIN
  IF (OLD."state" = 'pending' AND NEW."state" <> 'pending')
     OR (OLD."state" NOT IN ('success', 'failure', 'rejected')
         AND NEW."state" IN ('success', 'failure', 'rejected')) THEN
    PERFORM resolve_admin_notifications('transaction', NEW."id", NEW."state"::text, v_actor);
  END IF;
  IF OLD."needs_attention" AND NOT NEW."needs_attention" THEN
    PERFORM resolve_admin_notifications(
      'transaction', NEW."id", 'resolved', v_actor,
      ARRAY[
        'admin.deposit.attention',
        'withdrawal.payout_submit_failed', 'withdrawal.payout_attention',
        'withdrawal.rival_submit_failed', 'withdrawal.rival_attention'
      ]
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "transactions_resolve_admin_tasks" ON "transactions";--> statement-breakpoint
-- Both flags in the column list: `UPDATE OF` matches the columns a statement
-- SETS, never the ones a BEFORE trigger changes — so the previous build (which
-- sets `rival_needs_attention`) and this one (which sets `needs_attention`)
-- must each fire it. WHEN reads the final row, where the mirror has made them
-- equal.
CREATE TRIGGER "transactions_resolve_admin_tasks"
  AFTER UPDATE OF "state", "needs_attention", "rival_needs_attention" ON "transactions"
  FOR EACH ROW
  WHEN (OLD."state" IS DISTINCT FROM NEW."state"
        OR OLD."needs_attention" IS DISTINCT FROM NEW."needs_attention")
  EXECUTE FUNCTION transactions_resolve_admin_tasks();--> statement-breakpoint

-- ── 6. Channel switches: a network on or off, per direction ────────────────
-- The owner's control (30 Sep 2026): e.g. 3pay's ERC20 payouts off while
-- TRC20 stays on. No row means ON. Switched off, a channel's methods leave
-- the client's lists and new movements are refused; movements already under
-- way still finish. A reason is required to switch one off.
CREATE TABLE IF NOT EXISTS "payment_provider_channels" (
  "provider_code" varchar(40) NOT NULL REFERENCES "payment_providers" ("code") ON DELETE RESTRICT,
  "direction" varchar(10) NOT NULL,
  "channel_code" varchar(40) NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "reason" text,
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("provider_code", "direction", "channel_code"),
  CONSTRAINT "payment_provider_channels_direction_ck" CHECK ("direction" IN ('deposit', 'payout')),
  CONSTRAINT "payment_provider_channels_reason_ck"
    CHECK ("enabled" OR length(btrim(coalesce("reason", ''))) > 0)
);--> statement-breakpoint

-- ── 7. One reconciler for every provider ───────────────────────────────────
-- `rival.reconcile` becomes the provider-neutral job; the interval an operator
-- set is kept. (A previous build re-creates its own row at the default.)
UPDATE "scheduled_jobs" SET "key" = 'payments.reconcileProviders'
 WHERE "key" = 'rival.reconcile'
   AND NOT EXISTS (SELECT 1 FROM "scheduled_jobs" WHERE "key" = 'payments.reconcileProviders');
