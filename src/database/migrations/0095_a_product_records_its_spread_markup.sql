-- ADM-07: a product records the spread markup it is sold on.
--
-- Numbered 0095, not 0093: two migrations took 0093 and 0094 upstream while
-- this was being written. Renumbering the FILE is the cheap half — see the
-- renumber trap in CLAUDE.md for what it does to a database that already
-- applied the old number, and why a renumbered migration must stay re-runnable.
--
-- Hand-written, like every migration from 0027 on: the committed drizzle
-- snapshots stop at 0026, so `drizzle-kit generate` would diff against a stale
-- baseline and prompt to rename a dozen unrelated enums.
--
-- ── On the PRODUCT, because the product IS the tier ────────────────────────
--
-- The deliverable says "per-tier spread markup", and there is deliberately no
-- tier concept to hang it on: `trading_accounts.tier` is inert and labelled
-- dead, on the reasoning that "a tier would be a second name for the same
-- thing". Standard / ECN / Raw Spread are rows in `trading_products`. Adding a
-- `tiers` table now would create the second name that column was retired for.
--
-- ── ⚠️ IT DRIVES NOTHING, AND THAT IS THE WHOLE POINT ─────────────────────
--
-- This is a COMMERCIAL RECORD: what the desk says a product is sold on. It is
-- read by nothing, and in particular it is NOT part of `brokerRevenueOf`, which
-- is `commission + swap` and decides what every partner is paid.
--
-- Wiring it into that sum is a real and reasonable next step — spread is the
-- other half of what a broker earns on a trade — but it changes what every
-- partner is paid on every future trade, and MT5 reports no per-deal spread
-- revenue to check the result against. That is a decision with a person behind
-- it, not a consequence of adding a column.
--
-- So the column comment below says so IN THE DATABASE. The failure this guards
-- is somebody two quarters from now finding a populated, plausible-looking
-- number and reading it as live.
--
-- ── Why this is NOT a mirror of MT5, checked rather than assumed ──────────
--
-- The obvious objection is that markup is really MT5's to own, so this should
-- mirror the server instead of holding a second opinion. That was checked
-- against the Manager API the bridge actually ships (lib/MetaQuotes.*.dll), and
-- it does not survive contact:
--
--   * MT5 has no per-GROUP markup. What it has is `AskMarkup`, `BidMarkup`,
--     `SpreadDiff` and `SpreadBalance` on `IMTConGroupSymbol` — per group AND
--     symbol, in POINTS, and split by side.
--   * A product maps to one or more groups, and a group covers every symbol it
--     trades. So the honest mirror of one product is group x symbol x 2 values
--     in points, not one figure.
--   * Turning any of that into "currency per lot" needs each symbol's
--     `ContractSize` and `TickValue`, at a price. It is a calculation, not a
--     reading, and it changes with the market.
--
-- So there is no single MT5 number this column could be a copy of, and it is
-- not competing with one. It is the DESK's figure: what the business says a
-- product is sold on. If per-symbol truth is ever wanted, that is a different
-- table (group, symbol, ask_markup, bid_markup) fed by a bridge endpoint that
-- does not exist — additive to this, not a replacement for it.
ALTER TABLE trading_products
  ADD COLUMN IF NOT EXISTS spread_markup_per_lot numeric(28,8) NOT NULL DEFAULT 0;

COMMENT ON COLUMN trading_products.spread_markup_per_lot IS
  'The broker''s spread markup per standard lot, in the account currency. A COMMERCIAL RECORD '
  'ONLY: nothing reads it, and it is deliberately NOT part of brokerRevenueOf (commission + swap), '
  'which decides what partners are paid. Do not start reading it as live revenue without the '
  'sign-off that decision needs — see migration 0095.';

-- NOT NULL DEFAULT 0 so every existing product carries a defined value rather
-- than a NULL that each reader would have to invent a meaning for. Zero is
-- honest here: it is what the system knew about these products before this
-- column existed, and it is a legitimate setting for a raw-spread product that
-- carries no markup at all.

-- Negative is refused. A markup is what the broker ADDS; a negative one would
-- describe paying clients to trade, which is not a product this system sells
-- and is far more likely to be a sign error on a number somebody typed.
--
-- The upper bound is a typo guard rather than a commercial limit: 10,000 units
-- per lot is orders of magnitude past any real markup, and well short of the
-- kind of mistake that turns 1.5 into 150000. DROP-then-ADD so the file is
-- re-runnable, matching 0091.
ALTER TABLE trading_products
  DROP CONSTRAINT IF EXISTS trading_products_spread_markup_ck;

ALTER TABLE trading_products
  ADD CONSTRAINT trading_products_spread_markup_ck
  CHECK (spread_markup_per_lot >= 0 AND spread_markup_per_lot <= 10000);
