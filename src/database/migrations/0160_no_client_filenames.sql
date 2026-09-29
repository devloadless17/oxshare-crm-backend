-- 0160 — A CLIENT'S ORIGINAL FILENAME IS NEITHER KEPT NOR SHOWN (D-84, 29 Sep 2026).
--
-- What a file was called on the client's device is text the client typed, and it
-- routinely carries exactly what field masking exists to govern — a name, a document
-- number, a date of birth: `layla_haddad_passport_X1234567.jpg`. It was kept in three
-- places and printed beside the document for every reviewer, whatever their role hid:
--   * `stored_objects.original_name` — the upload registry (0064);
--   * `client_document_pages.file_name` — the identity record's pages (0151);
--   * the KYC rows' evidence (`frontFileName`, `backFileName`, `fileName`,
--     `page2FileName`) and every upload answer in `step_data` (`{filePath, fileName}`),
--     on live submissions and archived attempts alike.
--
-- Nothing needs it. A stored file is named by the system (`<uuid>.<ext>`, the extension
-- decided by the file's own bytes), and a document is named by WHAT IT IS — "Passport —
-- front" — which both consoles render from the document type and the page. So it is not
-- masked, it is gone: the two columns are dropped, the KYC rows lose the keys, and the
-- identity functions stop reading or writing a page's name. The owner approved clearing
-- what was already stored (29 Sep 2026). The name the portal shows beside a file the
-- client has just picked comes from their own browser and never reaches the API.
--
-- Written for BOTH migration modes (backend CLAUDE.md, "On a FRESH database…"): every
-- statement stands alone, and the one helper is a session function this file drops.
--
-- The KYC rows' deferred identity triggers (0153) re-adopt each changed client at COMMIT.
-- Adoption compares pages by KEY — "names are not identity" (0152) — so stripping names
-- makes no new version of anything.

-- ── The identity functions: pages are a part and a key, nothing else ─────────────────
CREATE OR REPLACE FUNCTION identity_evidence(p_document uuid, p_slot text) RETURNS jsonb AS $$
  SELECT jsonb_strip_nulls(CASE p_slot
           WHEN 'identity' THEN jsonb_build_object(
             'docType', d.doc_type,
             'frontFilePath', p0.storage_key,
             'backFilePath', p1.storage_key)
           WHEN 'address' THEN jsonb_build_object(
             'docType', d.doc_type,
             'filePath', p0.storage_key,
             'page2FilePath', p1.storage_key)
           ELSE jsonb_build_object('filePath', p0.storage_key)
         END)
    FROM client_documents d
    LEFT JOIN client_document_pages p0 ON p0.document_id = d.id AND p0.part = 0
    LEFT JOIN client_document_pages p1 ON p1.document_id = d.id AND p1.part = 1
   WHERE d.id = p_document;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION identity_pages(p_slot text, p_value jsonb) RETURNS jsonb AS $$
  SELECT coalesce(
           jsonb_agg(jsonb_build_object('part', part, 'key', key) ORDER BY part),
           '[]'::jsonb)
    FROM (
          SELECT 0 AS part, identity_page_key(p_value->>'frontFilePath') AS key
           WHERE p_slot = 'identity'
          UNION ALL
          SELECT 1, identity_page_key(p_value->>'backFilePath')
           WHERE p_slot = 'identity'
          UNION ALL
          SELECT 0, identity_page_key(p_value->>'filePath')
           WHERE p_slot IN ('address', 'selfie') OR p_slot LIKE 'other:%'
          UNION ALL
          SELECT 1, identity_page_key(p_value->>'page2FilePath')
           WHERE p_slot = 'address'
         ) p
   WHERE key IS NOT NULL;
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION identity_version_pages(p_document uuid) RETURNS jsonb AS $$
  SELECT coalesce(
           jsonb_agg(jsonb_build_object('part', part, 'key', storage_key) ORDER BY part),
           '[]'::jsonb)
    FROM client_document_pages WHERE document_id = p_document;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION identity_write_pages(p_document uuid, p_pages jsonb) RETURNS void AS $$
  INSERT INTO client_document_pages (document_id, part, storage_key, stored_object_id)
  SELECT p_document, (e->>'part')::smallint, e->>'key',
         (SELECT so.id FROM stored_objects so
           WHERE so.bucket = 'kyc'
             AND so.storage_key = regexp_replace(e->>'key', '^uploads/', '')
           ORDER BY so.created_at DESC LIMIT 1)
    FROM jsonb_array_elements(p_pages) e;
$$ LANGUAGE sql;
--> statement-breakpoint

-- ── The columns go: nothing can store a filename again ───────────────────────────────
-- A DDL change, not a row UPDATE, so the frozen-page guard (0151) is not involved: the
-- evidence — which file, at which part, of which version — is untouched.
ALTER TABLE client_document_pages DROP COLUMN IF EXISTS file_name;
--> statement-breakpoint
ALTER TABLE stored_objects DROP COLUMN IF EXISTS original_name;
--> statement-breakpoint

-- ── The KYC rows lose the keys, at any depth ──────────────────────────────────────────
-- Only the four filename keys, only in the four evidence columns. Every path, docType and
-- answer stays exactly as stored.
CREATE FUNCTION pg_temp.without_file_names(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v jsonb; acc jsonb;
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      acc := '{}'::jsonb;
      FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
        IF k NOT IN ('fileName', 'frontFileName', 'backFileName', 'page2FileName') THEN
          acc := acc || jsonb_build_object(k, pg_temp.without_file_names(v));
        END IF;
      END LOOP;
      RETURN acc;
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(pg_temp.without_file_names(e) ORDER BY i), '[]'::jsonb)
        INTO acc FROM jsonb_array_elements(j) WITH ORDINALITY AS a(e, i);
      RETURN acc;
    ELSE
      RETURN j;
  END CASE;
END $$;
--> statement-breakpoint
UPDATE kyc_submissions
   SET document      = pg_temp.without_file_names(document),
       address_proof = pg_temp.without_file_names(address_proof),
       selfie        = pg_temp.without_file_names(selfie),
       step_data     = pg_temp.without_file_names(step_data)
 WHERE concat(document::text, address_proof::text, selfie::text, step_data::text)
       ~ '"(fileName|frontFileName|backFileName|page2FileName)"';
--> statement-breakpoint
UPDATE kyc_submission_attempts
   SET document      = pg_temp.without_file_names(document),
       address_proof = pg_temp.without_file_names(address_proof),
       selfie        = pg_temp.without_file_names(selfie),
       step_data     = pg_temp.without_file_names(step_data)
 WHERE concat(document::text, address_proof::text, selfie::text, step_data::text)
       ~ '"(fileName|frontFileName|backFileName|page2FileName)"';
--> statement-breakpoint
-- The session's helper goes with the migration rather than with the connection.
DROP FUNCTION pg_temp.without_file_names(jsonb);
