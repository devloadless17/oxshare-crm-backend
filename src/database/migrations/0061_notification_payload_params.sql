-- Carry `params` on the real-time payload, so a notification can be TOASTED on
-- arrival instead of only incrementing a badge.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── What changed since 0047, and why ────────────────────────────────────────
--
-- 0047 sent `{id, recipientKind, recipientId, kind}` and argued the payload
-- should stay tiny: the listener only needed enough to ROUTE the event, and the
-- browser re-read the feed over the authenticated endpoint. That was right for
-- a bell badge. It is not enough for a toast.
--
-- A toast has to say "Deposit of $500.00 succeeded" the moment it appears. With
-- only `{id, kind}` the frontend can render a title from its kind catalogue but
-- not a single number, so every toast would either be generic or would have to
-- fetch the row first — a round trip that lands the toast visibly after the
-- event it announces. The interpolation values are already in `params`, and
-- `params` is already in this row.
--
-- ── The 8000-byte limit is handled, not hoped about ─────────────────────────
--
-- 0047's objection was real and is the reason this is not a one-line change:
-- `pg_notify` REFUSES a payload over 8000 bytes, and `params` carries
-- rejection reasons and admin notes of unbounded length. A row whose reason ran
-- long would raise 22023 from inside the trigger — and because the trigger runs
-- in the caller's transaction, that would abort the WITHDRAWAL, not just the
-- notification. A notification must never be able to roll back the money
-- movement it is announcing.
--
-- So the payload is built twice: with `params`, and — if that exceeds the
-- budget — without. The slim form is byte-for-byte 0047's, and the frontends
-- already treat absent params as "render the generic title", because that is
-- what they must do for an unknown `kind` anyway. An over-long reason therefore
-- degrades to the old behaviour instead of failing anything.
--
-- 6000, not 8000: `id`, `kind` and the two recipient fields have to fit beside
-- `params`, and multi-byte characters in a reason cost more bytes than the
-- character count suggests. `octet_length` measures bytes rather than
-- characters for exactly that reason.
--
-- ── On sending params over the socket at all ────────────────────────────────
--
-- 0047 noted that the payload "never travels outside a permission-checked
-- read". It still does not. The gateway emits into `<kind>:<id>` — the room
-- holding exactly the sockets of the principal this row names, authenticated at
-- the handshake — so `params` reaches the one reader the permission-checked
-- endpoint would have served it to, and nobody else. Fan-out already filters by
-- client scope at WRITE time (`notifyAdminsWithPermission`), so a row that
-- exists at all is a row its recipient is allowed to read.

CREATE OR REPLACE FUNCTION notify_notification_created() RETURNS trigger AS $$
DECLARE
  payload text;
BEGIN
  payload := json_build_object(
    'id', NEW.id,
    'recipientKind', NEW.recipient_kind,
    'recipientId', NEW.recipient_id,
    'kind', NEW.kind,
    'params', NEW.params
  )::text;

  -- Over budget: fall back to 0047's routing-only payload. The event still
  -- arrives, the bell still updates, and the toast renders its generic title.
  IF octet_length(payload) > 6000 THEN
    payload := json_build_object(
      'id', NEW.id,
      'recipientKind', NEW.recipient_kind,
      'recipientId', NEW.recipient_id,
      'kind', NEW.kind
    )::text;
  END IF;

  PERFORM pg_notify('notification_created', payload);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- The trigger itself is unchanged from 0047 — AFTER INSERT, FOR EACH ROW — and
-- is recreated only so a database at 0047 picks up the new function body
-- regardless of the order these are applied in.
DROP TRIGGER IF EXISTS notifications_notify_created ON "notifications";
--> statement-breakpoint

CREATE TRIGGER notifications_notify_created
  AFTER INSERT ON "notifications"
  FOR EACH ROW
  EXECUTE FUNCTION notify_notification_created();
