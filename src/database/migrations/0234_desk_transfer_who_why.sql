-- 0234 — a NEW desk transfer must say who asked for it and why (17 Oct 2026, audit R1-6).
--
-- 0226's CHECK only forbids an admin and a reason on a client's own transfer; nothing required
-- them on a desk one. A writer stating no origin (raw SQL, an older build) could commit a desk
-- move whose origin the fill trigger derived from its ref, with no person and no reason.
--
-- An INSERT trigger rather than a CHECK, deliberately: a CHECK binds every UPDATE too, and 0226's
-- re-runnable backfill sets a desk origin before it fills who and why. History is complete in
-- production (every desk transfer names both) and is never rewritten.
-- Named to fire AFTER `transfers_provenance_fill`, which derives the origin it reads.
SET lock_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transfers_desk_who_why() RETURNS trigger AS $$
BEGIN
  IF NEW.origin IN ('desk_credit', 'desk_wallet', 'desk_debit')
     AND (NEW.requested_by_admin_id IS NULL OR NEW.desk_reason IS NULL) THEN
    RAISE EXCEPTION 'A desk transfer must name the administrator who asked for it and why'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'transfers_desk_who_why';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transfers_provenance_who_why ON transfers;
--> statement-breakpoint
CREATE TRIGGER transfers_provenance_who_why
  BEFORE INSERT ON transfers
  FOR EACH ROW EXECUTE FUNCTION transfers_desk_who_why();
