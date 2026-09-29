-- 0164 — identity_adopt serialises on the CLIENT, not only on their KYC row.
--
-- Found 29 Sep 2026 while seeding 20,000 clients for a load test: the boot's drift
-- repair and the seeder's commit-time adoption (0153) adopted the same clients at
-- once. Those clients had no KYC row yet, so the lock identity_adopt took first
-- (the KYC row) locked nothing, both computed decision #1, and one failed on
-- client_verifications_seq_uq — which killed the dev API's boot. Real traffic
-- reaches this rarely (an import, a restore, two repairs), but "two adoptions of
-- one client race and one crashes" should not be possible at all.
--
-- The function is 0159's, unchanged but for the second lock.
CREATE OR REPLACE FUNCTION public.identity_adopt(p_user integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_prev text := current_setting('oxshare.identity_maintenance', true);
  att record;
  sub record;
  f record;
  v_at timestamptz;
  v_identity uuid;
  v_address uuid;
  v_selfie uuid;
  v_other uuid;
  v_others uuid[];
  v_keep uuid[];
  v_verification uuid;
  v_reverification boolean;
  v_seq integer;
  v_latest smallint;
  v_level smallint;
  v_email text;
BEGIN
  PERFORM set_config('oxshare.identity_maintenance', 'on', true);

  -- One client is adopted by one transaction at a time. Every KYC path already
  -- holds this row when it calls here, so for them this is a no-op; a repair
  -- running beside live traffic (the boot check) waits for the KYC change in
  -- flight instead of racing it to the same versions. Taken FIRST, before any
  -- version is touched, which is the order the KYC paths take them in.
  PERFORM 1 FROM kyc_submissions WHERE user_id = p_user FOR NO KEY UPDATE;
  -- …and the CLIENT's own row, which always exists (0163). A client with no KYC
  -- row yet had nothing above to lock, so two adoptions — a repair beside a
  -- commit's deferred trigger — both wrote decision #1 and one died on
  -- client_verifications_seq_uq. Same order as every KYC path (KYC row, then
  -- the user), so it cannot deadlock; NO KEY, like lockWallet, so foreign-key
  -- checks from the client's other rows are not blocked.
  PERFORM 1 FROM users WHERE id = p_user FOR NO KEY UPDATE;

  -- 1. Every archived attempt: its evidence frozen, its decision logged.
  FOR att IN
    SELECT * FROM kyc_submission_attempts WHERE user_id = p_user ORDER BY attempt_no
  LOOP
    v_at := coalesce(att.submitted_at, att.archived_at);
    v_identity := identity_frozen_version(p_user, 'identity', nullif(att.document->>'docType', ''),
                                          identity_pages('identity', att.document), v_at);
    v_address := identity_frozen_version(p_user, 'address', nullif(att.address_proof->>'docType', ''),
                                         identity_pages('address', att.address_proof), v_at);
    v_selfie := identity_frozen_version(p_user, 'selfie', NULL, identity_pages('selfie', att.selfie), v_at);
    v_others := ARRAY[]::uuid[];
    FOR f IN
      SELECT x.key, x.v
        FROM jsonb_each(coalesce(att.step_data, '{}'::jsonb)) s(slug, a),
             jsonb_each(CASE WHEN jsonb_typeof(s.a) = 'object' THEN s.a ELSE '{}'::jsonb END) x(key, v)
       WHERE jsonb_typeof(x.v) = 'object' AND x.v ? 'filePath'
    LOOP
      v_other := identity_frozen_version(p_user, identity_other_slot(f.key), NULL,
                                         identity_pages('other:x', f.v), v_at);
      IF v_other IS NOT NULL THEN
        v_others := v_others || v_other;
      END IF;
    END LOOP;

    UPDATE kyc_submission_attempts
       SET identity_document_id = v_identity,
           address_document_id = v_address,
           selfie_document_id = v_selfie
     WHERE id = att.id
       AND (identity_document_id, address_document_id, selfie_document_id)
           IS DISTINCT FROM (v_identity, v_address, v_selfie);

    IF att.verification_id IS NULL THEN
      -- A re-verification: flagged on the attempt by the code that archives it
      -- (from the dual write on), or — for history, archived as `rejected` —
      -- told apart by its audit row. The flag matters live: that audit row is
      -- written AFTER the decision commits, so an adoption inside the decision's
      -- own transaction could never see it.
      v_reverification := att.reverification OR att.status = 'rejected' AND EXISTS (
        SELECT 1 FROM audit_log a
         WHERE a.action = 'kyc.reverification_request'
           AND a.subject_id = p_user::text
           AND abs(extract(epoch FROM a.created_at - att.archived_at)) < 120);
      SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM client_verifications WHERE user_id = p_user;
      SELECT email INTO v_email FROM admins WHERE id = att.reviewed_by;
      INSERT INTO client_verifications
        (user_id, seq, outcome, level_after, method, admin_id, admin_email, reason_id, reason,
         returned_items, decided_at)
      VALUES (
        p_user, v_seq,
        CASE WHEN att.status = 'approved' THEN 'verified'
             WHEN v_reverification THEN 'reverification_requested'
             ELSE 'returned' END,
        CASE WHEN att.status = 'approved' THEN 1 ELSE 0 END,
        'manual_review', att.reviewed_by, v_email, att.reason_id, att.rejection_reason,
        CASE WHEN jsonb_typeof(att.rejected_fields) = 'array' THEN att.rejected_fields ELSE '[]'::jsonb END,
        coalesce(att.reviewed_at, att.archived_at))
      RETURNING id INTO v_verification;
      INSERT INTO client_verification_documents (verification_id, document_id)
      SELECT DISTINCT v_verification, d
        FROM unnest(ARRAY[v_identity, v_address, v_selfie] || v_others) AS d
       WHERE d IS NOT NULL
      ON CONFLICT DO NOTHING;
      UPDATE kyc_submission_attempts
         SET verification_id = v_verification, reverification = v_reverification
       WHERE id = att.id;
    END IF;
  END LOOP;

  -- 2. The live row: presented evidence frozen, work in progress a draft.
  SELECT * INTO sub FROM kyc_submissions WHERE user_id = p_user;
  IF FOUND THEN
    IF sub.status IN ('submitted', 'under_review', 'approved') THEN
      v_at := coalesce(sub.submitted_at, sub.updated_at);
      v_identity := identity_frozen_version(p_user, 'identity', nullif(sub.document->>'docType', ''),
                                            identity_pages('identity', sub.document), v_at);
      v_address := identity_frozen_version(p_user, 'address', nullif(sub.address_proof->>'docType', ''),
                                           identity_pages('address', sub.address_proof), v_at);
      v_selfie := identity_frozen_version(p_user, 'selfie', NULL, identity_pages('selfie', sub.selfie), v_at);
    ELSE
      v_identity := identity_working_version(p_user, 'identity', nullif(sub.document->>'docType', ''),
                                             identity_pages('identity', sub.document));
      v_address := identity_working_version(p_user, 'address', nullif(sub.address_proof->>'docType', ''),
                                            identity_pages('address', sub.address_proof));
      v_selfie := identity_working_version(p_user, 'selfie', NULL, identity_pages('selfie', sub.selfie));
    END IF;

    UPDATE kyc_submissions
       SET identity_document_id = v_identity,
           address_document_id = v_address,
           selfie_document_id = v_selfie
     WHERE user_id = p_user
       AND (identity_document_id, address_document_id, selfie_document_id)
           IS DISTINCT FROM (v_identity, v_address, v_selfie);

    -- A broker's uploads, the same way, one version per field.
    v_keep := ARRAY[v_identity, v_address, v_selfie];
    FOR f IN
      SELECT x.key, x.v
        FROM jsonb_each(coalesce(sub.step_data, '{}'::jsonb)) s(slug, a),
             jsonb_each(CASE WHEN jsonb_typeof(s.a) = 'object' THEN s.a ELSE '{}'::jsonb END) x(key, v)
       WHERE jsonb_typeof(x.v) = 'object' AND x.v ? 'filePath'
    LOOP
      IF sub.status IN ('submitted', 'under_review', 'approved') THEN
        v_other := identity_frozen_version(p_user, identity_other_slot(f.key), NULL,
                                           identity_pages('other:x', f.v), v_at);
      ELSE
        v_other := identity_working_version(p_user, identity_other_slot(f.key), NULL,
                                            identity_pages('other:x', f.v));
      END IF;
      v_keep := v_keep || v_other;
    END LOOP;
  ELSE
    v_keep := ARRAY[]::uuid[];
  END IF;

  -- A draft nothing points at any more is stale: the client is not working on it.
  DELETE FROM client_documents
   WHERE user_id = p_user AND frozen_at IS NULL
     AND NOT (id = ANY (array_remove(v_keep, NULL)));

  -- 3. The level always equals the latest decision.
  SELECT least(greatest(verification_level, 0), 1), email INTO v_level, v_email
    FROM users WHERE id = p_user;
  SELECT level_after INTO v_latest FROM client_verifications
   WHERE user_id = p_user ORDER BY seq DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM v_level AND NOT (v_latest IS NULL AND v_level = 0) THEN
    SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM client_verifications WHERE user_id = p_user;
    INSERT INTO client_verifications (user_id, seq, outcome, level_after, method, reason)
    VALUES (p_user, v_seq,
            CASE WHEN v_level = 1 THEN 'verified' ELSE 'returned' END,
            v_level,
            CASE WHEN v_email LIKE '%@oxshare-e2e%' THEN 'fixture' ELSE 'legacy' END,
            'Recorded from the account’s verification level when the log began (0152).');
  END IF;

  PERFORM set_config('oxshare.identity_maintenance', coalesce(v_prev, ''), true);
END;
$function$;
