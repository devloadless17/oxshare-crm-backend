-- 0212 — A CLIENT'S FOLLOW-UP AND RESULT (the buyer's request, 9 Oct 2026)
--
-- Two notes the staff keep about a client, named by the buyer: "Follow-up"
-- (what to do next, with an optional date to do it by) and "Result" (how the
-- last contact went). Free text, written by staff, never shown to the client.
--
-- ONE ROW PER CLIENT, beside `users` rather than on it: `users` is the one home
-- of the client's IDENTITY (0139) and these are the desk's working notes about
-- them. A missing row means both notes are empty.
--
-- `version` is what stops two administrators overwriting each other: a save
-- names the version it was made from, and a save from an older one is refused
-- (409 FOLLOWUP_STALE) instead of silently replacing a colleague's words. Every
-- change is also an audit row (`client.followup_update`, before and after), which
-- is the history.
--
-- Deleting a client takes their notes (CASCADE). An administrator who is removed
-- leaves "last edited by" empty (SET NULL); the audit rows still name them.
--
-- Also grants the new `clients.followup.edit` key to the system (Administrator)
-- role, so the release is self-contained. Hand-written (see 0040's header).
-- Re-runnable.

CREATE TABLE IF NOT EXISTS client_followups (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  follow_up text,
  result text,
  follow_up_at timestamptz,
  updated_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  -- Stored trimmed, and an empty note is NULL: one spelling of "nothing".
  CONSTRAINT client_followups_follow_up_ck
    CHECK (follow_up IS NULL OR (char_length(follow_up) BETWEEN 1 AND 2000 AND follow_up = btrim(follow_up))),
  CONSTRAINT client_followups_result_ck
    CHECK (result IS NULL OR (char_length(result) BETWEEN 1 AND 2000 AND result = btrim(result))),
  CONSTRAINT client_followups_version_ck CHECK (version >= 1)
);

-- The clients list's "Follow-up due" filter and its sort by follow-up date.
CREATE INDEX IF NOT EXISTS client_followups_follow_up_at_idx
  ON client_followups (follow_up_at)
  WHERE follow_up_at IS NOT NULL;

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'clients.followup.edit'
       ) keys(k)
   )
 WHERE is_system = true;
