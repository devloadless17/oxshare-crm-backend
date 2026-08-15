-- Take the `review` step out of the configurable KYC flow.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── Why this one step is different ─────────────────────────────────────────
--
-- It was seeded as step 5 alongside `personal`, `document`, `selfie` and
-- `address`, so the builder treated it as an ordinary step: disable it, delete
-- it, drag it to position 2.
--
-- Each of those produces a broken flow rather than a different one. "Review &
-- Submit" is the screen carrying the button that submits the application, so
-- deleting it leaves onboarding with no way to finish, and moving it earlier
-- leaves a flow that submits before it has collected anything. The other four
-- steps ask for information and are genuinely the broker's choice — this one is
-- the flow's terminator.
--
-- The portal now appends it after whatever `/kyc/config` returns, so it is
-- always present and always last no matter what the builder holds. Leaving the
-- row in the table would mean the client saw TWO review screens.
--
-- ── Scoped to the seeded row ───────────────────────────────────────────────
--
-- `slug = 'review'` only. An operator who has since built their own step and
-- happened to call it something else keeps it; one who genuinely made a second
-- review step is having the duplicate removed, which is the intent.
DELETE FROM kyc_config_steps WHERE slug = 'review';
--> statement-breakpoint

-- Close the gap the delete leaves, so the remaining steps read 1..n rather than
-- skipping whatever position review held. `stepNumber` is positional and the
-- portal resolves steps by it, so a hole means an unreachable step.
WITH renumbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY step_number, id) AS position
    FROM kyc_config_steps
)
UPDATE kyc_config_steps AS s
   SET step_number = r.position
  FROM renumbered AS r
 WHERE s.id = r.id
   AND s.step_number IS DISTINCT FROM r.position;
