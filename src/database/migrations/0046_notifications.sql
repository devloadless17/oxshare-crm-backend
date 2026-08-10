-- The in-app notification feed behind the bell in both frontends.
--
-- Hand-written rather than generated, matching 0027 onwards: the committed
-- drizzle snapshots stop at 0026, so `drizzle-kit generate` diffs against a
-- stale baseline. The DDL here is the same shape `schema.ts` declares.
--
-- ── One table, polymorphic recipient, no foreign key ────────────────────────
--
-- `recipient_id` deliberately carries NO foreign key: it points at `users` or
-- `admins` depending on `recipient_kind`, and Postgres cannot express a
-- polymorphic reference. This is the `audit_log.actor_id` precedent. Neither
-- principal table deletes rows (clients are never deleted; admins are
-- suspended, not removed), so orphaned recipients are not a live risk.
--
-- ── The dedupe index is the replay guard ────────────────────────────────────
--
-- Two of the paths that write here are at-least-once: a provider callback that
-- settles a deposit can be replayed, and the hourly commission confirm loop
-- re-runs by design. The partial unique index on
-- (recipient_kind, recipient_id, dedupe_key) is what makes a replayed event
-- produce ONE row rather than two — the insert lands with ON CONFLICT DO
-- NOTHING, never a check-then-insert (§6.3, same stance as
-- `ib_accruals_source_earner_uq` one layer down). Paths that cannot replay
-- (a conditional state transition already absorbed the retry) leave the key
-- NULL, which the partial index ignores.
--
-- ── No stored copy ──────────────────────────────────────────────────────────
--
-- There is no title, body or link column. Rows carry a `kind` slug plus
-- structured `params`; each frontend owns the copy (i18n'd in messages.ts) and
-- derives the deep link. `kind` is varchar, not an enum, so a new event in the
-- catalogue does not need a migration. Money values inside `params` are
-- strings, per §6.1.
--
-- ── Idempotent on purpose, like 0045_mt5_deals ──────────────────────────────
--
-- The drizzle migrator gates on `when` being GREATER than the last applied
-- migration's, and both this file's original `when` and 0045_mt5_deals' were
-- wrong in ways that silently skipped them on already-migrated databases. The
-- journal `when`s were corrected, which makes machines that had already
-- applied one of them RE-RUN it — so every statement here must converge
-- rather than fail on the second pass.

DO $$ BEGIN
  CREATE TYPE "public"."notification_recipient_kind" AS ENUM('client', 'admin');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recipient_kind" "notification_recipient_kind" NOT NULL,
  -- Bare uuid on purpose — see the header note on the polymorphic recipient.
  "recipient_id" uuid NOT NULL,
  -- Catalogue slug, e.g. 'withdrawal.approved'.
  "kind" varchar(100) NOT NULL,
  "params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dedupe_key" varchar(255),
  "read_at" timestamp with time zone,
  -- Millisecond precision, deliberately: the keyset cursor round-trips this
  -- value through a JS Date (ms-truncated), and at microsecond precision a
  -- row sharing the boundary row's millisecond silently vanishes from paging.
  "created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Converges databases created before the precision was pinned (see above);
-- a no-op where the column is already timestamptz(3).
ALTER TABLE "notifications" ALTER COLUMN "created_at" TYPE timestamp (3) with time zone;
--> statement-breakpoint

-- The replay guard. Partial: rows without a dedupe key opted out.
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_recipient_dedupe_uq"
  ON "notifications" ("recipient_kind", "recipient_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;
--> statement-breakpoint

-- Keyset paging for the feed: both ORDER BY keys in the same direction.
CREATE INDEX IF NOT EXISTS "notifications_recipient_created_idx"
  ON "notifications" ("recipient_kind", "recipient_id", "created_at", "id");
--> statement-breakpoint

-- The 60-second unread-count poll, as an index-only scan of a small set.
CREATE INDEX IF NOT EXISTS "notifications_recipient_unread_idx"
  ON "notifications" ("recipient_kind", "recipient_id")
  WHERE "read_at" IS NULL;
