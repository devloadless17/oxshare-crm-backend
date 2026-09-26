-- 0147 — THE IDENTITY CORE: no edit to the KYC form can break a client's identity.
--
-- Hand-written, like every migration since 0027 (see 0040's header).
--
-- ## The defect
--
-- The builder could delete "First Name" from Personal Information, and adding it
-- back made a CUSTOM box whose answer never reached the client's profile. Found on
-- the dev database in exactly that shape: Personal Information holding a single
-- custom field labelled "firstname", with Proof of Address moved to first place.
-- Underneath was one cause — identity was recognised only by a field's KEY, inside a
-- configuration the builder could rewrite at will.
--
-- ## The model (the owner's ruling, 26 Sep 2026 — `common/kyc/identity-core.ts`)
--
--   * the nine identity fields belong to the platform: never stored here, served on
--     every read;
--   * the four built-in steps exist once each, with fixed slugs, titles and icons;
--     Personal Information comes first, and it and Identity Document are always on;
--   * Identity Document and Proof of Address hold only their catalogue documents,
--     each once; Selfie holds only its camera (served, not stored); anything else a
--     broker wants uploaded goes on a step of their own;
--   * no field of the broker's is a second copy of something the platform collects.
--
-- ## What this does to a form saved before — and what it never does
--
-- Every repair is written to ONE `kyc_config.consolidated` audit row (system actor)
-- with the form before and after, and NO client answer is deleted:
--
--   * a missing built-in step is restored — Selfie and Proof of Address switched OFF,
--     because their absence meant nobody was being asked for them;
--   * a duplicated built-in step keeps its first copy; the others become the broker's;
--   * the identity fields and the selfie camera leave the stored rows (they are served);
--   * a document outside its own step, or a second copy of something the platform
--     collects, leaves the FORM — its stored answers stay exactly where they are;
--   * the broker's other fields on Identity Document, Proof of Address and Selfie, and
--     any upload on Personal Information, MOVE to a new step of the broker's own, their
--     answers moved with them;
--   * a field under a key the platform now reserves, or one another field already
--     holds, keeps its question under a fresh key, its answers moved with it.
--
-- `residence_permit` is NOT ticked on an existing Identity Document step: which
-- documents a broker accepts is theirs to decide, and a new choice appearing in front
-- of their clients overnight is a decision nobody made. New installations tick it
-- (`DEFAULT_KYC_STEPS`).
--
-- Archived attempts (`kyc_submission_attempts`) are HISTORY — what a reviewer
-- decided on — and are deliberately left exactly as they are.
--
-- Re-runnable: a second run finds nothing to repair and writes no audit row.

-- For the review and re-verification work that follows (see `schema.ts`).
ALTER TABLE "kyc_submissions" ADD COLUMN IF NOT EXISTS "reverification_requested_at" timestamp with time zone;
ALTER TABLE "kyc_submissions" ADD COLUMN IF NOT EXISTS "form_snapshot" jsonb;

-- A label as compared: case, spacing and punctuation removed (`normaliseLabel`).
CREATE OR REPLACE FUNCTION pg_temp.oxshare_0147_norm(label text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lower(regexp_replace(coalesce(label, ''), '[^[:alnum:]]+', '', 'g'))
$fn$;

-- The canonical document fields for a set of accepted documents, in catalogue order
-- (`documentField` in identity-core.ts).
CREATE OR REPLACE FUNCTION pg_temp.oxshare_0147_documents(accepted text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT coalesce(jsonb_agg(c.field ORDER BY c.ord), '[]'::jsonb)
    FROM (VALUES
      (1, 'passport', '{"id":"f-doc-passport","name":"passport","label":"Passport","type":"doc:passport","required":false}'::jsonb),
      (2, 'national_id', '{"id":"f-doc-national-id","name":"nationalId","label":"National ID","type":"doc:national_id","required":false}'::jsonb),
      (3, 'driving_license', '{"id":"f-doc-driving-license","name":"drivingLicense","label":"Driving License","type":"doc:driving_license","required":false}'::jsonb),
      (4, 'residence_permit', '{"id":"f-doc-residence-permit","name":"residencePermit","label":"Residence Permit","type":"doc:residence_permit","required":false}'::jsonb),
      (5, 'utility_bill', '{"id":"f-addr-utility","name":"utilityBill","label":"Utility Bill","type":"doc:utility_bill","required":false}'::jsonb),
      (6, 'bank_statement', '{"id":"f-addr-bank","name":"bankStatement","label":"Bank Statement","type":"doc:bank_statement","required":false}'::jsonb),
      (7, 'tenancy_agreement', '{"id":"f-addr-tenancy","name":"tenancyAgreement","label":"Tenancy Agreement","type":"doc:tenancy_agreement","required":false}'::jsonb)
    ) AS c(ord, value, field)
   WHERE c.value = ANY (accepted)
$fn$;

-- A step id nothing holds yet.
CREATE OR REPLACE FUNCTION pg_temp.oxshare_0147_free_id(base text) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
  candidate text := base;
  n int := 1;
BEGIN
  WHILE EXISTS (SELECT 1 FROM kyc_config_steps WHERE id = candidate) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  RETURN candidate;
END
$fn$;

-- One answer moved inside every submission's `step_data`: from `[src_step][src_key]`
-- to `[dst_step][dst_key]`. A step or key renamed takes its answers with it.
CREATE OR REPLACE FUNCTION pg_temp.oxshare_0147_move_answer(
  src_step text, src_key text, dst_step text, dst_key text
) RETURNS void
LANGUAGE sql AS $fn$
  UPDATE kyc_submissions
     SET step_data = jsonb_set(
           step_data #- ARRAY[src_step, src_key],
           ARRAY[dst_step],
           coalesce((step_data #- ARRAY[src_step, src_key]) -> dst_step, '{}'::jsonb)
             || jsonb_build_object(dst_key, step_data -> src_step -> src_key))
   WHERE jsonb_typeof(step_data -> src_step) = 'object'
     AND step_data -> src_step ? src_key;
$fn$;

DO $$
DECLARE
  profile_keys constant text[] := ARRAY[
    'firstName', 'lastName', 'dateOfBirth', 'nationality', 'phone', 'country', 'address',
    'city', 'postalCode'];
  -- Keys the system reads by name (`reservedFieldName`).
  reserved constant text[] := ARRAY[
    'firstName', 'lastName', 'dateOfBirth', 'nationality', 'phone', 'country', 'address',
    'city', 'postalCode', 'doc_front', 'doc_back', 'selfie', 'address_proof',
    'address_proof_2', 'docType', 'passport', 'nationalId', 'drivingLicense',
    'residencePermit', 'utilityBill', 'bankStatement', 'tenancyAgreement', 'constructor',
    'prototype', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
    'toLocaleString', 'toString', 'valueOf'];
  -- Labels that name something the platform collects (`platformMeaningOf`).
  platform_labels constant text[] := ARRAY[
    'firstname', 'givenname', 'forename', 'name', 'fullname', 'legalname',
    'lastname', 'surname', 'familyname',
    'dateofbirth', 'birthdate', 'dob', 'birthday',
    'nationality', 'citizenship',
    'phone', 'phonenumber', 'mobile', 'mobilenumber', 'mobilephone', 'telephone',
    'telephonenumber', 'cellphone', 'contactnumber',
    'country', 'countryofresidence', 'residencecountry', 'residence',
    'address', 'residentialaddress', 'streetaddress', 'homeaddress',
    'city', 'town', 'cityortown',
    'postalcode', 'postcode', 'zip', 'zipcode', 'postalzipcode',
    'email', 'emailaddress',
    'passport', 'nationalid', 'nationalidcard', 'idcard', 'identitycard',
    'drivinglicense', 'drivinglicence', 'driverslicense', 'driverslicence',
    'residencepermit', 'residencecard', 'selfie', 'selfiephoto',
    'proofofaddress', 'utilitybill', 'bankstatement', 'tenancyagreement',
    'passportphotopage', 'nationalidfrontside', 'nationalidbackside',
    'drivinglicensefrontside', 'drivinglicensebackside',
    'residencepermitfrontside', 'residencepermitbackside',
    'utilitybillthebill', 'bankstatementthestatement',
    'tenancyagreementsignaturepage', 'tenancyagreementadditionalpage'];
  core_titles constant text[] := ARRAY[
    'personalinformation', 'identitydocument', 'selfieverification', 'proofofaddress'];
  identity_docs constant text[] := ARRAY['passport', 'national_id', 'driving_license', 'residence_permit'];
  address_docs constant text[] := ARRAY['utility_bill', 'bank_statement', 'tenancy_agreement'];

  before_config jsonb;
  after_config jsonb;
  notes jsonb := '[]'::jsonb;
  st record;
  fld jsonb;
  kept jsonb;
  docs text[];
  all_names text[];
  names_seen text[] := ARRAY[]::text[];
  name_ text;
  base text;
  fresh text;
  label_ text;
  type_ text;
  n int;
  identity_stripped boolean := false;
  renames jsonb := '[]'::jsonb;
  extras jsonb := '[]'::jsonb;
  extras_from jsonb := '[]'::jsonb;
  extras_all_uploads boolean := true;
  extra_slug text;
BEGIN
  -- A fresh database: the seed writes the default form, which already fits.
  IF NOT EXISTS (SELECT 1 FROM kyc_config_steps) THEN
    RETURN;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', id, 'slug', slug, 'title', title, 'enabled', enabled,
                                      'fields', fields) ORDER BY step_number, id)
    INTO before_config
    FROM kyc_config_steps;

  -- ── The legacy summary step. The portal appends its own "Review & Submit" after
  --    whatever the form holds, and nothing can be answered on a stored one.
  DELETE FROM kyc_config_steps WHERE slug = 'review';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    notes := notes || to_jsonb('Removed the stored "review" step: the portal always adds its own'::text);
  END IF;

  -- ── A built-in step twice: the first keeps its place, the others become the broker's.
  FOR st IN
    SELECT id, slug, title
      FROM (SELECT id, slug, title,
                   row_number() OVER (PARTITION BY slug ORDER BY step_number, id) AS rn
              FROM kyc_config_steps
             WHERE slug IN ('personal', 'document', 'selfie', 'address')) d
     WHERE rn > 1
  LOOP
    extra_slug := st.slug || '-copy';
    n := 1;
    WHILE EXISTS (SELECT 1 FROM kyc_config_steps WHERE slug = extra_slug) LOOP
      n := n + 1;
      extra_slug := st.slug || '-copy-' || n;
    END LOOP;
    UPDATE kyc_config_steps SET slug = extra_slug, title = st.title || ' (copy)' WHERE id = st.id;
    notes := notes || to_jsonb(format(
      '"%s" appeared twice; the second copy became a step of your own', st.title));
  END LOOP;

  -- ── A missing built-in step comes back. Selfie and Proof of Address come back OFF:
  --    their absence meant nobody was being asked for them.
  IF NOT EXISTS (SELECT 1 FROM kyc_config_steps WHERE slug = 'personal') THEN
    INSERT INTO kyc_config_steps (id, step_number, slug, title, description, icon, enabled, fields)
    VALUES (pg_temp.oxshare_0147_free_id('step-personal'), 0, 'personal', 'Personal Information',
            'Legal identity details exactly as they appear on your government ID.', 'User', true,
            '[]'::jsonb);
    notes := notes || to_jsonb('Restored Personal Information'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kyc_config_steps WHERE slug = 'document') THEN
    INSERT INTO kyc_config_steps (id, step_number, slug, title, description, icon, enabled, fields)
    VALUES (pg_temp.oxshare_0147_free_id('step-document'),
            (SELECT coalesce(max(step_number), 0) + 1 FROM kyc_config_steps), 'document',
            'Identity Document',
            'Upload a valid Passport, National ID, Driving License or Residence Permit.',
            'FileText', true, pg_temp.oxshare_0147_documents(identity_docs));
    notes := notes || to_jsonb('Restored Identity Document'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kyc_config_steps WHERE slug = 'selfie') THEN
    INSERT INTO kyc_config_steps (id, step_number, slug, title, description, icon, enabled, fields)
    VALUES (pg_temp.oxshare_0147_free_id('step-selfie'),
            (SELECT coalesce(max(step_number), 0) + 1 FROM kyc_config_steps), 'selfie',
            'Selfie Verification', 'Live selfie photo matching your identity document.',
            'Camera', false, '[]'::jsonb);
    notes := notes || to_jsonb('Restored Selfie Verification, switched off'::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kyc_config_steps WHERE slug = 'address') THEN
    INSERT INTO kyc_config_steps (id, step_number, slug, title, description, icon, enabled, fields)
    VALUES (pg_temp.oxshare_0147_free_id('step-address'),
            (SELECT coalesce(max(step_number), 0) + 1 FROM kyc_config_steps), 'address',
            'Proof of Address',
            'Document dated within the last 3 months showing your residential address.', 'Home',
            false, pg_temp.oxshare_0147_documents(address_docs));
    notes := notes || to_jsonb('Restored Proof of Address, switched off'::text);
  END IF;

  -- ── Always on, and named as the platform names them.
  UPDATE kyc_config_steps SET enabled = true WHERE slug IN ('personal', 'document') AND NOT enabled;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    notes := notes || to_jsonb(
      'Switched Personal Information and Identity Document on: a verification is these two'::text);
  END IF;
  UPDATE kyc_config_steps s
     SET title = c.title, icon = c.icon
    FROM (VALUES ('personal', 'Personal Information', 'User'),
                 ('document', 'Identity Document', 'FileText'),
                 ('selfie', 'Selfie Verification', 'Camera'),
                 ('address', 'Proof of Address', 'Home')) AS c(slug, title, icon)
   WHERE s.slug = c.slug
     AND (s.title, s.icon) IS DISTINCT FROM (c.title, c.icon);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    notes := notes || to_jsonb('Gave the built-in steps back their own names'::text);
  END IF;

  -- A step of the broker's wearing a built-in step's name.
  UPDATE kyc_config_steps
     SET title = title || ' (additional)'
   WHERE slug NOT IN ('personal', 'document', 'selfie', 'address')
     AND pg_temp.oxshare_0147_norm(title) = ANY (core_titles);

  -- ── Every field, step by step, Personal Information first.
  SELECT coalesce(array_agg(e ->> 'name'), ARRAY[]::text[])
    INTO all_names
    FROM kyc_config_steps, jsonb_array_elements(
      CASE WHEN jsonb_typeof(fields) = 'array' THEN fields ELSE '[]'::jsonb END) AS e;

  FOR st IN
    SELECT id, slug, title, fields
      FROM kyc_config_steps
     ORDER BY (slug <> 'personal'), step_number, id
  LOOP
    kept := '[]'::jsonb;
    docs := ARRAY[]::text[];
    FOR fld IN
      SELECT e
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(st.fields) = 'array' THEN st.fields ELSE '[]'::jsonb END) AS e
    LOOP
      name_ := fld ->> 'name';
      label_ := coalesce(nullif(fld ->> 'label', ''), name_, 'a field');
      type_ := coalesce(fld ->> 'type', 'text');

      -- A document: kept on its own step, once; anywhere else it leaves the form.
      IF type_ LIKE 'doc:%' THEN
        IF (st.slug = 'document' AND substr(type_, 5) = ANY (identity_docs))
           OR (st.slug = 'address' AND substr(type_, 5) = ANY (address_docs)) THEN
          IF NOT (substr(type_, 5) = ANY (docs)) THEN
            docs := docs || substr(type_, 5);
          END IF;
        ELSE
          notes := notes || to_jsonb(format(
            'Removed "%s" from "%s": a document is collected on its own step only', label_,
            st.title));
        END IF;
        CONTINUE;
      END IF;

      -- The platform's own — served on every read, never stored.
      IF st.slug = 'personal' AND name_ = ANY (profile_keys) THEN
        identity_stripped := true;
        CONTINUE;
      END IF;
      CONTINUE WHEN st.slug = 'selfie' AND name_ = 'selfie';

      -- A second copy of something the platform collects.
      IF pg_temp.oxshare_0147_norm(label_) = ANY (platform_labels) THEN
        notes := notes || to_jsonb(format(
          'Removed "%s" from "%s": the platform already collects it in its own place', label_,
          st.title));
        CONTINUE;
      END IF;

      -- A key the platform reserves, one another field holds, or one no answer can be
      -- filed under: a fresh key, the answers moved with it.
      IF name_ IS NULL
         OR name_ = ANY (reserved)
         OR name_ LIKE '\_\_%'
         OR name_ !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
         OR name_ = ANY (names_seen) THEN
        base := 'customField_' || left(regexp_replace(coalesce(name_, ''), '[^A-Za-z0-9_]', '', 'g'), 40);
        IF base = 'customField_' THEN
          base := 'customField_field';
        END IF;
        fresh := base;
        n := 1;
        WHILE fresh = ANY (names_seen) OR fresh = ANY (all_names) LOOP
          n := n + 1;
          fresh := base || '_' || n;
        END LOOP;
        IF name_ IS NOT NULL THEN
          renames := renames || jsonb_build_object(
            'slug', st.slug, 'from', name_, 'to', fresh,
            -- A reviewer's flag names a field by key. Re-pointed only when the old key
            -- was this field's alone — a reserved or shared key's flag meant the other.
            'flags', NOT (name_ = ANY (reserved) OR name_ = ANY (names_seen)));
        END IF;
        all_names := all_names || fresh;
        fld := jsonb_set(fld, '{name}', to_jsonb(fresh));
        notes := notes || to_jsonb(format(
          '"%s" in "%s" is stored under a new key, its answers moved with it', label_, st.title));
        name_ := fresh;
      END IF;
      names_seen := names_seen || name_;

      -- The broker's own field on a step that holds only its documents or the selfie,
      -- or an upload on Personal Information: to a step of the broker's own.
      IF st.slug IN ('document', 'address', 'selfie')
         OR (st.slug = 'personal' AND type_ IN ('file', 'camera')) THEN
        extras := extras || jsonb_build_array(fld);
        extras_from := extras_from || jsonb_build_object('slug', st.slug, 'name', name_);
        extras_all_uploads := extras_all_uploads AND type_ IN ('file', 'camera');
        notes := notes || to_jsonb(format(
          'Moved "%s" from "%s" to a step of your own, with its answers', label_, st.title));
        CONTINUE;
      END IF;

      kept := kept || jsonb_build_array(fld);
    END LOOP;

    IF st.slug IN ('document', 'address') THEN
      IF cardinality(docs) = 0 THEN
        docs := CASE st.slug WHEN 'document' THEN identity_docs ELSE address_docs END;
        notes := notes || to_jsonb(format(
          '"%s" accepted no document; it accepts the standard ones again', st.title));
      END IF;
      kept := pg_temp.oxshare_0147_documents(docs) || kept;
    END IF;

    UPDATE kyc_config_steps SET fields = kept WHERE id = st.id AND fields IS DISTINCT FROM kept;
  END LOOP;

  IF identity_stripped THEN
    notes := notes || to_jsonb(
      'The client''s identity fields are now served by the platform, and no longer stored in the form'::text);
  END IF;

  -- ── Renamed keys take their answers (and, where unambiguous, their flags) along.
  FOR fld IN SELECT e FROM jsonb_array_elements(renames) AS e LOOP
    PERFORM pg_temp.oxshare_0147_move_answer(
      fld ->> 'slug', fld ->> 'from', fld ->> 'slug', fld ->> 'to');
    IF fld ->> 'slug' = 'personal' THEN
      UPDATE kyc_submissions
         SET personal_info = (personal_info - (fld ->> 'from'))
                             || jsonb_build_object(fld ->> 'to', personal_info -> (fld ->> 'from'))
       WHERE jsonb_typeof(personal_info) = 'object'
         AND personal_info ? (fld ->> 'from');
    END IF;
    IF (fld ->> 'flags')::boolean THEN
      UPDATE kyc_submissions
         SET rejected_fields = (
           SELECT jsonb_agg(CASE WHEN f = fld ->> 'from' THEN fld ->> 'to' ELSE f END)
             FROM jsonb_array_elements_text(rejected_fields) AS f)
       WHERE jsonb_typeof(rejected_fields) = 'array'
         AND rejected_fields ? (fld ->> 'from');
    END IF;
  END LOOP;

  -- ── The fields moved off the built-in steps get a step of the broker's own, last.
  IF jsonb_array_length(extras) > 0 THEN
    base := CASE WHEN extras_all_uploads THEN 'additional-documents' ELSE 'additional-information' END;
    extra_slug := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM kyc_config_steps WHERE slug = extra_slug) LOOP
      n := n + 1;
      extra_slug := base || '-' || n;
    END LOOP;
    INSERT INTO kyc_config_steps (id, step_number, slug, title, description, icon, enabled, fields)
    VALUES (pg_temp.oxshare_0147_free_id('step-' || extra_slug),
            (SELECT coalesce(max(step_number), 0) + 1 FROM kyc_config_steps), extra_slug,
            CASE WHEN extras_all_uploads THEN 'Additional documents' ELSE 'Additional information' END,
            CASE WHEN extras_all_uploads
                 THEN 'A few more documents we need to complete your verification.'
                 ELSE 'A few more details we need to complete your verification.' END,
            'FileText', true, extras);
    FOR fld IN SELECT e FROM jsonb_array_elements(extras_from) AS e LOOP
      PERFORM pg_temp.oxshare_0147_move_answer(
        fld ->> 'slug', fld ->> 'name', extra_slug, fld ->> 'name');
    END LOOP;
  END IF;

  -- An answer set emptied by the moves above is no answer set.
  UPDATE kyc_submissions
     SET step_data = (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                        FROM jsonb_each(step_data) AS e(k, v)
                       WHERE v <> '{}'::jsonb)
   WHERE jsonb_typeof(step_data) = 'object'
     AND EXISTS (SELECT 1 FROM jsonb_each(step_data) AS e(k, v) WHERE v = '{}'::jsonb);

  -- ── Personal Information first, the rest in their own order, numbered from one.
  UPDATE kyc_config_steps c
     SET step_number = o.rn
    FROM (SELECT id, row_number() OVER (ORDER BY (slug <> 'personal'), step_number, id) AS rn
            FROM kyc_config_steps) o
   WHERE c.id = o.id
     AND c.step_number IS DISTINCT FROM o.rn;

  SELECT jsonb_agg(jsonb_build_object('id', id, 'slug', slug, 'title', title, 'enabled', enabled,
                                      'fields', fields) ORDER BY step_number, id)
    INTO after_config
    FROM kyc_config_steps;

  IF after_config IS DISTINCT FROM before_config THEN
    IF (before_config -> 0 ->> 'slug') IS DISTINCT FROM 'personal' THEN
      notes := notes || to_jsonb('Moved Personal Information to the front of the form'::text);
    END IF;
    INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id, details)
    VALUES ('00000000-0000-0000-0000-000000000000', 'system@oxshare.internal', 'system',
            'kyc_config.consolidated', 'kyc_config', 'steps',
            jsonb_build_object('changes', notes, 'before', before_config, 'after', after_config));
  END IF;
END $$;
