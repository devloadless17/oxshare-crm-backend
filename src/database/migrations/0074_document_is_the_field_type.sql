-- Each accepted document becomes its OWN field, typed as that document.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── The shape this arrives at, and the two it replaces ─────────────────────
--
-- A step that accepts three ways to prove identity is now three fields:
--
--   { name: 'passport',       type: 'doc:passport' }
--   { name: 'nationalId',     type: 'doc:national_id' }
--   { name: 'drivingLicense', type: 'doc:driving_license' }
--
-- The document IS the input type, the way `text` and `date` are, so the builder
-- reads the way the step reads to the client.
--
-- 0071/0072 had a `select` plus two `file` fields wired together: the operator
-- built three fields and the PORTAL held the knowledge of which select governed
-- which uploads, so a step assembled by hand could never work.
--
-- 0073 collapsed that to one `document` field with an `acceptedDocuments`
-- tick-list. Closer, but it buried the documents inside a field rather than
-- making them the thing being chosen — and "which documents does this step
-- take" was answerable only by opening the field.
--
-- ── Nothing about the catalogue is copied into the row ─────────────────────
--
-- The type is the only stored fact. Labels and upload slots resolve from
-- `common/kyc/document-catalogue.ts` on every read, so changing what a passport
-- requires updates every step that offers one with no migration.
UPDATE kyc_config_steps
   SET fields = jsonb_build_array(
         jsonb_build_object('id', 'f-doc-passport', 'name', 'passport',
           'label', 'Passport', 'type', 'doc:passport', 'required', false),
         jsonb_build_object('id', 'f-doc-national-id', 'name', 'nationalId',
           'label', 'National ID', 'type', 'doc:national_id', 'required', false),
         jsonb_build_object('id', 'f-doc-driving-license', 'name', 'drivingLicense',
           'label', 'Driving License', 'type', 'doc:driving_license', 'required', false)
       )
 WHERE slug = 'document';
--> statement-breakpoint

UPDATE kyc_config_steps
   SET fields = jsonb_build_array(
         jsonb_build_object('id', 'f-addr-utility', 'name', 'utilityBill',
           'label', 'Utility Bill', 'type', 'doc:utility_bill', 'required', false),
         jsonb_build_object('id', 'f-addr-bank', 'name', 'bankStatement',
           'label', 'Bank Statement', 'type', 'doc:bank_statement', 'required', false),
         jsonb_build_object('id', 'f-addr-tenancy', 'name', 'tenancyAgreement',
           'label', 'Tenancy Agreement', 'type', 'doc:tenancy_agreement', 'required', false)
       )
 WHERE slug = 'address';
--> statement-breakpoint

/*
 * ANY OTHER STEP carrying the 0073 shape, converted by RULE rather than slug.
 *
 * 0073 was live, so an operator may have built a step with a `document` field
 * and its own tick-list. Each accepted value becomes a field of that document's
 * type, so their configuration survives as the same set of choices.
 *
 * `required: false` throughout: these are ALTERNATIVES, and one of them is
 * enough. Marking each required would demand every client hold a passport AND a
 * national ID AND a licence.
 */
UPDATE kyc_config_steps AS s
   SET fields = (
     SELECT COALESCE(jsonb_agg(converted ORDER BY position), '[]'::jsonb)
       FROM (
         SELECT
           CASE
             WHEN f.field->>'type' = 'document' THEN
               jsonb_build_object(
                 'id', (f.field->>'id') || '-' || d.value,
                 'name', d.value,
                 'label', initcap(replace(d.value, '_', ' ')),
                 'type', 'doc:' || d.value,
                 'required', false
               )
             ELSE f.field
           END AS converted,
           f.ordinality AS position
           FROM jsonb_array_elements(s.fields) WITH ORDINALITY AS f(field, ordinality)
           LEFT JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN f.field->>'type' = 'document'
                  THEN COALESCE(f.field->'acceptedDocuments', '[]'::jsonb)
                  ELSE '[]'::jsonb END
           ) AS d(value) ON true
          -- A `document` field that accepted nothing produced no rows to the
          -- left join, and dropping it is right: it asked for nothing.
          WHERE f.field->>'type' <> 'document' OR d.value IS NOT NULL
       ) AS expanded
   )
 WHERE s.slug NOT IN ('document', 'address')
   AND s.fields @> '[{"type": "document"}]'::jsonb;
