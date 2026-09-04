-- ============================================================================
-- Commission and rebate are PER LOT, and nothing else
-- ============================================================================
--
-- `percent` and `share_of_parent` are retired from the levels form and refused
-- by the database. Every rung now names a flat amount per standard lot.
--
-- ── WHY `percent` HAD TO GO ─────────────────────────────────────────────────
--
-- It is a percentage of the BROKER'S REVENUE — MT5's charged commission plus
-- swap — and on a raw-spread group that figure is ZERO. So a rate card reading
-- "30%" paid nothing at all on a whole class of accounts, silently, because
-- 30% of nothing is a legitimate-looking zero.
--
-- That is not hypothetical: it is the live bug this deployment already hit,
-- where every closed trade was marked processed having paid nobody. The engine
-- was fixed to compute per-lot legs on zero revenue; this closes the door that
-- made the mistake configurable in the first place.
--
-- ── WHY `share_of_parent` GOES TOO, THOUGH IT WORKED ────────────────────────
--
-- It was sound arithmetic: 30% of the rung above's $10 resolved to $3 a lot,
-- and it kept a ladder proportional when the top rate was renegotiated.
--
-- It is removed on an explicit instruction, and the reason given is the right
-- one: with several sub-partner rungs, a rate you cannot read off the card
-- without resolving a chain upward is a rate an operator will eventually get
-- wrong. "$3.00 per lot" is checkable by looking at it. "30% of the level
-- above" is checkable only by opening another card — and by knowing that it
-- reads level N-1 rather than the next partner who actually earns, which is a
-- distinction nobody remembers under pressure.
--
-- The trade is stated plainly: raising level 1 from $10 to $12 no longer moves
-- level 2. Each rung is now edited on its own, deliberately.
--
-- ── EXISTING ROWS ARE CONVERTED, NOT REFUSED ────────────────────────────────
--
-- A `share_of_parent` rung is rewritten to the per-lot amount it was ALREADY
-- RESOLVING TO, so nobody's rate changes by a cent. This deployment's level 2
-- is 30% of level 1's $10.00 and becomes exactly $3.00.
--
-- ⚠️ ONE HOP ONLY. The resolver follows a chain of shares upward; this
-- converts a share of a PER-LOT parent. A share of a share is left for the
-- constraint to refuse, loudly, rather than converted by a recursive CTE
-- nobody would check — and no such row exists on any deployment: the shape has
-- existed for three migrations and level 2 is the only rung using it.
--
-- A `percent` rung would have no honest per-lot equivalent — the whole point is
-- that its base is a different number — so any that existed would fail the new
-- constraint and need a rate a person decides. None exist.
--
-- ⚠️ ACCRUALS ARE UNTOUCHED, and need no migration. `ib_accruals.rate_value`
-- has always stored the RESOLVED figure — verified on this database: all 108
-- share-priced rows carry `3.0000`, not `30`. History reads identically before
-- and after.
--
-- ⚠️ THE ENUM VALUES SURVIVE. `ib_payout_mode` keeps `percent` and
-- `share_of_parent`: Postgres cannot drop an enum label, and rewriting the type
-- would rewrite a column on a table whose rows priced real payouts. They become
-- values the database refuses to store rather than values it has never heard
-- of, which is also what keeps 0111 and 0114 readable.

BEGIN;

-- ── 1. Convert a share of a per-lot parent into that per-lot amount ─────────
--
-- No `pg_temp` helper: 0068 earned that warning and every migration since has
-- repeated it. The runner does not guarantee one session per migration, so a
-- factored-out function can vanish between its creation and the statements
-- using it — each of which then succeeds against zero rows rather than failing.
UPDATE ib_levels AS child
   SET commission_amount_per_lot =
         round(parent.commission_amount_per_lot * child.commission_rate / 100, 8),
       commission_rate = 0,
       commission_mode = 'per_lot'
  FROM ib_levels AS parent
 WHERE parent.level = child.level - 1
   AND child.commission_mode = 'share_of_parent'
   AND parent.commission_mode = 'per_lot'
   AND parent.commission_amount_per_lot IS NOT NULL;

UPDATE ib_levels AS child
   SET rebate_amount_per_lot =
         round(parent.rebate_amount_per_lot * child.rebate_rate / 100, 8),
       rebate_rate = 0,
       rebate_mode = 'per_lot'
  FROM ib_levels AS parent
 WHERE parent.level = child.level - 1
   AND child.rebate_mode = 'share_of_parent'
   AND parent.rebate_mode = 'per_lot'
   AND parent.rebate_amount_per_lot IS NOT NULL;

-- ── 1b. Any REMAINING non-per-lot rung becomes an explicit ZERO per lot ─────
--
-- 0112 seeds level 2 as `percent` with rate 0 and a NULL amount — a rung that
-- pays nothing until an operator configures it. A `percent` rung has no honest
-- per-lot equivalent in general, but one whose rate is ZERO has an obvious one:
-- it paid nothing before and pays nothing now.
--
-- A rung with a NON-ZERO percentage would be re-priced by this, so it is left
-- alone and the constraint below refuses it — loudly, at migrate time, where a
-- person can set the amount the broker actually agreed. Silently inventing a
-- per-lot figure from a percentage of a revenue this migration cannot see is
-- the one thing it must not do.
UPDATE ib_levels
   SET commission_mode = 'per_lot',
       commission_amount_per_lot = 0,
       commission_rate = 0
 WHERE commission_mode <> 'per_lot'
   AND COALESCE(commission_rate, 0) = 0;

UPDATE ib_levels
   SET rebate_mode = 'per_lot',
       rebate_amount_per_lot = 0,
       rebate_rate = 0
 WHERE rebate_mode <> 'per_lot'
   AND COALESCE(rebate_rate, 0) = 0;

-- ── 1c. The column DEFAULT was `percent`, which the CHECK below refuses ─────
--
-- An INSERT that names no mode would otherwise fail on a fresh database — which
-- is exactly how this migration first failed its own test suite.
ALTER TABLE ib_levels ALTER COLUMN commission_mode SET DEFAULT 'per_lot';
ALTER TABLE ib_levels ALTER COLUMN rebate_mode SET DEFAULT 'per_lot';

-- ── 2. Refuse anything but per_lot from here on ─────────────────────────────
--
-- ⚠️ `IS NOT NULL` beside `>= 0`, because a CHECK evaluating to NULL PASSES in
-- Postgres — `amount >= 0` alone accepts a per-lot rung with no amount at all.
-- The trap 0111 hit and 0114 documented.
ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_commission_shape;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_commission_shape CHECK (
    commission_mode = 'per_lot'
    AND commission_amount_per_lot IS NOT NULL
    AND commission_amount_per_lot >= 0
  );

ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_rebate_shape;
ALTER TABLE ib_levels
  ADD CONSTRAINT ib_levels_rebate_shape CHECK (
    rebate_mode = 'per_lot'
    AND rebate_amount_per_lot IS NOT NULL
    AND rebate_amount_per_lot >= 0
  );

-- ── 3. The percentage ceiling is now vacuous, and saying so beats leaving it ─
--
-- `ib_levels_share_fits` bounded commission + rebate to 100% while both were
-- shares of one revenue figure. Neither can be a percentage any more, so the
-- constraint can never fail — and a CHECK that cannot fail reads to the next
-- person as a protection that is in force.
--
-- The real ceiling on a per-lot rung is `ib_max_payout_per_lot`, enforced by
-- `checkPlausible` at ACCRUAL time, which is where a per-lot bound belongs: it
-- compares against the trade's volume, which no CHECK on this table can see.
ALTER TABLE ib_levels DROP CONSTRAINT IF EXISTS ib_levels_share_fits;

COMMIT;
