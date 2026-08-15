-- Make the document-type choice a CONFIGURED field rather than portal markup.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── What was wrong ─────────────────────────────────────────────────────────
--
-- The `document` step is configured with two fields — "Front Side" and "Back
-- Side", both file uploads — and the portal rendered three buttons above them
-- (Passport / National ID / Driving licence) that exist nowhere in this table.
-- Picking "Passport" then replaced BOTH configured fields with a single
-- hard-coded uploader.
--
-- So the builder said one thing and the client saw another. An operator adding
-- a field to that step saw nothing change for passport holders, and one who
-- wanted a fourth document type had no way to add it — the list was three
-- literals in `dynamic-step-renderer.tsx`. The same applied to the `address`
-- step's utility-bill/bank-statement/tenancy cards.
--
-- ── The fix: the choice is a `select` field like any other ─────────────────
--
-- `docType` becomes a real field on the step, with its options in this table.
-- The portal renders whatever options it finds and hides uploads the choice
-- does not need. Adding a document type is now an edit in the KYC builder.
--
-- The stored VALUES are unchanged — `document.docType` is already
-- 'passport' | 'national_id' | 'driving_license' in a free-form jsonb column,
-- and `kyc.service.ts` still reads exactly that. This adds the field that lets
-- a client choose it, rather than changing what a choice means.
--
-- ── Prepended, not appended ────────────────────────────────────────────────
--
-- The type governs which uploads apply, so it has to be answered first. The
-- portal renders fields in array order, so position IS the order.
UPDATE kyc_config_steps
   SET fields = jsonb_build_array(
         jsonb_build_object(
           'id', 'f-doctype',
           'name', 'docType',
           'label', 'Document Type',
           'type', 'select',
           'required', true,
           'hint', 'Choose what you are uploading',
           'options', jsonb_build_array('Passport', 'National ID', 'Driving License')
         )
       ) || fields
 WHERE slug = 'document'
   -- Re-runnable, and safe against an operator who has already added their own.
   AND NOT (fields @> '[{"name": "docType"}]'::jsonb);
--> statement-breakpoint

-- Same for proof of address, whose three cards were hard-coded the same way.
UPDATE kyc_config_steps
   SET fields = jsonb_build_array(
         jsonb_build_object(
           'id', 'f-addrtype',
           'name', 'addressDocType',
           'label', 'Proof Type',
           'type', 'select',
           'required', true,
           'hint', 'Choose what you are uploading',
           'options', jsonb_build_array('Utility Bill', 'Bank Statement', 'Tenancy Agreement')
         )
       ) || fields
 WHERE slug = 'address'
   AND NOT (fields @> '[{"name": "addressDocType"}]'::jsonb);
