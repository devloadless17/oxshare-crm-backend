-- ============================================================================
-- Adopt the orphaned sub-partners, and put them back on their rung
-- ============================================================================
--
-- Every partner approved through the console landed at the ROOT on level 1,
-- whoever recruited them. `AdminIbController.approve` coalesced an omitted
-- `parentIbUserId` to null, and to the service null is an explicit "root
-- them" — so the introducer inheritance `inheritedParentIbUserIdFor` exists
-- for never ran on a single console approval. The controller is fixed in the
-- same change; this repairs the rows the bug already wrote.
--
-- What the bad rows did while they stood: the network tab showed every
-- partner as a flat level-1 root with nobody above or beneath them, upline
-- partners earned NOTHING on their downline's clients (resolveChain walks
-- parent edges that did not exist), and the two-level ceiling was
-- unenforceable — a client under a mislabeled "level-1" partner had rung 2
-- free by arithmetic, which is how a third partner in a row got approved.
--
-- ── STATEMENT 1: the tree edge, restored from attribution ───────────────────
--
-- Only accounts that are currently ROOTS whose owner was introduced by a
-- partner. `users.referred_by_ib_user_id` is written once at registration,
-- carries a foreign key onto ib_accounts, and is the exact fact the approve
-- inheritance would have recorded. Attribution cannot be cyclic — a referral
-- code exists only after its owner is a partner, so the edges are ordered by
-- time — and a reviewer-CHOSEN parent (non-null) is left exactly as chosen.
--
-- The one shape knowingly folded in: a partner somebody deliberately rooted
-- by sending an explicit null through the API by hand. The console never
-- offered that choice, so through the UI no such row can exist; if one was
-- crafted, re-rooting is one click on the profile's reassign control.
--
-- ── STATEMENT 2: the level, re-derived — by the bug's own signature ─────────
--
-- Approval never writes level 1 beneath a parent (a recruited partner is
-- always one below their recruiter), so `level = 1 AND parent IS NOT NULL`
-- identifies the damaged rows without touching levels an operator set
-- deliberately through changeLevel — those are not 1, or not nested. Levels
-- are recomputed as root.level + depth along the repaired edges, so a chain
-- of repaired rows comes out 1, 2, 3 rather than 1, 2, 2.
--
-- A repaired partner can land PAST the configured ladder (the third-in-a-row
-- partner the bug approved becomes level 3 on a two-rung ladder). That is
-- deliberate: they earn nothing there and the console says so by name, which
-- puts a decision in front of an operator — change their level, re-root them,
-- or extend the ladder — instead of leaving a rung recorded that the tree
-- does not describe. The walk is bounded at 32 hops so pre-existing cyclic
-- data (which Postgres cannot prevent) fails loudly by exhaustion rather
-- than hanging the migration, and the stored level is capped at the
-- structural 10 the column's CHECK enforces.
--
-- Idempotent by construction: statement 1 matches only parentless rows,
-- statement 2 only level-1-with-parent rows, so a re-run changes nothing.

UPDATE ib_accounts a
   SET parent_ib_user_id = u.referred_by_ib_user_id
  FROM users u
 WHERE u.id = a.user_id
   AND a.parent_ib_user_id IS NULL
   AND u.referred_by_ib_user_id IS NOT NULL
   AND u.referred_by_ib_user_id <> a.user_id;
--> statement-breakpoint
WITH RECURSIVE chain AS (
  SELECT user_id, level AS derived, 0 AS depth
    FROM ib_accounts
   WHERE parent_ib_user_id IS NULL
  UNION ALL
  SELECT a.user_id, LEAST(chain.derived + 1, 10), chain.depth + 1
    FROM ib_accounts a
    JOIN chain ON a.parent_ib_user_id = chain.user_id
   WHERE chain.depth < 32
)
UPDATE ib_accounts a
   SET level = chain.derived
  FROM chain
 WHERE a.user_id = chain.user_id
   AND a.parent_ib_user_id IS NOT NULL
   AND a.level = 1
   AND a.level <> chain.derived;
