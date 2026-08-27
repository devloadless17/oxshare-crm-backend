-- ─────────────────────────────────────────────────────────────────────────────
-- An agency carries the commission programme its partners are appointed on.
--
-- ## The problem this solves
--
-- A reviewer approving a partner picks their programme from the whole
-- catalogue, and the fallback when they express no preference is the
-- lowest-sorted enabled one. That is the same answer for every applicant,
-- whichever agency they applied to — so a broker running a Gold agency and a
-- Standard agency had to remember which terms went with which, on every
-- approval, with nothing on the screen to remind them and nothing to catch a
-- mistake afterwards.
--
-- The agency ALREADY decides what a partner may sell: `agency_products` bounds
-- their book, and `inheritedAgencyIdFor` puts a sub-partner in the same agency
-- as the introducer who recruited them. What a partner is PAID is the one term
-- of that package that lived somewhere else.
--
-- ## It is a DEFAULT, not an assignment
--
-- Resolution at approval becomes:
--
--   1. the programme the reviewer explicitly picked   — always wins
--   2. the applicant's agency's `default_program_id`  — this column
--   3. the lowest-sorted ENABLED programme            — unchanged fallback
--
-- The reviewer keeps the final say, because a negotiated partner inside an
-- ordinary agency is a real case and cloning the agency to express it would
-- make the catalogue grow one row per negotiation.
--
-- ## `ON DELETE SET NULL`, and why not `restrict`
--
-- `ib_accounts.program_id` is `restrict` — a programme somebody is being PAID by
-- cannot be deleted, because their earnings reference it. This is a different
-- claim: a default is a suggestion for approvals that have not happened yet, so
-- losing it costs the next reviewer a click and costs nobody money. Making it
-- `restrict` would let a decoration block an administrative delete.
--
-- NULL is therefore a real, ordinary state: "this agency expresses no
-- preference", which is what every agency says until somebody sets one. It is
-- also what the column falls back to if the programme is later removed, and
-- step 3 above covers it.
--
-- ## Nothing is backfilled
--
-- Every existing agency starts at NULL rather than being pointed at the current
-- default. Writing a value nobody chose is how a default becomes a decision
-- somebody has to discover they made — and the behaviour at NULL is exactly the
-- behaviour before this migration, so no approval changes until an operator
-- sets one deliberately.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "agencies"
  ADD COLUMN IF NOT EXISTS "default_program_id" uuid;
--> statement-breakpoint

ALTER TABLE "agencies" DROP CONSTRAINT IF EXISTS "agencies_default_program_id_ib_programs_id_fk";
--> statement-breakpoint

ALTER TABLE "agencies"
  ADD CONSTRAINT "agencies_default_program_id_ib_programs_id_fk"
  FOREIGN KEY ("default_program_id") REFERENCES "ib_programs"("id") ON DELETE SET NULL;
