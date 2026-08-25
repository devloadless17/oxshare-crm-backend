-- FR-IB-04 / FR-IB-16: WHICH of the broker's earnings a partner is paid on.
--
-- Hand-written, like every migration from 0027 on: the committed drizzle
-- snapshots stop at 0026, so `drizzle-kit generate` would diff against a stale
-- baseline and prompt to rename a dozen unrelated enums.
--
-- ── The deliverable this closes ────────────────────────────────────────────
--
-- The FSD says commission is "spread-based" (FR-IB-04) and that the agreed
-- spread mathematics is "documented and configured" through the programme
-- catalogue (FR-IB-16). What ships is `commission + swap`, and that was not an
-- oversight — MT5 reports no per-deal spread revenue, so there is neither a
-- figure to compute from nor a figure to check a result against. Both
-- `broker-revenue.ts` and migration 0095 say the same thing in different words:
-- wiring the product's markup into the base "changes what every partner is paid
-- on every future trade", and THAT NEEDS A PERSON, NOT A COLUMN.
--
-- So the gap between the specification and the system was never really missing
-- arithmetic. It was that the arithmetic had no owner: the one number deciding
-- what a partner earns was a constant in a source file, reachable only by
-- whoever could open a pull request, changeable only by deploy, and invisible to
-- everybody actually running the platform.
--
-- This column is the owner. It does not decide the answer — it makes the answer
-- SAYABLE, by somebody accountable, recorded with both sides by
-- `SettingsService`, on the same form as the settlement window and the backlog
-- decision. Which is what FR-IB-16's acceptance criterion turns on: the agreed
-- method has to be documented and CONFIGURED, not hardcoded.
--
-- ── The three values ───────────────────────────────────────────────────────
--
--   'commission_swap'         what MT5 says the broker charged. WHAT SHIPS.
--   'spread'                  lots x trading_products.spread_markup_per_lot
--   'commission_swap_spread'  both, summed — everything the broker earned
--
-- ── DEFAULT 'commission_swap', and why that is not a cop-out ───────────────
--
-- A new setting whose default changes behaviour is a silent repricing wearing a
-- migration's clothes. Every existing deployment must keep paying exactly what
-- it paid yesterday until a person chooses otherwise — and then the audit row
-- names them, the moment, and both sides of the change. The DEFAULT is the
-- status quo precisely so that choosing is an act rather than an accident.
--
-- ── The sharp edge, stated here because it has a date on it ────────────────
--
-- Like `ib_accrual_start`, this decides only deals NOT YET DECIDED. A deal a run
-- has already looked at carries `commission_processed_at` and is never
-- revisited, so changing this later re-prices the future and nothing else.
--
-- The specific trap: under 'spread' alone, a product whose markup is 0 — legal,
-- and correct for a raw-spread product — yields zero revenue, and a zero-revenue
-- deal is MARKED DONE rather than retried, because MT5's amounts are final the
-- moment they are reported. Setting the basis to 'spread' before the markups are
-- populated therefore burns through the queue paying nothing, permanently. Fill
-- in the product markups first; the settings form says so where the person
-- likely to do it in the wrong order will be standing.
--
-- Idempotent, so it is re-runnable if renumbered — see the renumber trap in
-- CLAUDE.md for why that matters more here than it looks.
ALTER TABLE trading_settings
  ADD COLUMN IF NOT EXISTS ib_revenue_basis varchar(30) NOT NULL DEFAULT 'commission_swap';

-- The set is closed at the database as well as at the DTO. The DTO is where a
-- typo gets a readable message; this is what holds against a writer that never
-- sees one — a psql session, a fixture, a future admin script. A basis nobody
-- implemented would fall back to 'commission_swap' in `revenueBasisOf` rather
-- than crash, which is the safe reading at runtime and exactly why the value
-- must not be storable in the first place: a fallback that works is a fallback
-- nobody notices.
--
-- DROP-then-ADD so the file is re-runnable, matching 0091 and 0095.
ALTER TABLE trading_settings
  DROP CONSTRAINT IF EXISTS trading_settings_revenue_basis_ck;

ALTER TABLE trading_settings
  ADD CONSTRAINT trading_settings_revenue_basis_ck
  CHECK (ib_revenue_basis IN ('commission_swap', 'spread', 'commission_swap_spread'));

COMMENT ON COLUMN trading_settings.ib_revenue_basis IS
  'Which of the broker''s earnings a partner''s rate applies to. ''commission_swap'' (default, and '
  'what the platform shipped on) is MT5''s charged commission + swap; ''spread'' is lots x the '
  'product''s spread_markup_per_lot; ''commission_swap_spread'' is both. Changing this re-prices '
  'every FUTURE trade and nothing already decided. Populate product markups BEFORE selecting a '
  'spread-inclusive basis — see migration 0101.';

-- ── The other half: the markup stops being inert ───────────────────────────
--
-- Migration 0095 wrote a deliberate warning into this column's comment: nothing
-- reads it, it is NOT part of brokerRevenueOf, and the failure being guarded was
-- somebody finding a populated plausible number and reading it as live.
--
-- That warning was correct for as long as there was no way to turn it on. There
-- is one now, so the comment has to say what actually decides — otherwise the
-- database goes on insisting the column is inert while an operator is being
-- offered a switch that makes it the whole base. A stale warning is worse than
-- none: it is the one a careful reader trusts.
COMMENT ON COLUMN trading_products.spread_markup_per_lot IS
  'The broker''s spread markup per standard lot, in the account currency. Read as live revenue '
  'ONLY when trading_settings.ib_revenue_basis is ''spread'' or ''commission_swap_spread'' — under '
  'the default ''commission_swap'' it remains a commercial record that drives nothing. It is the '
  'DESK''s figure, not a mirror of MT5 (which has no per-group markup at all) — see migration 0095 '
  'for why that was checked rather than assumed.';
