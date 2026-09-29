-- ============================================================================
-- State / Province, a new identity detail (owner, 28 Sep 2026)
-- ============================================================================
--
-- The owner's list of what tells who a client is ends with "State": a free-text,
-- optional detail, like the postal code. It lives where every other identity
-- detail lives since 0139 — on `users` — and is written only through the
-- profile writer.
--
-- The column is `state_province`, not `state`: `transactions.state` and
-- `transfers.state` exist, and an unqualified `state` in a joined raw query
-- would read the wrong table without an error.
--
-- Every step below is safe to run twice.

ALTER TABLE users ADD COLUMN IF NOT EXISTS state_province varchar(100);

-- ── A broker's own question can no longer MEAN it ───────────────────────────
--
-- From now on the platform asks for the state itself, so a custom question
-- labelled "State", "Province" or "Region" would be a second copy of it — the
-- class 0139 and 0147 removed for the other details. Such a question is folded
-- in the 0139 way: its answers are copied onto EMPTY profiles (a value already
-- on the profile wins), the question leaves the form, and one audit row lists
-- what went. The answers themselves stay in the submissions, and the question's
-- name stays in `kyc_field_labels` (0148), so no record loses anything.
--
-- A custom field KEYED `stateProvince` (only a hand-crafted save could make one;
-- the builder generates `customField_*` keys) would now be read as the profile
-- detail. It is re-keyed first, with its answers, flags and name.

DO $$
DECLARE
  step record;
  field jsonb;
  renamed text := 'customField_state_province_0150';
  removed jsonb := '[]'::jsonb;
  kept jsonb;
  spelling text;
BEGIN
  -- 1. The re-key.
  IF EXISTS (
    SELECT 1 FROM kyc_config_steps s, jsonb_array_elements(s.fields) f
     WHERE f->>'name' = 'stateProvince'
  ) THEN
    UPDATE kyc_config_steps s
       SET fields = (
             SELECT jsonb_agg(
                      CASE WHEN f->>'name' = 'stateProvince'
                           THEN jsonb_set(f, '{name}', to_jsonb(renamed))
                           ELSE f END
                      ORDER BY ord)
               FROM jsonb_array_elements(s.fields) WITH ORDINALITY AS t(f, ord))
     WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(s.fields) f
                    WHERE f->>'name' = 'stateProvince');

    UPDATE kyc_submissions
       SET personal_info = (personal_info - 'stateProvince')
                           || jsonb_build_object(renamed, personal_info->'stateProvince')
     WHERE personal_info ? 'stateProvince';

    UPDATE kyc_submissions k
       SET step_data = (
             SELECT jsonb_object_agg(
                      slug,
                      CASE WHEN answers ? 'stateProvince'
                           THEN (answers - 'stateProvince')
                                || jsonb_build_object(renamed, answers->'stateProvince')
                           ELSE answers END)
               FROM jsonb_each(k.step_data) AS e(slug, answers))
     WHERE EXISTS (SELECT 1 FROM jsonb_each(k.step_data) e(slug, answers)
                    WHERE jsonb_typeof(answers) = 'object' AND answers ? 'stateProvince');

    UPDATE kyc_submissions
       SET rejected_fields = (
             SELECT jsonb_agg(CASE WHEN x = 'stateProvince' THEN renamed ELSE x END)
               FROM jsonb_array_elements_text(rejected_fields) AS x)
     WHERE rejected_fields ? 'stateProvince';

    UPDATE kyc_field_labels SET name = renamed
     WHERE name = 'stateProvince'
       AND NOT EXISTS (SELECT 1 FROM kyc_field_labels WHERE name = renamed);
  END IF;

  -- 2. Fold in every question whose label means the state.
  FOR step IN SELECT id, slug, fields FROM kyc_config_steps LOOP
    kept := '[]'::jsonb;
    FOR field IN SELECT f FROM jsonb_array_elements(step.fields) AS t(f) LOOP
      spelling := regexp_replace(lower(coalesce(field->>'label', '')), '[^a-z0-9]', '', 'g');
      IF spelling IN ('state', 'province', 'stateprovince', 'stateorprovince', 'region', 'county')
         AND field->>'name' IS NOT NULL
         AND coalesce(field->>'type', 'text') NOT LIKE 'doc:%'
         AND coalesce(field->>'type', 'text') NOT IN ('file', 'camera') THEN
        -- Its answers onto EMPTY profiles — never over a value already there.
        UPDATE users u
           SET state_province = left(btrim(a.answer), 100)
          FROM (
                SELECT k.user_id,
                       CASE WHEN step.slug = 'personal'
                            THEN k.personal_info->>(field->>'name')
                            ELSE k.step_data->step.slug->>(field->>'name') END AS answer
                  FROM kyc_submissions k
               ) a
         WHERE a.user_id = u.id
           AND u.state_province IS NULL
           AND a.answer IS NOT NULL
           AND btrim(a.answer) <> '';
        removed := removed || jsonb_build_object(
          'step', step.slug, 'name', field->>'name', 'label', field->>'label');
      ELSE
        kept := kept || jsonb_build_array(field);
      END IF;
    END LOOP;
    IF jsonb_array_length(kept) <> jsonb_array_length(step.fields) THEN
      UPDATE kyc_config_steps SET fields = kept WHERE id = step.id;
    END IF;
  END LOOP;

  IF jsonb_array_length(removed) > 0 THEN
    INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id, details)
    VALUES ('00000000-0000-0000-0000-000000000000', 'system@oxshare.internal', 'system',
            'kyc_config.consolidated', 'kyc_config', 'steps',
            jsonb_build_object(
              'changes', removed,
              'why', 'The platform asks for State / Province itself (0150); a question meaning it '
                     || 'would be a second copy. Answers were copied onto empty profiles.'));
  END IF;
END $$;

-- ── Hidden wherever the street address is hidden ────────────────────────────
--
-- Field masks are a DENY-list (RBAC-03), so a new detail is visible to every
-- role until somebody hides it. A role that already hides the street address
-- hides part of where the client lives; the state is the same fact at a coarser
-- grain, so it is hidden there too rather than left showing by omission.

UPDATE roles
   SET masked_fields = masked_fields || '["client.stateProvince"]'::jsonb
 WHERE masked_fields ? 'client.address'
   AND NOT masked_fields ? 'client.stateProvince';
UPDATE admins
   SET masked_fields = masked_fields || '["client.stateProvince"]'::jsonb
 WHERE masked_fields IS NOT NULL
   AND masked_fields ? 'client.address'
   AND NOT masked_fields ? 'client.stateProvince';
UPDATE admin_invites
   SET masked_fields = masked_fields || '["client.stateProvince"]'::jsonb
 WHERE masked_fields IS NOT NULL
   AND masked_fields ? 'client.address'
   AND NOT masked_fields ? 'client.stateProvince';
