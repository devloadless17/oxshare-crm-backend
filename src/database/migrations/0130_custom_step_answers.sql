-- Somewhere to put the answers a custom KYC step collects.
--
-- The builder has always been able to ADD a step — `addKycStep` exists, the
-- console offers it, and `kyc-config-round-trip.spec.ts` deliberately saves
-- steps slugged `other` and `audit` to prove id assignment works for steps
-- nobody named. What did not exist was anywhere to store what a client typed
-- into one: `KycService.saveStep` mapped the four canonical slugs to four
-- columns and refused everything else with `Unknown step`.
--
-- So a custom step rendered in the portal, accepted input, and failed the moment
-- the client pressed Continue — a capability the configuration screen offered
-- and the storage could not honour.
--
-- ## Why a map beside the four columns, not instead of them
--
-- `personal_info`, `document`, `selfie` and `address_proof` are read BY NAME
-- across the system: `personal_info.phone` and `.country` are promoted onto the
-- client record on approval, `document.front_file_path` gates submission, and
-- the reviewer's card is built from all four. Folding them into a generic map
-- would rewrite every one of those read paths to buy nothing — those four slugs
-- are not going anywhere. This is additive: no existing row changes meaning and
-- no existing query changes.
--
-- ## NOT NULL with a `{}` default
--
-- Every existing row reads as "no custom answers" rather than null, which is one
-- fewer branch in every consumer. The distinction between "this submission had
-- no custom steps" and "it had some and answered none" is not one anything in
-- the system needs to make, so it is not worth a nullable column to express.
--
-- Applied to the ATTEMPTS table too: a decision archives the submission that
-- produced it, and an archived attempt missing the custom answers would show a
-- reviewer a partial record of what they decided on.
ALTER TABLE "kyc_submissions"
  ADD COLUMN IF NOT EXISTS "step_data" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "kyc_submission_attempts"
  ADD COLUMN IF NOT EXISTS "step_data" jsonb DEFAULT '{}'::jsonb NOT NULL;
