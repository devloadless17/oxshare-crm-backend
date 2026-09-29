-- 0171 — THE IDENTITY RECORD IS WRITTEN DIRECTLY; THE KYC DOCUMENT COLUMNS GO (30 Sep 2026).
--
-- The last slice of the identity-record plan (the owner's direction, 28 Sep 2026:
-- a client's documents, selfie and verification belong to the CLIENT; KYC is
-- only the process that collects them). Until now the KYC code wrote its three
-- evidence columns — `document`, `selfie`, `address_proof` on `kyc_submissions`
-- and on `kyc_submission_attempts` — and `identity_adopt` (0152) re-derived the
-- record from them: inside each KYC transaction, again at COMMIT by deferred
-- triggers (0153), and on every boot for anything the triggers missed. Every
-- read already came from the record (0152's `identity_evidence`); the columns
-- were written for nothing but that derivation.
--
-- Now each KYC write records exactly what it changes, through the same SQL the
-- derivation used (one implementation, no second copy to drift):
--
--   identity_record_evidence(user, status, document, address, selfie, step_data, at)
--       the live submission's evidence: a DRAFT version per document while the
--       client works, FROZEN once presented; the pointers set; stale drafts
--       gone. What `identity_adopt` did for the live row, from VALUES rather
--       than from columns (`KycStore.update` / `transition`).
--   identity_record_decision(attempt)
--       one archived attempt's decision, and exactly which versions it covered
--       — what `identity_adopt` did per attempt (`KycStore.archiveAttempt`).
--   identity_record_level(user)
--       a client whose level matches no decision (a seed, an import) gets the
--       decision that explains it — `identity_adopt`'s last step, kept for the
--       fixtures and imports that set a level directly.
--
-- So the columns, the commit-time triggers, `identity_adopt`, the
-- `identity_drift` view and the boot repair all go: there is no longer a second
-- copy to be out of step with.
--
-- ⚠️ NOT REVERSIBLE BY DEPLOYING THE PREVIOUS BUILD. That build writes the
-- dropped columns and calls `identity_adopt`, so every KYC write it makes fails.
-- Roll forward, never back, past this migration.
--
-- Written for both migration modes (backend CLAUDE.md): every statement stands
-- alone and is re-runnable.

-- ── 1. One last derivation, so nothing the columns hold is lost ──────────────
-- `identity_adopt` is idempotent and every boot has run it for drift, so on a
-- healthy database this changes nothing; it is here so the drop below can never
-- discard evidence the record had not yet taken. Guarded, so a re-run after the
-- function is gone is a no-op.
DO $$
BEGIN
  IF to_regprocedure('identity_adopt(integer)') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'kyc_submissions' AND column_name = 'document') THEN
    PERFORM identity_adopt(u.user_id)
       FROM (SELECT user_id FROM kyc_submissions
             UNION SELECT user_id FROM kyc_submission_attempts) u;
  END IF;
END $$;--> statement-breakpoint

-- ── 2. The mirror goes ───────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS kyc_submissions_identity_follow ON kyc_submissions;--> statement-breakpoint
DROP TRIGGER IF EXISTS kyc_submissions_identity_follow_update ON kyc_submissions;--> statement-breakpoint
DROP TRIGGER IF EXISTS kyc_attempts_identity_follow ON kyc_submission_attempts;--> statement-breakpoint
DROP TRIGGER IF EXISTS kyc_attempts_identity_follow_update ON kyc_submission_attempts;--> statement-breakpoint
DROP FUNCTION IF EXISTS identity_follow_kyc();--> statement-breakpoint
DROP VIEW IF EXISTS identity_drift;--> statement-breakpoint

-- ── 3. The live submission's evidence, recorded from the values written ─────
CREATE OR REPLACE FUNCTION identity_record_evidence(
  p_user integer,
  p_status text,
  p_document jsonb,
  p_address jsonb,
  p_selfie jsonb,
  p_step_data jsonb,
  p_at timestamptz
) RETURNS void AS $$
DECLARE
  v_prev text := current_setting('oxshare.identity_maintenance', true);
  v_frozen boolean := p_status IN ('submitted', 'under_review', 'approved');
  v_identity uuid;
  v_address uuid;
  v_selfie uuid;
  v_other uuid;
  v_keep uuid[];
  f record;
BEGIN
  -- A frozen version's pages are written as it is created; the guards refuse
  -- that outside the escape, exactly as they did for `identity_adopt`.
  PERFORM set_config('oxshare.identity_maintenance', 'on', true);

  IF v_frozen THEN
    v_identity := identity_frozen_version(p_user, 'identity', nullif(p_document->>'docType', ''),
                                          identity_pages('identity', p_document), p_at);
    v_address := identity_frozen_version(p_user, 'address', nullif(p_address->>'docType', ''),
                                         identity_pages('address', p_address), p_at);
    v_selfie := identity_frozen_version(p_user, 'selfie', NULL, identity_pages('selfie', p_selfie), p_at);
  ELSE
    v_identity := identity_working_version(p_user, 'identity', nullif(p_document->>'docType', ''),
                                           identity_pages('identity', p_document));
    v_address := identity_working_version(p_user, 'address', nullif(p_address->>'docType', ''),
                                          identity_pages('address', p_address));
    v_selfie := identity_working_version(p_user, 'selfie', NULL, identity_pages('selfie', p_selfie));
  END IF;

  UPDATE kyc_submissions
     SET identity_document_id = v_identity,
         address_document_id = v_address,
         selfie_document_id = v_selfie
   WHERE user_id = p_user
     AND (identity_document_id, address_document_id, selfie_document_id)
         IS DISTINCT FROM (v_identity, v_address, v_selfie);

  -- A broker's uploads, one version per field, the same way.
  v_keep := ARRAY[v_identity, v_address, v_selfie];
  FOR f IN
    SELECT x.key, x.v
      FROM jsonb_each(coalesce(p_step_data, '{}'::jsonb)) s(slug, a),
           jsonb_each(CASE WHEN jsonb_typeof(s.a) = 'object' THEN s.a ELSE '{}'::jsonb END) x(key, v)
     WHERE jsonb_typeof(x.v) = 'object' AND x.v ? 'filePath'
  LOOP
    IF v_frozen THEN
      v_other := identity_frozen_version(p_user, identity_other_slot(f.key), NULL,
                                         identity_pages('other:x', f.v), p_at);
    ELSE
      v_other := identity_working_version(p_user, identity_other_slot(f.key), NULL,
                                          identity_pages('other:x', f.v));
    END IF;
    v_keep := v_keep || v_other;
  END LOOP;

  -- A draft nothing points at any more is stale: the client is not working on it.
  DELETE FROM client_documents
   WHERE user_id = p_user AND frozen_at IS NULL
     AND NOT (id = ANY (array_remove(v_keep, NULL)));

  PERFORM set_config('oxshare.identity_maintenance', coalesce(v_prev, ''), true);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── 4. One archived attempt's decision, and what it covered ─────────────────
-- The attempt carries the pointers its live row had when it was archived. A
-- draft among them (a decision on a submission never presented, which the KYC
-- flow does not produce, but a fixture might) is frozen first: a decision
-- covers only what can no longer change.
CREATE OR REPLACE FUNCTION identity_record_decision(p_attempt uuid) RETURNS uuid AS $$
DECLARE
  v_prev text := current_setting('oxshare.identity_maintenance', true);
  att record;
  f record;
  v_at timestamptz;
  v_ids uuid[];
  v_frozen uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_other uuid;
  v_verification uuid;
  v_seq integer;
  v_email text;
BEGIN
  SELECT * INTO att FROM kyc_submission_attempts WHERE id = p_attempt;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF att.verification_id IS NOT NULL THEN
    RETURN att.verification_id; -- decided once; a replay is a no-op
  END IF;
  PERFORM set_config('oxshare.identity_maintenance', 'on', true);
  v_at := coalesce(att.submitted_at, att.archived_at);

  v_ids := ARRAY[att.identity_document_id, att.address_document_id, att.selfie_document_id];
  FOREACH v_id IN ARRAY v_ids LOOP
    IF v_id IS NOT NULL AND EXISTS (SELECT 1 FROM client_documents WHERE id = v_id AND frozen_at IS NULL) THEN
      SELECT identity_frozen_version(d.user_id, d.slot, d.doc_type, identity_version_pages(d.id), v_at)
        INTO v_id FROM client_documents d WHERE d.id = v_id;
    END IF;
    v_frozen := v_frozen || v_id;
  END LOOP;

  UPDATE kyc_submission_attempts
     SET identity_document_id = v_frozen[1],
         address_document_id = v_frozen[2],
         selfie_document_id = v_frozen[3]
   WHERE id = att.id
     AND (identity_document_id, address_document_id, selfie_document_id)
         IS DISTINCT FROM (v_frozen[1], v_frozen[2], v_frozen[3]);

  -- The broker's uploads the attempt answered, frozen as it presented them.
  FOR f IN
    SELECT x.key, x.v
      FROM jsonb_each(coalesce(att.step_data, '{}'::jsonb)) s(slug, a),
           jsonb_each(CASE WHEN jsonb_typeof(s.a) = 'object' THEN s.a ELSE '{}'::jsonb END) x(key, v)
     WHERE jsonb_typeof(x.v) = 'object' AND x.v ? 'filePath'
  LOOP
    v_other := identity_frozen_version(att.user_id, identity_other_slot(f.key), NULL,
                                       identity_pages('other:x', f.v), v_at);
    IF v_other IS NOT NULL THEN
      v_frozen := v_frozen || v_other;
    END IF;
  END LOOP;

  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM client_verifications WHERE user_id = att.user_id;
  SELECT email INTO v_email FROM admins WHERE id = att.reviewed_by;
  INSERT INTO client_verifications
    (user_id, seq, outcome, level_after, method, admin_id, admin_email, reason_id, reason,
     returned_items, decided_at)
  VALUES (
    att.user_id, v_seq,
    CASE WHEN att.status = 'approved' THEN 'verified'
         WHEN att.reverification THEN 'reverification_requested'
         ELSE 'returned' END,
    CASE WHEN att.status = 'approved' THEN 1 ELSE 0 END,
    'manual_review', att.reviewed_by, v_email, att.reason_id, att.rejection_reason,
    CASE WHEN jsonb_typeof(att.rejected_fields) = 'array' THEN att.rejected_fields ELSE '[]'::jsonb END,
    coalesce(att.reviewed_at, att.archived_at))
  RETURNING id INTO v_verification;
  INSERT INTO client_verification_documents (verification_id, document_id)
  SELECT DISTINCT v_verification, d FROM unnest(v_frozen) AS d WHERE d IS NOT NULL
  ON CONFLICT DO NOTHING;
  UPDATE kyc_submission_attempts SET verification_id = v_verification WHERE id = att.id;

  PERFORM set_config('oxshare.identity_maintenance', coalesce(v_prev, ''), true);
  RETURN v_verification;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── 5. A level no decision explains (seeds, imports) ────────────────────────
-- `identity_adopt`'s last step, alone: the KYC flow always decides before it
-- moves a level, so only a writer that sets `verification_level` directly
-- needs this — the dev seeds, the e2e fixtures, an import.
CREATE OR REPLACE FUNCTION identity_record_level(p_user integer) RETURNS void AS $$
DECLARE
  v_prev text := current_setting('oxshare.identity_maintenance', true);
  v_level smallint;
  v_latest smallint;
  v_email text;
  v_seq integer;
BEGIN
  SELECT least(greatest(verification_level, 0), 1), email INTO v_level, v_email
    FROM users WHERE id = p_user;
  SELECT level_after INTO v_latest FROM client_verifications
   WHERE user_id = p_user ORDER BY seq DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM v_level AND NOT (v_latest IS NULL AND v_level = 0) THEN
    PERFORM set_config('oxshare.identity_maintenance', 'on', true);
    SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM client_verifications WHERE user_id = p_user;
    INSERT INTO client_verifications (user_id, seq, outcome, level_after, method, reason)
    VALUES (p_user, v_seq,
            CASE WHEN v_level = 1 THEN 'verified' ELSE 'returned' END,
            v_level,
            CASE WHEN v_email LIKE '%@oxshare-e2e%' THEN 'fixture' ELSE 'legacy' END,
            'Recorded from the account’s verification level (a seed or an import).');
    PERFORM set_config('oxshare.identity_maintenance', coalesce(v_prev, ''), true);
  END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── 6. The derivation and the columns it read ───────────────────────────────
DROP FUNCTION IF EXISTS identity_adopt(integer);--> statement-breakpoint
ALTER TABLE kyc_submissions DROP COLUMN IF EXISTS document;--> statement-breakpoint
ALTER TABLE kyc_submissions DROP COLUMN IF EXISTS selfie;--> statement-breakpoint
ALTER TABLE kyc_submissions DROP COLUMN IF EXISTS address_proof;--> statement-breakpoint
ALTER TABLE kyc_submission_attempts DROP COLUMN IF EXISTS document;--> statement-breakpoint
ALTER TABLE kyc_submission_attempts DROP COLUMN IF EXISTS selfie;--> statement-breakpoint
ALTER TABLE kyc_submission_attempts DROP COLUMN IF EXISTS address_proof;
