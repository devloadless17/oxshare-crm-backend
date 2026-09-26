-- 0148 — A QUESTION'S NAME OUTLIVES THE QUESTION (reported 26 Sep 2026).
--
-- An answer is stored under its field's KEY (`customField_1790263641710`), and the
-- question's NAME lived only in the form. Delete the question — or its step, or reset
-- the form — and every answer already given lost its name: the review printed
-- "Custom Field 1790263641710" under "Answers to questions no longer on the form".
--
-- From here the name is kept in `kyc_field_labels`, written by the one path every
-- form change takes (`KycConfigStore.setSteps`) and never deleted. This backfills it
-- from everything that still knows a name, NEWEST first — `ON CONFLICT DO NOTHING`
-- keeps the first name inserted for a key:
--
--   1. the form as it stands;
--   2. what each submission was asked (`form_snapshot`, written at submit since 0147),
--      the most recent submission first;
--   3. the forms the audit trail kept whole: 0147's `kyc_config.consolidated` copy of
--      the form before and after it, and the fields of a single-step edit.
--
-- A question deleted before any of these recorded it has no name left anywhere; the
-- review says so plainly rather than printing its key.
--
-- Only the broker's own fields: never the platform's identity, a document, or a
-- canonical upload slot — each of those has its name fixed by the platform.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS "kyc_field_labels" (
  "name" text PRIMARY KEY,
  "label" text NOT NULL,
  "type" text NOT NULL DEFAULT 'text',
  "recorded_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION pg_temp.oxshare_0148_own_field(fld jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(fld) = 'object'
     AND coalesce(fld ->> 'name', '') <> ''
     AND coalesce(btrim(fld ->> 'label'), '') <> ''
     AND coalesce(fld ->> 'type', '') NOT LIKE 'doc:%'
     AND (fld ->> 'name') NOT IN (
       'firstName', 'lastName', 'dateOfBirth', 'nationality', 'phone', 'country',
       'address', 'city', 'postalCode',
       'doc_front', 'doc_back', 'selfie', 'address_proof', 'address_proof_2')
$$;

CREATE OR REPLACE FUNCTION pg_temp.oxshare_0148_fields(arr jsonb) RETURNS SETOF jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT f FROM jsonb_array_elements(CASE WHEN jsonb_typeof(arr) = 'array' THEN arr ELSE '[]'::jsonb END) AS f
$$;

-- 1. The form as it stands.
INSERT INTO kyc_field_labels (name, label, type)
SELECT DISTINCT ON (f ->> 'name') f ->> 'name', btrim(f ->> 'label'), coalesce(f ->> 'type', 'text')
  FROM kyc_config_steps s, pg_temp.oxshare_0148_fields(s.fields) AS f
 WHERE pg_temp.oxshare_0148_own_field(f)
 ORDER BY f ->> 'name', s.step_number
ON CONFLICT (name) DO NOTHING;

-- 2. What each submission was asked, the most recent first.
INSERT INTO kyc_field_labels (name, label, type)
SELECT DISTINCT ON (f ->> 'name') f ->> 'name', btrim(f ->> 'label'), coalesce(f ->> 'type', 'text')
  FROM kyc_submissions k,
       pg_temp.oxshare_0148_fields(k.form_snapshot) AS st,
       pg_temp.oxshare_0148_fields(st -> 'fields') AS f
 WHERE pg_temp.oxshare_0148_own_field(f)
 ORDER BY f ->> 'name', k.submitted_at DESC NULLS LAST, k.updated_at DESC NULLS LAST
ON CONFLICT (name) DO NOTHING;

-- 3. The forms the audit trail kept whole, the most recent first: 0147's copy of the
--    form after and before it, then the fields of a single-step edit.
INSERT INTO kyc_field_labels (name, label, type)
SELECT DISTINCT ON (f ->> 'name') f ->> 'name', btrim(f ->> 'label'), coalesce(f ->> 'type', 'text')
  FROM (
        SELECT a.created_at, 0 AS rank, st
          FROM audit_log a, pg_temp.oxshare_0148_fields(a.details -> 'after') AS st
         WHERE a.action = 'kyc_config.consolidated'
        UNION ALL
        SELECT a.created_at, 1 AS rank, st
          FROM audit_log a, pg_temp.oxshare_0148_fields(a.details -> 'before') AS st
         WHERE a.action = 'kyc_config.consolidated'
        UNION ALL
        SELECT a.created_at, 0 AS rank, a.details -> 'patch' AS st
          FROM audit_log a
         WHERE a.action = 'kyc_config.step_update'
           AND jsonb_typeof(a.details -> 'patch') = 'object'
       ) AS forms,
       pg_temp.oxshare_0148_fields(forms.st -> 'fields') AS f
 WHERE pg_temp.oxshare_0148_own_field(f)
 ORDER BY f ->> 'name', forms.created_at DESC, forms.rank
ON CONFLICT (name) DO NOTHING;
