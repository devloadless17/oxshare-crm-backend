-- Real-time delivery for the notification feed, announced by the database.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── Why the DATABASE announces this, and not the service ────────────────────
--
-- Half the notification writes happen INSIDE somebody else's transaction: a
-- withdrawal approval, a KYC decision, a settled deposit, a confirmed
-- commission. The row becomes real only when that money transaction commits,
-- and the service issuing the notify has no idea when that happens — it was
-- handed an `Executor`, not a lifecycle.
--
-- Publishing from application code would therefore mean pushing a "your
-- withdrawal was approved" the instant the row is written, and a rollback a
-- moment later would leave the client told about a decision that never
-- happened. On a money product that is the worst possible failure of a
-- notification system: the UI contradicts the ledger.
--
-- `pg_notify` inside a transaction is delivered ONLY if that transaction
-- commits, and is discarded on rollback. So the guarantee this feature needs
-- is a property of the mechanism rather than something the application has to
-- remember — the same reasoning that puts idempotency in a UNIQUE index
-- instead of a check-then-insert (§6.3).
--
-- ── Why not Redis, which is already a dependency ────────────────────────────
--
-- `REDIS_URL` is OPTIONAL in `env.validation.ts` and unset in several
-- environments, so a Redis-based bus would make real-time silently dead
-- wherever it is absent — working in dev, quiet in staging, with nothing
-- failing to say so. Postgres is required for the app to boot at all.
--
-- It also costs nothing extra: every backend instance LISTENs, so a row
-- written by one reaches a client connected to another, and any FUTURE writer
-- gets real-time for free — including the BullMQ worker when ARCH §9 lands,
-- because the trigger is on the table rather than in a service.
--
-- ── The payload is deliberately tiny ────────────────────────────────────────
--
-- `pg_notify` truncates above 8000 bytes, and `params` can carry a rejection
-- reason of arbitrary length. So this sends only what a listener needs to
-- route the event — who it is for, and which row — and the client re-reads the
-- feed over the authenticated endpoint. That also means the notification
-- payload never travels outside a permission-checked read.

CREATE OR REPLACE FUNCTION notify_notification_created() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'notification_created',
    json_build_object(
      'id', NEW.id,
      'recipientKind', NEW.recipient_kind,
      'recipientId', NEW.recipient_id,
      'kind', NEW.kind
    )::text
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- AFTER INSERT: the row exists by the time anybody is told about it, and the
-- notification is queued until COMMIT. FOR EACH ROW because a fan-out to
-- several admins is several recipients, each needing their own event.
DROP TRIGGER IF EXISTS notifications_notify_created ON "notifications";
--> statement-breakpoint

CREATE TRIGGER notifications_notify_created
  AFTER INSERT ON "notifications"
  FOR EACH ROW
  EXECUTE FUNCTION notify_notification_created();
