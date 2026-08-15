-- Each document type declares its OWN upload slots.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── The bug ────────────────────────────────────────────────────────────────
--
-- Migration 0071 made the document choice a configured field, which fixed the
-- portal inventing three buttons. It left the uploads flat: the `document` step
-- always asked for a front AND a back, and the `address` step always asked for
-- "Primary Page" AND "Page 2".
--
-- Both are wrong for real documents. A passport is a single photo page — there
-- is no back to photograph. A utility bill is one page. Asking for a second is
-- a question with no answer, and the client either uploads a blank or gives up.
--
-- ── Why parts hang off the TYPE ────────────────────────────────────────────
--
-- Researched against Sumsub, Onfido, Persona, Veriff, Jumio, Stripe Identity
-- and Trulioo (Aug 2026). Every one models the side as an axis ORTHOGONAL to
-- the document type — Sumsub `idDocSubType`, Onfido `side`, Jumio "parts",
-- Persona's per-type front/back/barcode checkboxes. None encodes it in the type
-- enum; there is no `ID_CARD_FRONT` anywhere.
--
-- Only Sumsub and Jumio publish the requirement as API data. The other four
-- hard-code it inside their own widget — which is exactly why they ship a
-- widget at all, and exactly what this system cannot do, because the operator
-- defines the document types here.
--
-- A `parts` ARRAY rather than a `sides: 2` count, because a count cannot carry
-- a label: "Photo page" and "Back Side" are different questions and a UI handed
-- `2` has to invent both. `required` per part covers the genuinely optional
-- page — a tenancy agreement's second sheet — without a second mechanism.
UPDATE kyc_config_steps
   SET fields = (
     SELECT jsonb_agg(
       CASE
         WHEN field->>'name' = 'docType' THEN field || jsonb_build_object(
           'documentTypes', jsonb_build_array(
             jsonb_build_object(
               'value', 'passport',
               'label', 'Passport',
               -- ONE part. The whole reason for this migration.
               'parts', jsonb_build_array(
                 jsonb_build_object('key', 'front', 'label', 'Photo Page', 'required', true,
                   'hint', 'The page with your photo and details')
               )
             ),
             jsonb_build_object(
               'value', 'national_id',
               'label', 'National ID',
               'parts', jsonb_build_array(
                 jsonb_build_object('key', 'front', 'label', 'Front Side', 'required', true),
                 jsonb_build_object('key', 'back', 'label', 'Back Side', 'required', true)
               )
             ),
             jsonb_build_object(
               'value', 'driving_license',
               'label', 'Driving License',
               'parts', jsonb_build_array(
                 jsonb_build_object('key', 'front', 'label', 'Front Side', 'required', true),
                 jsonb_build_object('key', 'back', 'label', 'Back Side', 'required', true)
               )
             )
           )
         )
         ELSE field
       END
       ORDER BY ordinality
     )
       FROM jsonb_array_elements(fields) WITH ORDINALITY AS t(field, ordinality)
   )
 WHERE slug = 'document'
   AND fields @> '[{"name": "docType"}]'::jsonb;
--> statement-breakpoint

/*
 * PROOF OF ADDRESS, and the same correction.
 *
 * All three types asked for "Primary Page (Page 1)" and "Page 2 / Supporting
 * Document". A utility bill is one page and a bank statement is usually one —
 * only a tenancy agreement routinely runs to several, and even then the extra
 * sheets are supporting rather than required.
 */
UPDATE kyc_config_steps
   SET fields = (
     SELECT jsonb_agg(
       CASE
         WHEN field->>'name' = 'addressDocType' THEN field || jsonb_build_object(
           'documentTypes', jsonb_build_array(
             jsonb_build_object(
               'value', 'utility_bill',
               'label', 'Utility Bill',
               'parts', jsonb_build_array(
                 jsonb_build_object('key', 'front', 'label', 'The Bill', 'required', true,
                   'hint', 'Must show your name, address and a date in the last 3 months')
               )
             ),
             jsonb_build_object(
               'value', 'bank_statement',
               'label', 'Bank Statement',
               'parts', jsonb_build_array(
                 jsonb_build_object('key', 'front', 'label', 'The Statement', 'required', true,
                   'hint', 'Must show your name, address and a date in the last 3 months')
               )
             ),
             jsonb_build_object(
               'value', 'tenancy_agreement',
               'label', 'Tenancy Agreement',
               'parts', jsonb_build_array(
                 jsonb_build_object('key', 'front', 'label', 'Signature Page', 'required', true),
                 -- The one genuinely optional slot in the default config, and
                 -- the reason `required` lives per part rather than per type.
                 jsonb_build_object('key', 'back', 'label', 'Additional Page', 'required', false,
                   'hint', 'Only if your address is on a separate page')
               )
             )
           )
         )
         ELSE field
       END
       ORDER BY ordinality
     )
       FROM jsonb_array_elements(fields) WITH ORDINALITY AS t(field, ordinality)
   )
 WHERE slug = 'address'
   AND fields @> '[{"name": "addressDocType"}]'::jsonb;
--> statement-breakpoint

/*
 * The flat upload fields go: the parts above replace them.
 *
 * `doc_front`/`doc_back` and `address_proof`/`address_proof_2` were the fixed
 * pair this migration exists to remove. Leaving them would render every slot
 * twice — once from the parts and once from the leftover field.
 *
 * The STORED columns are untouched. `document.frontFilePath`, `backFilePath`,
 * `addressProof.filePath` and `page2FilePath` still hold what they always did;
 * this changes which slots are ASKED FOR, not where an upload lands.
 */
UPDATE kyc_config_steps
   SET fields = (
     SELECT COALESCE(jsonb_agg(field ORDER BY ordinality), '[]'::jsonb)
       FROM jsonb_array_elements(fields) WITH ORDINALITY AS t(field, ordinality)
      WHERE field->>'name' NOT IN ('doc_front', 'doc_back', 'address_proof', 'address_proof_2')
   )
 WHERE slug IN ('document', 'address');
