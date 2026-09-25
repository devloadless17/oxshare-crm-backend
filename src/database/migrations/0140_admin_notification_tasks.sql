-- 0140 — An admin notification is a TASK: it names the item it is about, it is
-- scope-checked when it is READ, and it resolves itself — for every admin at
-- once — the moment anybody handles that item.
--
-- Hand-written rather than generated, matching 0027 onwards. Re-runnable on
-- purpose (IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS / guarded
-- backfills): see the migration-renumber watermark note in CLAUDE.md.
--
-- ── What the owner reported, and why it could not be fixed in the UI ───────
--
-- "When a notification is handled — approved or rejected — it keeps showing."
-- A bell row was a fire-once event holding nothing but `read_at`. No column
-- said WHICH withdrawal, KYC submission or IB application it announced, so no
-- decision could find the rows about it, and none tried: every admin kept an
-- unread "withdrawal requested" after somebody approved it, the approver too.
--
-- ── Resolution belongs to the DATABASE, not to the call sites ───────────────
--
-- Thirteen code paths move these items out of their queues — desk decisions,
-- the Rival webhook and poller, the system settle and refund, a client's KYC
-- reset, IB rejection (which runs no transaction at all), the stuck-transfer
-- release, a commission reversal. Asking each to remember "and resolve the
-- bell" is how the next path forgets, and the bug class returns silently. So
-- the rule lives beside the data, in AFTER triggers on the item tables: an
-- item that LEAVES the state that made it a task resolves every open row about
-- it, whoever or whatever moved it. Same stance as 0047 ("the bus is the
-- database") and the ledger's append-only triggers.
--
-- ── A bell can never veto the decision it describes ─────────────────────────
--
-- The triggers run inside the caller's transaction — a withdrawal approval, a
-- deposit credit. 0061 set the rule: a notification must never be able to roll
-- back the money movement it announces. `resolve_admin_notifications` catches
-- everything it could raise, in its own subtransaction, and logs a WARNING;
-- the row simply stays "needs action", which is the honest reading of a
-- resolution that did not happen.
--
-- ── Read-time scope needs a subject client ──────────────────────────────────
--
-- The feed was `@NotClientScoped`, bounded only by the fan-out at WRITE time,
-- so a re-tagged client's rows stayed readable by the desk that lost them. The
-- reason given was that rows carried no identity — true until a row has to
-- name its client, which a useful task must. `subject_user_id` is the column
-- that reason said was missing; the CHECK makes an admin row without one
-- impossible, because a row that cannot be scope-checked cannot be shown.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "subject_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "subject_kind" varchar(24);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "subject_id" uuid;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp (3) with time zone;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "resolution" varchar(24);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "resolved_by" uuid;
--> statement-breakpoint

-- ── Backfill: the subject of every admin row that stays a task ──────────────
--
-- Each cast sits behind a CASE on the uuid shape. A bare `AND … ~ uuid AND
-- …::uuid = x` does not protect the cast: SQL fixes no evaluation order for
-- AND, and one malformed legacy value would abort the whole migration.

UPDATE "notifications" n
   SET "subject_kind" = 'transaction', "subject_id" = t."id", "subject_user_id" = t."user_id"
  FROM "transactions" t
 WHERE n."recipient_kind" = 'admin'
   AND n."subject_id" IS NULL
   AND n."kind" IN (
     'admin.withdrawal.requested', 'admin.deposit.submitted',
     'withdrawal.rival_submit_failed', 'withdrawal.rival_attention'
   )
   AND t."id" = CASE
     WHEN n."params"->>'transactionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (n."params"->>'transactionId')::uuid
   END;
--> statement-breakpoint

-- KYC is keyed on the client: `kyc_submissions.user_id` is its primary key.
UPDATE "notifications" n
   SET "subject_kind" = 'kyc', "subject_id" = u."id", "subject_user_id" = u."id"
  FROM "users" u
 WHERE n."recipient_kind" = 'admin'
   AND n."subject_id" IS NULL
   AND n."kind" IN ('admin.kyc.submitted', 'admin.kyc.resubmitted')
   AND u."id" = CASE
     WHEN n."params"->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (n."params"->>'userId')::uuid
   END;
--> statement-breakpoint

UPDATE "notifications" n
   SET "subject_kind" = 'ib_application', "subject_id" = a."id", "subject_user_id" = a."user_id"
  FROM "ib_applications" a
 WHERE n."recipient_kind" = 'admin'
   AND n."subject_id" IS NULL
   AND n."kind" = 'admin.partner.applied'
   AND a."id" = CASE
     WHEN n."params"->>'applicationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (n."params"->>'applicationId')::uuid
   END;
--> statement-breakpoint

-- What remains without a subject is either a kind that is no longer a task
-- (a registration, an opened account, a completed or auto-refunded payout) or
-- a row naming something that no longer resolves. Neither may be shown: the
-- first is not work, the second cannot be scope-checked.
DELETE FROM "notifications"
 WHERE "recipient_kind" = 'admin'
   AND ("subject_id" IS NULL OR "subject_user_id" IS NULL OR "subject_kind" IS NULL);
--> statement-breakpoint

-- ── Backfill: resolve the tasks that were already handled ───────────────────
--
-- So the bell is truthful the minute this deploys, instead of carrying every
-- stale "please approve" until someone clicks it away. `resolved_by` is set
-- only where the item's reviewer column describes THIS outcome — a cancel
-- (`markFailed`) never writes it, so a failure keeps it NULL rather than
-- crediting the admin who approved.

UPDATE "notifications" n
   SET "resolved_at" = coalesce(
         CASE WHEN t."state" IN ('approved', 'rejected') THEN t."reviewed_at" END,
         t."settled_at", t."reviewed_at", now()
       ),
       "resolution" = t."state"::text,
       "resolved_by" = CASE WHEN t."state" IN ('approved', 'success', 'rejected') THEN t."reviewed_by" END
  FROM "transactions" t
 WHERE n."recipient_kind" = 'admin'
   AND n."resolved_at" IS NULL
   AND n."subject_kind" = 'transaction'
   AND t."id" = n."subject_id"
   AND n."kind" IN ('admin.withdrawal.requested', 'admin.deposit.submitted')
   AND t."state" <> 'pending';
--> statement-breakpoint

UPDATE "notifications" n
   SET "resolved_at" = coalesce(t."settled_at", now()),
       "resolution" = CASE WHEN t."rival_needs_attention" THEN t."state"::text ELSE 'resolved' END
  FROM "transactions" t
 WHERE n."recipient_kind" = 'admin'
   AND n."resolved_at" IS NULL
   AND n."subject_kind" = 'transaction'
   AND t."id" = n."subject_id"
   AND (
     (n."kind" = 'withdrawal.rival_submit_failed'
       AND (NOT t."rival_needs_attention" OR t."state" IN ('success', 'failure', 'rejected')))
     OR (n."kind" = 'withdrawal.rival_attention' AND NOT t."rival_needs_attention")
   );
--> statement-breakpoint

-- KYC reuses one row per client across attempts, so "the status is no longer
-- pending" is not enough: a first submission that was rejected and then
-- RESUBMITTED reads 'submitted' again. Every decision is archived as an
-- attempt, though, so a row's own outcome is exact: the first decision made
-- after the row was raised — with its real reviewer and its real time.
WITH decided AS (
  SELECT n."id" AS notification_id, a."status"::text AS outcome, a."reviewed_at", a."reviewed_by"
    FROM "notifications" n
    JOIN LATERAL (
      SELECT sa."status", sa."reviewed_at", sa."reviewed_by"
        FROM "kyc_submission_attempts" sa
       WHERE sa."user_id" = n."subject_id"
         AND sa."reviewed_at" >= n."created_at"
       ORDER BY sa."reviewed_at" ASC
       LIMIT 1
    ) a ON true
   WHERE n."recipient_kind" = 'admin'
     AND n."resolved_at" IS NULL
     AND n."subject_kind" = 'kyc'
)
UPDATE "notifications" n
   SET "resolved_at" = d."reviewed_at", "resolution" = d.outcome, "resolved_by" = d."reviewed_by"
  FROM decided d
 WHERE n."id" = d.notification_id;
--> statement-breakpoint

-- What the archive cannot place: a client whose KYC was reset (the row is
-- gone), or one out of review with no archived decision after this row. The
-- only way out of review short of a reset is a decision, and one followed by
-- more editing is a rejection.
UPDATE "notifications" n
   SET "resolved_at" = now(),
       "resolution" = CASE
         WHEN k."user_id" IS NULL THEN 'reset'
         WHEN k."status" IN ('approved', 'rejected') THEN k."status"::text
         ELSE 'rejected'
       END
  FROM "notifications" self
  LEFT JOIN "kyc_submissions" k ON k."user_id" = self."subject_id"
 WHERE self."id" = n."id"
   AND n."recipient_kind" = 'admin'
   AND n."resolved_at" IS NULL
   AND n."subject_kind" = 'kyc'
   AND (k."user_id" IS NULL OR k."status" NOT IN ('submitted', 'under_review'));
--> statement-breakpoint

UPDATE "notifications" n
   SET "resolved_at" = coalesce(a."reviewed_at", now()),
       "resolution" = a."status"::text,
       "resolved_by" = a."reviewed_by"
  FROM "ib_applications" a
 WHERE n."recipient_kind" = 'admin'
   AND n."resolved_at" IS NULL
   AND n."subject_kind" = 'ib_application'
   AND a."id" = n."subject_id"
   AND a."status" <> 'pending';
--> statement-breakpoint

-- ── The client bell drops its echoes ────────────────────────────────────────
--
-- "Trading account opened" and an instant "transfer completed" repeat what the
-- client just did and already saw on screen; new ones are no longer written
-- (the instant transfer is judged at write time). Existing unread ones are
-- cleared so the portal opens clean.
UPDATE "notifications"
   SET "read_at" = now()
 WHERE "recipient_kind" = 'client'
   AND "read_at" IS NULL
   AND "kind" IN ('trading_account.opened', 'transfer.completed');
--> statement-breakpoint

-- ── Invariants ──────────────────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_admin_subject_ck" CHECK (
    "recipient_kind" <> 'admin'
    OR ("subject_user_id" IS NOT NULL AND "subject_kind" IS NOT NULL AND "subject_id" IS NOT NULL)
  ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "notifications" VALIDATE CONSTRAINT "notifications_admin_subject_ck";
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subject_kind_ck" CHECK (
    "subject_kind" IS NULL
    OR "subject_kind" IN ('transaction', 'kyc', 'ib_application', 'transfer', 'ib_accrual')
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- The Inbox — the badge count and the default tab — as a scan of exactly the
-- rows that are still somebody's work.
CREATE INDEX IF NOT EXISTS "notifications_admin_inbox_idx"
  ON "notifications" ("recipient_id", "created_at" DESC, "id" DESC)
  WHERE "recipient_kind" = 'admin' AND "read_at" IS NULL AND "resolved_at" IS NULL;
--> statement-breakpoint

-- What the triggers below look up: the still-open rows about one item.
CREATE INDEX IF NOT EXISTS "notifications_subject_open_idx"
  ON "notifications" ("subject_kind", "subject_id")
  WHERE "resolved_at" IS NULL;
--> statement-breakpoint

-- ── The resolver ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION resolve_admin_notifications(
  p_subject_kind text,
  p_subject_id uuid,
  p_resolution text,
  p_resolved_by uuid,
  p_kinds text[] DEFAULT NULL
) RETURNS void AS $$
BEGIN
  UPDATE "notifications"
     SET "resolved_at" = now(),
         "resolution" = left(p_resolution, 24),
         "resolved_by" = p_resolved_by
   WHERE "recipient_kind" = 'admin'
     AND "subject_kind" = p_subject_kind
     AND "subject_id" = p_subject_id
     AND "resolved_at" IS NULL
     AND (p_kinds IS NULL OR "kind" = ANY (p_kinds));
EXCEPTION WHEN OTHERS THEN
  -- Never veto the decision (0061). The row stays open — "needs action" —
  -- which is what an unresolved row honestly says.
  RAISE WARNING 'resolve_admin_notifications(%, %) skipped: %', p_subject_kind, p_subject_id, SQLERRM;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ── The item tables ─────────────────────────────────────────────────────────
--
-- "Who handled it" is credited only when the very UPDATE that ended the task
-- also wrote the item's reviewer — a cancel or a system settle does not, and a
-- blank is better than the name of the admin who approved something somebody
-- else cancelled.

-- Deposits and withdrawals. Three ways a task ends:
--   leaving 'pending'            — approved, paid, rejected, failed;
--   becoming terminal            — a payout that was already approved settles
--                                  or is cancelled, ending its payout alerts;
--   the attention flag clearing  — a retry succeeded or somebody resolved it.
-- NOT "any state change": a terminal-to-terminal move (money paid at Rival
-- against a failed row) is exactly when an anomaly is RAISED, and must not
-- resolve it.
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
  IF OLD."rival_needs_attention" AND NOT NEW."rival_needs_attention" THEN
    PERFORM resolve_admin_notifications(
      'transaction', NEW."id", 'resolved', v_actor,
      ARRAY['admin.deposit.attention', 'withdrawal.rival_submit_failed', 'withdrawal.rival_attention']
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "transactions_resolve_admin_tasks" ON "transactions";
--> statement-breakpoint
CREATE TRIGGER "transactions_resolve_admin_tasks"
  AFTER UPDATE OF "state", "rival_needs_attention" ON "transactions"
  FOR EACH ROW
  WHEN (OLD."state" IS DISTINCT FROM NEW."state"
        OR OLD."rival_needs_attention" IS DISTINCT FROM NEW."rival_needs_attention")
  EXECUTE FUNCTION transactions_resolve_admin_tasks();
--> statement-breakpoint

-- KYC. Claim and release move between 'submitted' and 'under_review' — the
-- item is still waiting on a decision, so neither ends the task. A client's
-- reset DELETES the row, which ends it too.
CREATE OR REPLACE FUNCTION kyc_resolve_admin_tasks() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM resolve_admin_notifications('kyc', OLD."user_id", 'reset', NULL);
    RETURN NULL;
  END IF;
  IF OLD."status" IN ('submitted', 'under_review')
     AND NEW."status" NOT IN ('submitted', 'under_review') THEN
    PERFORM resolve_admin_notifications(
      'kyc', NEW."user_id", NEW."status"::text,
      CASE
        WHEN NEW."reviewed_by" IS DISTINCT FROM OLD."reviewed_by"
          OR NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at"
        THEN NEW."reviewed_by"
      END
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "kyc_submissions_resolve_admin_tasks" ON "kyc_submissions";
--> statement-breakpoint
CREATE TRIGGER "kyc_submissions_resolve_admin_tasks"
  AFTER UPDATE OF "status" ON "kyc_submissions"
  FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION kyc_resolve_admin_tasks();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "kyc_submissions_reset_admin_tasks" ON "kyc_submissions";
--> statement-breakpoint
CREATE TRIGGER "kyc_submissions_reset_admin_tasks"
  AFTER DELETE ON "kyc_submissions"
  FOR EACH ROW
  EXECUTE FUNCTION kyc_resolve_admin_tasks();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ib_applications_resolve_admin_tasks() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'pending' AND NEW."status" <> 'pending' THEN
    PERFORM resolve_admin_notifications(
      'ib_application', NEW."id", NEW."status"::text,
      CASE
        WHEN NEW."reviewed_by" IS DISTINCT FROM OLD."reviewed_by"
          OR NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at"
        THEN NEW."reviewed_by"
      END
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ib_applications_resolve_admin_tasks" ON "ib_applications";
--> statement-breakpoint
CREATE TRIGGER "ib_applications_resolve_admin_tasks"
  AFTER UPDATE OF "status" ON "ib_applications"
  FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION ib_applications_resolve_admin_tasks();
--> statement-breakpoint

-- A stuck wallet ⇄ MT5 transfer stops being a task when it settles, fails, or
-- is released from the desk (which fails it). `transfers` records no actor.
CREATE OR REPLACE FUNCTION transfers_resolve_admin_tasks() RETURNS trigger AS $$
BEGIN
  IF OLD."state" = 'pending' AND NEW."state" <> 'pending' THEN
    PERFORM resolve_admin_notifications('transfer', NEW."id", NEW."state"::text, NULL);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "transfers_resolve_admin_tasks" ON "transfers";
--> statement-breakpoint
CREATE TRIGGER "transfers_resolve_admin_tasks"
  AFTER UPDATE OF "state" ON "transfers"
  FOR EACH ROW
  WHEN (OLD."state" IS DISTINCT FROM NEW."state")
  EXECUTE FUNCTION transfers_resolve_admin_tasks();
--> statement-breakpoint

-- A commission clawback is one task per accrual, done when that accrual is
-- reversed. Confirming a pending accrual (pending → confirmed) is not that.
CREATE OR REPLACE FUNCTION ib_accruals_resolve_admin_tasks() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'reversed' AND OLD."status" <> 'reversed' THEN
    PERFORM resolve_admin_notifications('ib_accrual', NEW."id", 'reversed', NULL);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ib_accruals_resolve_admin_tasks" ON "ib_accruals";
--> statement-breakpoint
CREATE TRIGGER "ib_accruals_resolve_admin_tasks"
  AFTER UPDATE OF "status" ON "ib_accruals"
  FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION ib_accruals_resolve_admin_tasks();
--> statement-breakpoint

-- ── Realtime: a row read or resolved tells its reader's open tabs ───────────
--
-- A fourth channel on the gateway's one LISTEN connection. The payload names
-- a ROOM and nothing else — the browser re-reads through the scope- and
-- permission-checked endpoint. Delivered only on COMMIT, and Postgres folds
-- identical payloads within a transaction into one, so "mark all as read" on
-- five hundred rows is a single event, and a resolution across twelve admins
-- is twelve.
CREATE OR REPLACE FUNCTION notify_notification_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'notification_changed',
    json_build_object('recipientKind', NEW."recipient_kind", 'recipientId', NEW."recipient_id")::text
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "notifications_notify_changed" ON "notifications";
--> statement-breakpoint
CREATE TRIGGER "notifications_notify_changed"
  AFTER UPDATE OF "read_at", "resolved_at" ON "notifications"
  FOR EACH ROW
  WHEN (OLD."read_at" IS DISTINCT FROM NEW."read_at"
        OR OLD."resolved_at" IS DISTINCT FROM NEW."resolved_at")
  EXECUTE FUNCTION notify_notification_changed();
--> statement-breakpoint

-- ── The arrival payload carries the Portal ID ───────────────────────────────
--
-- So a toast can say "#1000245" the instant a task lands. The Portal ID is
-- the one client identifier the masking catalogue never hides, and the room
-- this reaches was scope-checked by the fan-out in the same moment. Names are
-- still never sent: they are masked per reader, which only the HTTP read can
-- do. The 6000-byte fallback is 0061's, unchanged.
CREATE OR REPLACE FUNCTION notify_notification_created() RETURNS trigger AS $$
DECLARE
  slim jsonb;
  payload jsonb;
  v_portal_id integer;
BEGIN
  -- 0047's routing fields — plus the Portal ID only when the row names a
  -- client, so a client row's announcement is byte-for-byte what it was.
  slim := jsonb_build_object(
    'id', NEW."id",
    'recipientKind', NEW."recipient_kind",
    'recipientId', NEW."recipient_id",
    'kind', NEW."kind"
  );
  IF NEW."subject_user_id" IS NOT NULL THEN
    SELECT u."portal_id" INTO v_portal_id FROM "users" u WHERE u."id" = NEW."subject_user_id";
    IF v_portal_id IS NOT NULL THEN
      slim := slim || jsonb_build_object('subjectPortalId', v_portal_id);
    END IF;
  END IF;

  payload := slim || jsonb_build_object('params', NEW."params");
  -- Over budget: 0061's fallback — route the event, let the toast go generic.
  IF octet_length(payload::text) > 6000 THEN
    payload := slim;
  END IF;

  PERFORM pg_notify('notification_created', payload::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
