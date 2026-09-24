-- 0137 · A catalogue document only on the step that holds its kind.
--
-- The builder offered every catalogue document — passport, national ID, utility
-- bill… — as a field type on EVERY step. Only two steps can hold one: the
-- identity step and the proof-of-address step, which store a document with its
-- type and every page in typed columns. Anywhere else a document had no real
-- home — the pages of a national ID shared one upload slot, and "required" on
-- several cards meant all of them to the server and one of them to the client
-- (reported from local testing, 25 Sep 2026). `kyc-config-integrity.ts`
-- (`assertFieldsFitTheirStep`) now refuses them on every save; this converts
-- the ones already configured:
--
--   ANY OTHER STEP        each document becomes one FILE field per page, which
--   (added, personal,     is how any step collects a file:
--   selfie)                 · page 1 keeps the field's id and key, so every
--                             upload made so far stays attached to its field;
--                           · each later page is keyed `<key>__<page>`, the key a
--                             later page was uploaded under while documents were
--                             briefly paged on added steps;
--                           · labels name the page ("National ID — Back Side")
--                             when there is more than one; `required` is the
--                             field's AND the page's, so a tenancy agreement's
--                             optional second sheet stays optional.
--                         A `doc:` value the catalogue no longer knows becomes a
--                         single File field.
--   document · address    a document of the OTHER kind is removed: its pages were
--                         filed by category, so a utility bill offered on the
--                         identity step was filed as the client's proof of
--                         address. One the catalogue no longer knows is kept, as
--                         the rule tolerates it.
--
-- EVERY OTHER FIELD IS UNTOUCHED. Text, date, phone, dropdown, checkbox, File and
-- Camera fields are valid on every step — a built-in step's extra fields keep
-- their answers in `step_data` under its slug. Nothing stored is lost: files stay
-- where they are, under the same keys, or in the document columns.
--
-- The catalogue is copied below AS IT STANDS TODAY, deliberately: a migration is
-- a snapshot, and one that read a list which later changed would convert
-- differently on every database it met.
--
-- Re-runnable: a second run finds nothing to convert and changes no step.
WITH catalogue (value, document_label, category, page, part_key, part_label, part_required, part_hint) AS (
	VALUES
		('passport', 'Passport', 'identity', 0, 'front', 'Photo Page', true, 'The page with your photo and details'),
		('national_id', 'National ID', 'identity', 0, 'front', 'Front Side', true, NULL),
		('national_id', 'National ID', 'identity', 1, 'back', 'Back Side', true, NULL),
		('driving_license', 'Driving License', 'identity', 0, 'front', 'Front Side', true, NULL),
		('driving_license', 'Driving License', 'identity', 1, 'back', 'Back Side', true, NULL),
		('residence_permit', 'Residence Permit', 'identity', 0, 'front', 'Front Side', true, NULL),
		('residence_permit', 'Residence Permit', 'identity', 1, 'back', 'Back Side', true, NULL),
		('utility_bill', 'Utility Bill', 'address', 0, 'front', 'The Bill', true, 'Must show your name, address and a date in the last 3 months'),
		('bank_statement', 'Bank Statement', 'address', 0, 'front', 'The Statement', true, 'Must show your name, address and a date in the last 3 months'),
		('tenancy_agreement', 'Tenancy Agreement', 'address', 0, 'front', 'Signature Page', true, NULL),
		('tenancy_agreement', 'Tenancy Agreement', 'address', 1, 'back', 'Additional Page', false, 'Only if your address is on a separate page')
),
documents AS (
	SELECT value, min(category) AS category, count(*) AS pages FROM catalogue GROUP BY value
),
field AS (
	SELECT
		s."id" AS step_id,
		s."slug" AS slug,
		f.ord,
		f.value AS original,
		coalesce(f.value ->> 'type', '') AS type,
		CASE WHEN f.value ->> 'type' LIKE 'doc:%' THEN substr(f.value ->> 'type', 5) END AS document
	FROM "kyc_config_steps" AS s
	CROSS JOIN LATERAL jsonb_array_elements(s."fields") WITH ORDINALITY AS f(value, ord)
	WHERE jsonb_typeof(s."fields") = 'array'
),
kept AS (
	-- Not a document: unchanged, on every step.
	SELECT step_id, ord, 0 AS page, original AS value
	FROM field
	WHERE document IS NULL

	UNION ALL

	-- Outside the document steps, a document the catalogue knows: one File field per page.
	SELECT
		field.step_id,
		field.ord,
		c.page,
		jsonb_strip_nulls(jsonb_build_object(
			'id', CASE
				WHEN c.page = 0 THEN coalesce(field.original ->> 'id', field.original ->> 'name')
				ELSE coalesce(field.original ->> 'id', field.original ->> 'name') || '-' || c.part_key
			END,
			'name', CASE
				WHEN c.page = 0 THEN field.original ->> 'name'
				ELSE (field.original ->> 'name') || '__' || c.part_key
			END,
			'label', CASE
				WHEN d.pages > 1
					THEN coalesce(nullif(field.original ->> 'label', ''), c.document_label) || ' — ' || c.part_label
				ELSE coalesce(nullif(field.original ->> 'label', ''), c.document_label)
			END,
			'type', 'file',
			'required', coalesce((field.original ->> 'required')::boolean, false) AND c.part_required,
			'hint', CASE
				WHEN c.page = 0 THEN coalesce(nullif(field.original ->> 'hint', ''), c.part_hint)
				ELSE c.part_hint
			END
		))
	FROM field
	JOIN catalogue AS c ON c.value = field.document
	JOIN documents AS d ON d.value = field.document
	WHERE field.slug NOT IN ('document', 'address')

	UNION ALL

	-- Outside the document steps, a document the catalogue no longer knows: one File field.
	SELECT step_id, ord, 0, (original - 'options') || '{"type": "file"}'::jsonb
	FROM field
	WHERE slug NOT IN ('document', 'address')
		AND document IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM documents AS d WHERE d.value = field.document)

	UNION ALL

	-- On a document step: documents of its own kind, or no longer catalogued.
	SELECT field.step_id, field.ord, 0, field.original
	FROM field
	LEFT JOIN documents AS d ON d.value = field.document
	WHERE field.slug IN ('document', 'address')
		AND field.document IS NOT NULL
		AND (d.value IS NULL OR d.category = CASE field.slug WHEN 'document' THEN 'identity' ELSE 'address' END)
),
rebuilt AS (
	SELECT
		s."id" AS step_id,
		coalesce(
			(SELECT jsonb_agg(k.value ORDER BY k.ord, k.page) FROM kept AS k WHERE k.step_id = s."id"),
			'[]'::jsonb
		) AS fields
	FROM "kyc_config_steps" AS s
	WHERE jsonb_typeof(s."fields") = 'array'
)
UPDATE "kyc_config_steps" AS s
SET "fields" = rebuilt.fields
FROM rebuilt
WHERE s."id" = rebuilt.step_id
	AND s."fields" IS DISTINCT FROM rebuilt.fields;
