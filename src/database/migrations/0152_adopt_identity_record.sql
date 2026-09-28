-- ============================================================================
-- Adopt every client's existing evidence and decisions into the identity
-- record (0151) — nothing lost, nothing recorded twice
-- ============================================================================
--
-- `identity_adopt(user)` turns what the KYC layer holds today — file paths
-- inside `kyc_submissions` and `kyc_submission_attempts` — into the client's
-- own record:
--
--   - every ARCHIVED attempt's documents, selfie and a broker's uploads become
--     FROZEN versions (what was presented), and its decision becomes a row in
--     the verification log, linked to them;
--   - the LIVE row's evidence becomes frozen versions while it is with a
--     reviewer or approved, and a DRAFT while the client is working on it —
--     unless it is exactly a version already frozen, which it then points at;
--   - a client whose verification level the log does not explain (seed
--     fixtures, levels set before the log existed) gets one `fixture` or
--     `legacy` row, so the level ALWAYS equals the latest decision.
--
-- It is IDEMPOTENT: identical page sets are one version, an attempt already
-- adopted is skipped, and a draft is brought to the live row's shape. That is
-- what lets the same routine serve as the backfill below AND, until the
-- contract slice, as the repair for anything that still writes only the old
-- columns (an older build after a rollback, the e2e pool reset, raw SQL) —
-- `identity_drift` lists what is out of step.
--
-- It works under the record's maintenance escape (0151), because it creates
-- versions that are ALREADY frozen — their pages must be written into a
-- version the triggers otherwise treat as closed. It restores the setting it
-- found before it returns.
--
-- Safe to run twice.

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- The pages a KYC value holds for a slot, as [{part, key, name}] in part order.
CREATE OR REPLACE FUNCTION identity_pages(p_slot text, p_value jsonb) RETURNS jsonb AS $$
  SELECT coalesce(
           jsonb_agg(jsonb_build_object('part', part, 'key', key, 'name', name) ORDER BY part),
           '[]'::jsonb)
    FROM (
          SELECT 0 AS part, p_value->>'frontFilePath' AS key, p_value->>'frontFileName' AS name
           WHERE p_slot = 'identity'
          UNION ALL
          SELECT 1, p_value->>'backFilePath', p_value->>'backFileName' WHERE p_slot = 'identity'
          UNION ALL
          SELECT 0, p_value->>'filePath', p_value->>'fileName'
           WHERE p_slot IN ('address', 'selfie') OR p_slot LIKE 'other:%'
          UNION ALL
          SELECT 1, p_value->>'page2FilePath', p_value->>'page2FileName' WHERE p_slot = 'address'
         ) p
   WHERE key IS NOT NULL AND key <> '';
$$ LANGUAGE sql IMMUTABLE;

-- A page set's identity: which file at which part — names are not identity.
CREATE OR REPLACE FUNCTION identity_page_keys(p_pages jsonb) RETURNS jsonb AS $$
  SELECT coalesce(
           jsonb_agg(jsonb_build_array((e->>'part')::int, e->>'key') ORDER BY (e->>'part')::int),
           '[]'::jsonb)
    FROM jsonb_array_elements(p_pages) e;
$$ LANGUAGE sql IMMUTABLE;

-- A stored version's pages, in the same shape.
CREATE OR REPLACE FUNCTION identity_version_pages(p_document uuid) RETURNS jsonb AS $$
  SELECT coalesce(
           jsonb_agg(jsonb_build_object('part', part, 'key', storage_key, 'name', file_name)
                     ORDER BY part),
           '[]'::jsonb)
    FROM client_document_pages WHERE document_id = p_document;
$$ LANGUAGE sql STABLE;

-- A broker's upload's slot. Keys are generated `customField_*`; an older key
-- that the slot rule would refuse is made safe rather than failing the deploy.
CREATE OR REPLACE FUNCTION identity_other_slot(p_key text) RETURNS text AS $$
  SELECT 'other:' || left(
           CASE WHEN p_key ~ '^[A-Za-z]' THEN '' ELSE 'k' END
             || regexp_replace(p_key, '[^A-Za-z0-9_-]', '_', 'g'),
           64);
$$ LANGUAGE sql IMMUTABLE;

-- The pages written into a version, each linked to its registry row when it
-- has one (`uploads/kyc/x` is stored as `kyc/x` in the `kyc` bucket).
CREATE OR REPLACE FUNCTION identity_write_pages(p_document uuid, p_pages jsonb) RETURNS void AS $$
  INSERT INTO client_document_pages (document_id, part, storage_key, stored_object_id, file_name)
  SELECT p_document, (e->>'part')::smallint, e->>'key',
         (SELECT so.id FROM stored_objects so
           WHERE so.bucket = 'kyc'
             AND so.storage_key = regexp_replace(e->>'key', '^uploads/', '')
           ORDER BY so.created_at DESC LIMIT 1),
         nullif(e->>'name', '')
    FROM jsonb_array_elements(p_pages) e;
$$ LANGUAGE sql;

-- A FROZEN version with exactly these pages: the existing one, or a new one.
-- No pages, no version — nothing presented is no evidence.
CREATE OR REPLACE FUNCTION identity_frozen_version(
  p_user uuid, p_slot text, p_doc_type text, p_pages jsonb, p_at timestamptz
) RETURNS uuid AS $$
DECLARE
  v_id uuid;
BEGIN
  IF jsonb_array_length(p_pages) = 0 THEN
    RETURN NULL;
  END IF;
  SELECT d.id INTO v_id
    FROM client_documents d
   WHERE d.user_id = p_user AND d.slot = p_slot AND d.frozen_at IS NOT NULL
     AND d.doc_type IS NOT DISTINCT FROM p_doc_type
     AND identity_page_keys(identity_version_pages(d.id)) = identity_page_keys(p_pages)
   ORDER BY d.frozen_at, d.id
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  INSERT INTO client_documents (user_id, slot, doc_type, created_at, frozen_at)
  VALUES (p_user, p_slot, p_doc_type, p_at, p_at)
  RETURNING id INTO v_id;
  PERFORM identity_write_pages(v_id, p_pages);
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- What the client is WORKING ON for a slot: the frozen version it is identical
-- to, or its one draft brought to this shape. Nothing at all: no version.
-- Returns the version the KYC row should point at.
CREATE OR REPLACE FUNCTION identity_working_version(
  p_user uuid, p_slot text, p_doc_type text, p_pages jsonb
) RETURNS uuid AS $$
DECLARE
  v_frozen uuid;
  v_draft uuid;
BEGIN
  SELECT id INTO v_draft FROM client_documents
   WHERE user_id = p_user AND slot = p_slot AND frozen_at IS NULL;

  IF jsonb_array_length(p_pages) > 0 THEN
    SELECT d.id INTO v_frozen
      FROM client_documents d
     WHERE d.user_id = p_user AND d.slot = p_slot AND d.frozen_at IS NOT NULL
       AND d.doc_type IS NOT DISTINCT FROM p_doc_type
       AND identity_page_keys(identity_version_pages(d.id)) = identity_page_keys(p_pages)
     ORDER BY d.frozen_at DESC, d.id
     LIMIT 1;
    IF v_frozen IS NOT NULL THEN
      RETURN v_frozen; -- the caller retires any stale draft
    END IF;
  ELSIF p_doc_type IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_draft IS NULL THEN
    INSERT INTO client_documents (user_id, slot, doc_type)
    VALUES (p_user, p_slot, p_doc_type)
    RETURNING id INTO v_draft;
    PERFORM identity_write_pages(v_draft, p_pages);
  ELSIF v_draft IS NOT NULL
    AND NOT (
      (SELECT doc_type FROM client_documents WHERE id = v_draft) IS NOT DISTINCT FROM p_doc_type
      AND identity_page_keys(identity_version_pages(v_draft)) = identity_page_keys(p_pages)
    ) THEN
    UPDATE client_documents SET doc_type = p_doc_type WHERE id = v_draft;
    DELETE FROM client_document_pages WHERE document_id = v_draft;
    PERFORM identity_write_pages(v_draft, p_pages);
  END IF;
  RETURN v_draft;
END;
$$ LANGUAGE plpgsql;

-- ── The adoption ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION identity_adopt(p_user uuid) RETURNS void AS $$
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
        (user_id, seq, outcome, level_after, method, admin_id, admin_email, reason, returned_items, decided_at)
      VALUES (
        p_user, v_seq,
        CASE WHEN att.status = 'approved' THEN 'verified'
             WHEN v_reverification THEN 'reverification_requested'
             ELSE 'returned' END,
        CASE WHEN att.status = 'approved' THEN 1 ELSE 0 END,
        'manual_review', att.reviewed_by, v_email, att.rejection_reason,
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
$$ LANGUAGE plpgsql;

-- ── What is out of step: the old columns against the record ────────────────
--
-- A row here means something wrote the KYC columns without the record — an
-- older build after a rollback, a fixture reset, raw SQL. `identity_adopt` on
-- that client repairs it. Empty is the healthy state.
CREATE OR REPLACE VIEW identity_drift AS
SELECT k.user_id, s.slot
  FROM kyc_submissions k
 CROSS JOIN (VALUES ('identity'), ('address'), ('selfie')) AS s(slot)
 WHERE identity_page_keys(identity_pages(
         s.slot,
         CASE s.slot WHEN 'identity' THEN k.document WHEN 'address' THEN k.address_proof ELSE k.selfie END))
       IS DISTINCT FROM
       coalesce(identity_page_keys(identity_version_pages(
         CASE s.slot WHEN 'identity' THEN k.identity_document_id
                     WHEN 'address' THEN k.address_document_id
                     ELSE k.selfie_document_id END)), '[]'::jsonb)
    -- The chosen document TYPE, where the record can hold it: with pages, or on
    -- a draft while the client is working. A presented row with a type and no
    -- pages (seed fixtures) has no version — nothing presented is no evidence.
    OR (s.slot <> 'selfie'
        AND (k.status NOT IN ('submitted', 'under_review', 'approved')
             OR jsonb_array_length(identity_pages(
                  s.slot, CASE s.slot WHEN 'identity' THEN k.document ELSE k.address_proof END)) > 0)
        AND nullif(CASE s.slot WHEN 'identity' THEN k.document ELSE k.address_proof END->>'docType', '')
            IS DISTINCT FROM
            (SELECT d.doc_type FROM client_documents d
              WHERE d.id = CASE s.slot WHEN 'identity' THEN k.identity_document_id
                                        ELSE k.address_document_id END));

-- ── The backfill ────────────────────────────────────────────────────────────

DO $$
DECLARE
  u uuid;
BEGIN
  FOR u IN
    SELECT id FROM users
     WHERE verification_level <> 0
        OR id IN (SELECT user_id FROM kyc_submissions)
        OR id IN (SELECT user_id FROM kyc_submission_attempts)
     ORDER BY id
  LOOP
    PERFORM identity_adopt(u);
  END LOOP;
END $$;
