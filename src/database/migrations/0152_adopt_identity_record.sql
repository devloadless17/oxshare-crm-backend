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

-- The ONE spelling of a stored KYC file: `uploads/kyc/<name>`.
--
-- The KYC columns have held several over the years — `./uploads/kyc/x.jpg`,
-- `/uploads/kyc/x.jpg`, `uploads\kyc\x.jpg`, a bare `x.jpg` (the list
-- `filenameFromStored` in storage-key.ts reads) — and every one is the same
-- file, served by `GET /uploads/kyc/<name>` from the same bucket: only the
-- NAME matters. The record keeps one spelling so the file route can find a
-- page's owner by an exact, indexed key. NULL for a value that names no file
-- (empty, a directory, a dot-name), exactly where `filenameFromStored` is.
CREATE OR REPLACE FUNCTION identity_page_key(p_path text) RETURNS text AS $$
  SELECT CASE WHEN name = '' OR left(name, 1) = '.' THEN NULL
              ELSE 'uploads/kyc/' || name END
    FROM (SELECT regexp_replace(replace(p_path, '\', '/'), '^.*/', '') AS name) n
   WHERE p_path IS NOT NULL;
$$ LANGUAGE sql IMMUTABLE;

-- The pages a KYC value holds for a slot, as [{part, key, name}] in part order.
CREATE OR REPLACE FUNCTION identity_pages(p_slot text, p_value jsonb) RETURNS jsonb AS $$
  SELECT coalesce(
           jsonb_agg(jsonb_build_object('part', part, 'key', key, 'name', name) ORDER BY part),
           '[]'::jsonb)
    FROM (
          SELECT 0 AS part, identity_page_key(p_value->>'frontFilePath') AS key,
                 p_value->>'frontFileName' AS name
           WHERE p_slot = 'identity'
          UNION ALL
          SELECT 1, identity_page_key(p_value->>'backFilePath'), p_value->>'backFileName'
           WHERE p_slot = 'identity'
          UNION ALL
          SELECT 0, identity_page_key(p_value->>'filePath'), p_value->>'fileName'
           WHERE p_slot IN ('address', 'selfie') OR p_slot LIKE 'other:%'
          UNION ALL
          SELECT 1, identity_page_key(p_value->>'page2FilePath'), p_value->>'page2FileName'
           WHERE p_slot = 'address'
         ) p
   WHERE key IS NOT NULL;
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

  -- One client is adopted by one transaction at a time. Every KYC path already
  -- holds this row when it calls here, so for them this is a no-op; a repair
  -- running beside live traffic (the boot check) waits for the KYC change in
  -- flight instead of racing it to the same versions. Taken FIRST, before any
  -- version is touched, which is the order the KYC paths take them in.
  PERFORM 1 FROM kyc_submissions WHERE user_id = p_user FOR NO KEY UPDATE;

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
$$ LANGUAGE plpgsql;

-- ── What is out of step: the old columns against the record ────────────────
--
-- A row here means something wrote the KYC columns without the record — an
-- older build after a rollback, a fixture reset, raw SQL. Empty is the
-- healthy state. One row per disagreement, named by `problem`:
--
--   pages              a live document's pages are not the version it points at
--   type               nor is its chosen document type
--   not_frozen         with a reviewer or approved, yet it points at a draft
--   upload             a broker's upload that no version holds exactly
--   unrecorded_page    a page an archived attempt names and no version holds
--   stale_draft        a draft the client is no longer working on
--   undecided_attempt  an archived attempt with no decision on the log
--   level              the verification level is not the latest decision
--
-- ⚠️ `identity_adopt` must clear EVERY kind listed here. The boot check adopts
-- each client this names, so a kind adoption cannot clear would be reported —
-- and "repaired" — on every boot for ever. `migration-0152-adopt-identity.spec.ts`
-- creates each kind and proves one adoption clears it.
--
-- Dropped and created rather than replaced: a view's columns cannot be renamed
-- or reordered in place, and this file must run twice.
DROP VIEW IF EXISTS identity_drift;
CREATE VIEW identity_drift AS
WITH live AS (
  SELECT k.user_id, k.document, k.address_proof, k.selfie, k.step_data,
         k.identity_document_id, k.address_document_id, k.selfie_document_id,
         k.status IN ('submitted', 'under_review', 'approved') AS presented
    FROM kyc_submissions k
), live_documents AS (
  SELECT l.user_id, l.presented, s.slot,
         CASE s.slot WHEN 'identity' THEN l.document
                     WHEN 'address' THEN l.address_proof
                     ELSE l.selfie END AS value,
         CASE s.slot WHEN 'identity' THEN l.identity_document_id
                     WHEN 'address' THEN l.address_document_id
                     ELSE l.selfie_document_id END AS document_id
    FROM live l
   CROSS JOIN (VALUES ('identity'), ('address'), ('selfie')) AS s(slot)
), live_uploads AS (
  SELECT l.user_id, l.presented, identity_other_slot(x.key) AS slot,
         identity_pages('other:x', x.v) AS pages
    FROM live l,
         jsonb_each(coalesce(l.step_data, '{}'::jsonb)) s(slug, a),
         jsonb_each(CASE WHEN jsonb_typeof(s.a) = 'object' THEN s.a ELSE '{}'::jsonb END) x(key, v)
   WHERE jsonb_typeof(x.v) = 'object' AND x.v ? 'filePath'
), archived_pages AS (
  SELECT a.user_id, p.slot, e->>'key' AS storage_key
    FROM kyc_submission_attempts a
   CROSS JOIN LATERAL (
          SELECT 'identity' AS slot, identity_pages('identity', a.document) AS pages
          UNION ALL SELECT 'address', identity_pages('address', a.address_proof)
          UNION ALL SELECT 'selfie', identity_pages('selfie', a.selfie)
          UNION ALL
          SELECT identity_other_slot(x.key), identity_pages('other:x', x.v)
            FROM jsonb_each(coalesce(a.step_data, '{}'::jsonb)) s(slug, answers),
                 jsonb_each(CASE WHEN jsonb_typeof(s.answers) = 'object'
                                 THEN s.answers ELSE '{}'::jsonb END) x(key, v)
           WHERE jsonb_typeof(x.v) = 'object' AND x.v ? 'filePath'
         ) p
   CROSS JOIN LATERAL jsonb_array_elements(p.pages) e
)
SELECT user_id, slot, 'pages'::text AS problem
  FROM live_documents
 WHERE identity_page_keys(identity_pages(slot, value))
       IS DISTINCT FROM coalesce(identity_page_keys(identity_version_pages(document_id)), '[]'::jsonb)
UNION ALL
-- The chosen document TYPE, where the record can hold it: with pages, or on a
-- draft while the client is working. A presented row with a type and no pages
-- (seed fixtures) has no version — nothing presented is no evidence.
SELECT user_id, slot, 'type'
  FROM live_documents
 WHERE slot <> 'selfie'
   AND (NOT presented OR jsonb_array_length(identity_pages(slot, value)) > 0)
   AND nullif(value->>'docType', '')
       IS DISTINCT FROM (SELECT d.doc_type FROM client_documents d WHERE d.id = document_id)
UNION ALL
SELECT l.user_id, l.slot, 'not_frozen'
  FROM live_documents l
  JOIN client_documents d ON d.id = l.document_id
 WHERE l.presented AND d.frozen_at IS NULL
UNION ALL
-- A working client's upload may sit on its draft or on a frozen version with
-- the same pages (an upload returned unchanged); a presented one only frozen.
SELECT u.user_id, u.slot, 'upload'
  FROM live_uploads u
 WHERE jsonb_array_length(u.pages) > 0
   AND NOT EXISTS (
         SELECT 1 FROM client_documents d
          WHERE d.user_id = u.user_id AND d.slot = u.slot
            AND (d.frozen_at IS NOT NULL OR NOT u.presented)
            AND identity_page_keys(identity_version_pages(d.id)) = identity_page_keys(u.pages))
UNION ALL
SELECT DISTINCT a.user_id, a.slot, 'unrecorded_page'
  FROM archived_pages a
 WHERE NOT EXISTS (
         SELECT 1 FROM client_document_pages p
           JOIN client_documents d ON d.id = p.document_id
          WHERE d.user_id = a.user_id AND d.slot = a.slot AND p.storage_key = a.storage_key)
UNION ALL
-- A draft is kept only while the client works on it: pointed at by the live
-- row for the platform's three, answering a live upload for a broker's.
SELECT d.user_id, d.slot, 'stale_draft'
  FROM client_documents d
  LEFT JOIN live l ON l.user_id = d.user_id
 WHERE d.frozen_at IS NULL
   AND (l.user_id IS NULL
        OR l.presented
        OR CASE WHEN d.slot LIKE 'other:%' THEN
                  NOT EXISTS (SELECT 1 FROM live_uploads u
                               WHERE u.user_id = d.user_id AND u.slot = d.slot
                                 AND jsonb_array_length(u.pages) > 0)
                ELSE
                  d.id IS DISTINCT FROM CASE d.slot WHEN 'identity' THEN l.identity_document_id
                                                    WHEN 'address' THEN l.address_document_id
                                                    ELSE l.selfie_document_id END
           END)
UNION ALL
SELECT user_id, NULL, 'undecided_attempt'
  FROM kyc_submission_attempts
 WHERE verification_id IS NULL
UNION ALL
SELECT u.id, NULL, 'level'
  FROM users u
 WHERE least(greatest(u.verification_level, 0), 1) IS DISTINCT FROM coalesce(
         (SELECT v.level_after FROM client_verifications v
           WHERE v.user_id = u.id ORDER BY v.seq DESC LIMIT 1), 0);

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
