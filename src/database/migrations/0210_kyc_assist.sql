-- 0210 — STAFF COMPLETE A CLIENT'S KYC FOR THEM (8 Oct 2026)
--
-- The owner's need: clients who are not technical (elderly people, anyone who
-- struggles) sign up and then cannot do the KYC — the uploads, the steps, the
-- submit. Staff now do it for them through the CLIENT'S OWN KYC actions
-- (`KycClientService`), under the client's own rules: only while the KYC is
-- open, judged by the same `stepStates`, approved by the same `approve`. There
-- is no second road to "verified".
--
-- What this migration adds is the one fact those actions could not record:
-- WHO SUBMITTED. A submission an administrator sent for the client names them;
-- NULL means the client submitted it themselves. Copied onto the archived
-- attempt with the decision, so the history says it too. Who uploaded each page
-- is already recorded by the upload registry (`stored_objects.uploaded_by_*`),
-- and who changed a detail by the profile writer's audit row, so neither needs
-- a column here.
--
-- `ON DELETE SET NULL`, like `reviewed_by` beside it: an administrator who
-- leaves must stay removable, and the audit log (`kyc.assist_submit`) keeps the
-- authoritative record of who did it.
--
-- Also grants the new `kyc.assist` key to the system (Administrator) role, so
-- the release is self-contained — `permission-drift.ts` would top it up at boot
-- anyway. Hand-written (see 0040's header). Re-runnable.

ALTER TABLE kyc_submissions
  ADD COLUMN IF NOT EXISTS submitted_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL;

ALTER TABLE kyc_submission_attempts
  ADD COLUMN IF NOT EXISTS submitted_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL;

-- An index under each foreign key, for the parent's delete check (0185).
CREATE INDEX IF NOT EXISTS kyc_submissions_submitted_by_admin_id_fk_idx
  ON kyc_submissions (submitted_by_admin_id)
  WHERE submitted_by_admin_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS kyc_submission_attempts_submitted_by_admin_id_fk_idx
  ON kyc_submission_attempts (submitted_by_admin_id)
  WHERE submitted_by_admin_id IS NOT NULL;

UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'kyc.assist'
       ) keys(k)
   )
 WHERE is_system = true;
