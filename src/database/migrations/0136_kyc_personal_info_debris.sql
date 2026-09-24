-- 0136 · Take the portal's form debris out of `kyc_submissions.personal_info`.
--
-- The portal's review screen re-posted its WHOLE form as the personal step on
-- submit, and `saveStep` merged whatever it was given. So `personal_info` came
-- to hold three things that were never personal details, and the reviewer read
-- them beside the client's name — "Doc Choice Document", "Custom Field
-- 1790263652846: [object Object]" (reported from production, 24 Sep 2026):
--
--   · `__docChoice__<step>` — the wizard's own note of which document card was
--     picked. UI state; the document's type is stored with the document.
--   · the string "[object Object]" — an uploaded file's record, stringified by
--     the form. The file itself is stored where it belongs.
--   · a custom step's answers under their builder keys — COPIES. Each custom
--     step saved its own answers into `step_data` when the client pressed
--     Continue, and that is where they are read from.
--
-- `saveStep` now stores only the fields a step's configuration names, as
-- strings (`kyc-answers.ts`), so no new row can collect any of this. This
-- removes what is already there. Nothing removed is information: the first is
-- UI state, the second is garbage, the third exists in `step_data`.
--
-- A structured value (object or array) goes too: no personal field is one, and
-- the only way one got in was the same merge. Numbers and booleans are kept —
-- they are odd, but they are somebody's answer.
--
-- ARCHIVED ATTEMPTS ARE NOT TOUCHED. `kyc_submission_attempts` is the record of
-- what a decision was made on, and rewriting it — even to tidy it — would make
-- that record something other than what the reviewer saw. The review screens
-- hide the same three shapes when they render one.
--
-- Re-runnable: a second run finds nothing to change.
UPDATE "kyc_submissions" AS k
SET "personal_info" = cleaned.info,
	"updated_at" = now()
FROM (
	SELECT
		s."user_id",
		COALESCE(
			jsonb_object_agg(e.key, e.value) FILTER (
				WHERE left(e.key, 2) <> '__'
					AND jsonb_typeof(e.value) NOT IN ('object', 'array')
					AND e.value <> '"[object Object]"'::jsonb
					AND NOT EXISTS (
						SELECT 1
						FROM jsonb_each(s."step_data") AS sd(slug, answers)
						WHERE jsonb_typeof(sd.answers) = 'object' AND sd.answers ? e.key
					)
			),
			'{}'::jsonb
		) AS info
	FROM "kyc_submissions" AS s
	CROSS JOIN LATERAL jsonb_each(s."personal_info") AS e(key, value)
	WHERE jsonb_typeof(s."personal_info") = 'object'
	GROUP BY s."user_id"
) AS cleaned
WHERE k."user_id" = cleaned."user_id"
	AND k."personal_info" IS DISTINCT FROM cleaned.info;
