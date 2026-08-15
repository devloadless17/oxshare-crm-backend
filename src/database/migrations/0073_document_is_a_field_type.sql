-- One `document` field replaces the select-plus-file-fields pairing.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── What this supersedes ───────────────────────────────────────────────────
--
-- 0071 made the document choice a `select`, and 0072 hung per-type upload parts
-- off it. Both were improvements and both stopped short: the step still held a
-- select and the portal still had to know that THIS select governs THOSE
-- uploads. That knowledge lived in code, so a document step an operator built
-- themselves could never work — the wiring only existed for the seeded slugs.
--
-- `document` is now a field TYPE. One field is the picker and its slots
-- together, and it names which catalogue entries it accepts. Nothing in the
-- portal needs to know what a passport is.
--
-- ── The catalogue is not copied into the row ───────────────────────────────
--
-- `acceptedDocuments` stores VALUES only — `["passport","national_id"]`. The
-- labels and upload parts are resolved from `document-catalogue.ts` on every
-- read, so changing what a passport requires updates every step that accepts
-- one without a migration. Storing the resolved shape would have created a
-- second copy that drifts.
UPDATE kyc_config_steps
   SET fields = jsonb_build_array(
         jsonb_build_object(
           'id', 'f-identity-doc',
           'name', 'identityDocument',
           'label', 'Identity Document',
           'type', 'document',
           'required', true,
           'acceptedDocuments', jsonb_build_array('passport', 'national_id', 'driving_license')
         )
       )
 WHERE slug = 'document';
--> statement-breakpoint

UPDATE kyc_config_steps
   SET fields = jsonb_build_array(
         jsonb_build_object(
           'id', 'f-address-doc',
           'name', 'addressDocument',
           'label', 'Proof of Address',
           'type', 'document',
           'required', true,
           'acceptedDocuments', jsonb_build_array('utility_bill', 'bank_statement', 'tenancy_agreement')
         )
       )
 WHERE slug = 'address';
--> statement-breakpoint

/*
 * ANY OTHER STEP an operator built with the intermediate shape.
 *
 * 0071 and 0072 were live, so a step created between them and now may carry a
 * select with `documentTypes` on it. Converting by rule rather than by slug:
 * a select that has resolved document types becomes a `document` field
 * accepting the same values.
 *
 * Written before the flat upload fields are dropped below, so the `WHERE` still
 * sees the shape it is matching on.
 */
UPDATE kyc_config_steps
   SET fields = (
     SELECT jsonb_agg(
       CASE
         WHEN field->>'type' = 'select' AND field ? 'documentTypes' THEN
           (field - 'documentTypes' - 'options')
             || jsonb_build_object(
                  'type', 'document',
                  'acceptedDocuments', (
                    SELECT COALESCE(jsonb_agg(dt->>'value'), '[]'::jsonb)
                      FROM jsonb_array_elements(field->'documentTypes') dt
                  )
                )
         ELSE field
       END
       ORDER BY ordinality
     )
       FROM jsonb_array_elements(fields) WITH ORDINALITY AS t(field, ordinality)
   )
 WHERE fields @> '[{"type": "select"}]'::jsonb
   AND slug NOT IN ('document', 'address');
--> statement-breakpoint

/*
 * The leftover flat uploads go.
 *
 * `doc_front`/`doc_back`/`address_proof`/`address_proof_2` were the fixed pair
 * this whole line of work removes. A `document` field renders its own slots, so
 * leaving these would draw every upload twice.
 *
 * The STORED columns are untouched — `document.frontFilePath`,
 * `addressProof.page2FilePath` and the rest still hold what they always did.
 * This changes which slots are ASKED FOR, never where an upload lands.
 */
UPDATE kyc_config_steps
   SET fields = (
     SELECT COALESCE(jsonb_agg(field ORDER BY ordinality), '[]'::jsonb)
       FROM jsonb_array_elements(fields) WITH ORDINALITY AS t(field, ordinality)
      WHERE field->>'name' NOT IN ('doc_front', 'doc_back', 'address_proof', 'address_proof_2')
   )
 WHERE fields @> '[{"type": "file"}]'::jsonb;
