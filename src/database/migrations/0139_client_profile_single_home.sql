-- 0139 — ONE CLIENT PROFILE: every identity field gets a single home.
--
-- Hand-written, like every migration since 0027 (see 0040's header).
--
-- ## The defect
--
-- A client's identity lived in TWO places that nothing kept equal:
--
--   users                        first_name, last_name, phone, country
--   kyc_submissions.personal_info firstName, lastName, phone, country — AGAIN —
--                                 plus dateOfBirth, nationality, address
--
-- Approval copied phone and country one way; submit copied the name the other
-- way when the blob was empty; every screen read one of the two. A client who
-- registered as "t1" and typed "test1" into KYC held BOTH names for ever, and the
-- admin review page printed them side by side.
--
-- ## The fix
--
-- Every identity field lives in its `users` column and nowhere else (the rules
-- are `common/profile/client-profile.ts`). The KYC personal step reads and
-- writes those columns; `personal_info` keeps only answers to fields a broker
-- invented. There is no second copy left to disagree.
--
-- ## Consolidating what is already there — which copy wins
--
-- For each client, field by field, when the two copies DISAGREE:
--
--   * the KYC answer wins — it is the one entered "as on your ID", and for an
--     approved client it is the one a reviewer checked against a document;
--   * UNLESS the support desk edited that field on the profile AFTER the KYC
--     answer was last written (a `client.profile_update` audit row names it) —
--     then the desk's correction is the newer decision and stands.
--
-- Nothing is lost either way: every overwritten value and every KYC answer not
-- taken is recorded in ONE `client.profile_consolidated` audit row per client,
-- with `before` / `after` / `discarded`, by the system actor. A value that
-- cannot be stored (a date of birth that is not a real day, a text longer than
-- its column) is `discarded` there rather than truncated or guessed at.
--
-- Archived attempts (`kyc_submission_attempts.personal_info`) are HISTORY — what
-- a reviewer decided on — and are deliberately left exactly as they are.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "date_of_birth" date;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "nationality" varchar(100);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "address" varchar(200);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "city" varchar(100);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "postal_code" varchar(12);

DO $$
DECLARE
  sub record;
  u record;
  field text;
  col text;
  max_len int;
  v text;
  norm text;
  current_value text;
  dob date;
  before_ jsonb;
  after_ jsonb;
  discarded jsonb;
  details jsonb;
BEGIN
  FOR sub IN
    SELECT k.user_id, k.updated_at, k.personal_info
      FROM kyc_submissions k
     WHERE k.personal_info IS NOT NULL
       AND k.personal_info ?| ARRAY['firstName', 'lastName', 'phone', 'country',
                                    'dateOfBirth', 'nationality', 'address', 'city', 'postalCode']
  LOOP
    SELECT id, first_name, last_name, phone, country
      INTO u
      FROM users
     WHERE id = sub.user_id
       FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    before_ := '{}'::jsonb;
    after_ := '{}'::jsonb;
    discarded := '{}'::jsonb;

    -- ── The four fields held in BOTH places ─────────────────────────────────
    FOREACH field IN ARRAY ARRAY['firstName', 'lastName', 'phone', 'country'] LOOP
      v := nullif(btrim(regexp_replace(coalesce(sub.personal_info ->> field, ''), '\s+', ' ', 'g')), '');
      CONTINUE WHEN v IS NULL;

      col := CASE field
        WHEN 'firstName' THEN 'first_name'
        WHEN 'lastName' THEN 'last_name'
        ELSE field
      END;
      max_len := CASE field WHEN 'phone' THEN 32 ELSE 100 END;
      current_value := CASE field
        WHEN 'firstName' THEN u.first_name
        WHEN 'lastName' THEN u.last_name
        WHEN 'phone' THEN u.phone
        ELSE u.country
      END;

      IF field = 'phone' THEN
        -- E.164, as every new write stores it: "+961 70 123 456" → "+96170123456".
        norm := regexp_replace(v, '[\s().-]', '', 'g');
        IF norm ~ '^\+[1-9][0-9]{6,14}$' THEN
          v := norm;
        END IF;
        IF current_value IS NOT NULL
           AND regexp_replace(current_value, '[\s().-]', '', 'g') = v THEN
          CONTINUE;  -- the same number, typed differently
        END IF;
      END IF;

      CONTINUE WHEN v IS NOT DISTINCT FROM current_value;

      IF length(v) > max_len THEN
        discarded := discarded || jsonb_build_object(field, v);
      ELSIF EXISTS (
        SELECT 1
          FROM audit_log a
         WHERE a.action = 'client.profile_update'
           AND a.subject_type = 'user'
           AND a.subject_id = sub.user_id::text
           AND a.details -> 'after' ? field
           AND a.created_at > sub.updated_at
      ) THEN
        -- The desk corrected the profile after this answer: that decision stands.
        discarded := discarded || jsonb_build_object(field, v);
      ELSE
        before_ := before_ || jsonb_build_object(field, current_value);
        after_ := after_ || jsonb_build_object(field, v);
        EXECUTE format('UPDATE users SET %I = $1 WHERE id = $2', col) USING v, sub.user_id;
      END IF;
    END LOOP;

    -- ── Date of birth: a real day, or recorded as not taken ────────────────
    v := nullif(btrim(coalesce(sub.personal_info ->> 'dateOfBirth', '')), '');
    IF v IS NOT NULL THEN
      BEGIN
        -- Older rows hold a full timestamp; the calendar day is its first ten characters.
        dob := substring(v FROM '^(\d{4}-\d{2}-\d{2})')::date;
      EXCEPTION WHEN others THEN
        dob := NULL;  -- "2026-02-31" and friends
      END;
      IF dob IS NULL THEN
        discarded := discarded || jsonb_build_object('dateOfBirth', v);
      ELSE
        UPDATE users SET date_of_birth = dob WHERE id = sub.user_id;
        after_ := after_ || jsonb_build_object('dateOfBirth', to_char(dob, 'YYYY-MM-DD'));
      END IF;
    END IF;

    -- ── The text fields that only KYC held ─────────────────────────────────
    FOREACH field IN ARRAY ARRAY['nationality', 'address', 'city', 'postalCode'] LOOP
      v := nullif(btrim(regexp_replace(coalesce(sub.personal_info ->> field, ''), '\s+', ' ', 'g')), '');
      CONTINUE WHEN v IS NULL;
      col := CASE field WHEN 'postalCode' THEN 'postal_code' ELSE field END;
      max_len := CASE field WHEN 'address' THEN 200 WHEN 'postalCode' THEN 12 ELSE 100 END;
      IF length(v) > max_len THEN
        discarded := discarded || jsonb_build_object(field, v);
      ELSE
        EXECUTE format('UPDATE users SET %I = $1 WHERE id = $2', col) USING v, sub.user_id;
        after_ := after_ || jsonb_build_object(field, v);
      END IF;
    END LOOP;

    IF after_ <> '{}'::jsonb OR discarded <> '{}'::jsonb THEN
      details := jsonb_build_object('source', 'kyc_submissions.personal_info — migration 0139');
      IF before_ <> '{}'::jsonb THEN details := details || jsonb_build_object('before', before_); END IF;
      IF after_ <> '{}'::jsonb THEN details := details || jsonb_build_object('after', after_); END IF;
      IF discarded <> '{}'::jsonb THEN details := details || jsonb_build_object('discarded', discarded); END IF;

      INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id, details)
      VALUES ('00000000-0000-0000-0000-000000000000', 'system@oxshare.internal', 'system',
              'client.profile_consolidated', 'user', sub.user_id::text, details);
    END IF;
  END LOOP;
END $$;

-- The second copy goes. From here `personal_info` holds only answers to fields a
-- broker invented; the profile keys are read from `users`.
UPDATE kyc_submissions
   SET personal_info = personal_info - ARRAY['firstName', 'lastName', 'phone', 'country',
                                             'dateOfBirth', 'nationality', 'address', 'city', 'postalCode']
 WHERE personal_info ?| ARRAY['firstName', 'lastName', 'phone', 'country',
                              'dateOfBirth', 'nationality', 'address', 'city', 'postalCode'];

-- Phones not touched above take the same E.164 shape, so one number is one string.
UPDATE users
   SET phone = regexp_replace(phone, '[\s().-]', '', 'g')
 WHERE phone IS NOT NULL
   AND phone <> regexp_replace(phone, '[\s().-]', '', 'g')
   AND regexp_replace(phone, '[\s().-]', '', 'g') ~ '^\+[1-9][0-9]{6,14}$';

-- A blank is not a value.
UPDATE users SET phone = NULL WHERE phone IS NOT NULL AND btrim(phone) = '';
UPDATE users SET country = NULL WHERE country IS NOT NULL AND btrim(country) = '';

-- ── Field masks follow the fields ──────────────────────────────────────────
--
-- A role that hid date of birth, nationality or address hid them on the KYC
-- screen, where they lived. They live on the profile now, so the mask moves to
-- the profile key — and a role that hid the ADDRESS also hides the city and
-- postal code that complete it. Hiding more is the only safe direction.
CREATE OR REPLACE FUNCTION pg_temp.oxshare_0139_remap_masks(masks jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT coalesce(jsonb_agg(DISTINCT key ORDER BY key), '[]'::jsonb)
    FROM (
      SELECT CASE m
               WHEN 'kyc.personalInfo.dateOfBirth' THEN 'client.dateOfBirth'
               WHEN 'kyc.personalInfo.nationality' THEN 'client.nationality'
               WHEN 'kyc.personalInfo.address' THEN 'client.address'
               ELSE m
             END AS key
        FROM jsonb_array_elements_text(masks) AS m
      UNION ALL
      SELECT extra
        FROM jsonb_array_elements_text(masks) AS m,
             unnest(ARRAY['client.city', 'client.postalCode']) AS extra
       WHERE m = 'kyc.personalInfo.address'
    ) remapped
$fn$;

UPDATE roles
   SET masked_fields = pg_temp.oxshare_0139_remap_masks(masked_fields)
 WHERE masked_fields ?| ARRAY['kyc.personalInfo.dateOfBirth', 'kyc.personalInfo.nationality',
                              'kyc.personalInfo.address'];
UPDATE admins
   SET masked_fields = pg_temp.oxshare_0139_remap_masks(masked_fields)
 WHERE masked_fields IS NOT NULL
   AND masked_fields ?| ARRAY['kyc.personalInfo.dateOfBirth', 'kyc.personalInfo.nationality',
                              'kyc.personalInfo.address'];
UPDATE admin_invites
   SET masked_fields = pg_temp.oxshare_0139_remap_masks(masked_fields)
 WHERE masked_fields IS NOT NULL
   AND masked_fields ?| ARRAY['kyc.personalInfo.dateOfBirth', 'kyc.personalInfo.nationality',
                              'kyc.personalInfo.address'];

-- ── The KYC personal step asks for the whole address ───────────────────────
--
-- Registration now collects city and postal code; the personal step shows them
-- beside the street address, pre-filled, so a client confirms rather than
-- retypes. Inserted right after `address` (or at the end), OPTIONAL like the
-- address itself — a broker who wants them required says so in the builder.
--
-- The ids are NAMES, not the next numbers in the f-N series: `f-8`..`f-10` were
-- the identity-document fields before 0074, and a field id is matched across
-- the whole configuration (`assertReservedKeysNotRenamed`), so reusing one could
-- make an old config read as a rename and refuse every later save.
UPDATE kyc_config_steps s
   SET fields = (
     SELECT jsonb_agg(merged.elem ORDER BY merged.ord, merged.sub)
       FROM (
         SELECT f.elem, f.ord, 0 AS sub
           FROM jsonb_array_elements(s.fields) WITH ORDINALITY AS f(elem, ord)
         UNION ALL
         SELECT x.elem,
                (SELECT coalesce(max(o.ord) FILTER (WHERE o.elem ->> 'name' = 'address'), max(o.ord), 0)
                   FROM jsonb_array_elements(s.fields) WITH ORDINALITY AS o(elem, ord)),
                x.sub
           FROM (VALUES
                   (jsonb_build_object('id', 'f-city', 'name', 'city', 'label', 'City',
                                       'type', 'text', 'required', false), 1),
                   (jsonb_build_object('id', 'f-postal-code', 'name', 'postalCode', 'label', 'Postal / ZIP code',
                                       'type', 'text', 'required', false,
                                       'hint', 'Leave blank if your address has none'), 2)
                ) AS x(elem, sub)
       ) merged
   )
 WHERE s.slug = 'personal'
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(s.fields) e WHERE e ->> 'name' IN ('city', 'postalCode')
   );

-- ── A profile field keeps its kind; the drop-downs offer the platform's lists ─
--
-- The builder refuses both edits from now on (`assertProfileFieldsKeepTheirPlace`);
-- this repairs a configuration saved before that rule existed, so a live form
-- cannot offer a box whose answer the profile then refuses:
--
--   * on the personal step, each profile field gets back the type its column
--     holds — a date of birth re-typed as text would hand the date column
--     "next spring", and a client could not get past the step;
--   * nationality and country lose any STORED options. Those are served from the
--     package on every read now, and the rows hold a copy only because the old
--     strip compared the list by identity, which a JSON round trip never keeps —
--     the first builder save baked 187 nationalities and 251 countries in.
UPDATE kyc_config_steps s
   SET fields = coalesce((
     SELECT jsonb_agg(
              CASE
                WHEN f.elem ->> 'name' IN ('nationality', 'country')
                     AND (s.slug = 'personal' OR f.elem ->> 'type' = 'select')
                  THEN jsonb_set(f.elem - 'options', '{type}', '"select"')
                WHEN s.slug <> 'personal' THEN f.elem
                WHEN f.elem ->> 'name' = 'dateOfBirth'
                  THEN jsonb_set(f.elem, '{type}', '"date"')
                WHEN f.elem ->> 'name' = 'phone'
                  THEN jsonb_set(f.elem, '{type}', '"phone"')
                WHEN f.elem ->> 'name' IN ('firstName', 'lastName', 'address', 'city', 'postalCode')
                  THEN jsonb_set(f.elem, '{type}', '"text"')
                ELSE f.elem
              END
              ORDER BY f.ord)
       FROM jsonb_array_elements(s.fields) WITH ORDINALITY AS f(elem, ord)
   ), '[]'::jsonb)
 WHERE jsonb_typeof(s.fields) = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(s.fields) e
      WHERE (e ->> 'name' IN ('nationality', 'country') AND (s.slug = 'personal' OR e ->> 'type' = 'select') AND (e ? 'options' OR e ->> 'type' <> 'select'))
         OR (s.slug = 'personal' AND e ->> 'name' = 'dateOfBirth' AND e ->> 'type' <> 'date')
         OR (s.slug = 'personal' AND e ->> 'name' = 'phone' AND e ->> 'type' <> 'phone')
         OR (s.slug = 'personal' AND e ->> 'name' IN ('firstName', 'lastName', 'address', 'city', 'postalCode')
             AND e ->> 'type' <> 'text')
   );
