-- Deals pay partners, and the MT5 group catalogue is written down.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── Why ────────────────────────────────────────────────────────────────────
--
-- Two gaps in CORE-02, neither of which announced itself.
--
-- The first: NO COMMISSION HAS EVER BEEN ACCRUED, by any path. `mt5_deals` had
-- one writer and no readers. The commission engine accrued on
-- `PositionsService.close`, which no controller and no service ever called, so
-- `positions` had no writer at all and the hourly confirm job ran against a
-- table nothing filled. Every stage reported success — the webhook answered
-- 200, ingestion logged the ticket, the confirm job logged "0 credited" — while
-- no partner could earn anything on any trade. `commission_processed_at` is the
-- queue that closes it.
--
-- The second: `GET /groups` was read live on every picker and stored nowhere,
-- so a group renamed, deleted or repriced underneath a product still selling it
-- was invisible. A live call reports what is true now and structurally cannot
-- report what changed. `mt5_groups` is the written-down copy that makes the
-- comparison possible.

-- ── mt5_deals.commission_processed_at ──────────────────────────────────────
--
-- NULL means "the commission engine has not decided about this deal yet". Set
-- once it has, whether or not anything accrued — most deals legitimately earn
-- nobody anything (an unreferred client, a balance operation) and a queue that
-- keyed off the absence of an `ib_accruals` row would return those forever.
--
-- Deliberately NOT set for a deal whose login matches no `trading_accounts`
-- row, so it is retried: that ordering is normal during onboarding and the deal
-- accrues the moment the account is linked.
ALTER TABLE mt5_deals
  ADD COLUMN IF NOT EXISTS commission_processed_at timestamptz;

-- ── ⚠️ EXISTING DEALS ARE LEFT NULL, AND WILL THEREFORE ACCRUE ─────────────
--
-- Every deal already ingested enters the queue and is assessed on the next run.
-- That is the intended behaviour and not an oversight: those trades really
-- happened, the broker really kept the commission and swap on them, and the
-- partners behind them have never been paid a cent because the seam did not
-- exist. Stamping them processed would be a decision to keep money that was
-- earned, taken silently by a migration.
--
-- The blast radius is bounded by attribution, which is what makes this safe to
-- default: an accrual requires `users.referred_by_ib_user_id` to be set, so a
-- client nobody introduced generates nothing however much they traded. Nothing
-- is credited immediately either — accruals are written `pending` and pass
-- through the maturation window before `confirmPending` moves any balance.
--
-- IF THE DESK DOES NOT WANT TO PAY RETROACTIVELY, run this BEFORE deploying,
-- and understand that it forgives commission that was genuinely earned:
--
--   UPDATE mt5_deals SET commission_processed_at = now()
--    WHERE commission_processed_at IS NULL;
--
-- To pay from a chosen date instead, add `AND dealt_at < '<date>'`.

-- PARTIAL, because the unprocessed set drains continuously while the processed
-- set grows for the life of the broker. A full index here would be almost
-- entirely rows the queue query can never return.
CREATE INDEX IF NOT EXISTS mt5_deals_unaccrued_idx
  ON mt5_deals (dealt_at)
  WHERE commission_processed_at IS NULL;

-- ── mt5_groups ─────────────────────────────────────────────────────────────
--
-- A mirror of what `GET /groups` reported. Nothing here decides anything; the
-- server remains the authority and `attachGroup` still validates against it
-- live. This table answers the two questions a live call cannot: what to show
-- when MT5 is unreachable, and what changed since last time.
CREATE TABLE IF NOT EXISTS mt5_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The group path as the server spells it, e.g. real\Standard. Sized to match
  -- trading_accounts.mt5_group and trading_product_groups.mt5_group.
  name varchar(100) NOT NULL,
  -- NOT a foreign key to `currencies`, and this is the one place that rule
  -- bends. Every other currency column denominates money the CRM owns; this
  -- records what an EXTERNAL system reported. A group priced in a currency the
  -- CRM has not configured is drift worth seeing in a row — a foreign key would
  -- turn it into a failed sync, losing the whole catalogue to protect a column
  -- nobody computes with.
  currency varchar(10) NOT NULL,
  -- MT5 exposes this only as DemoLeverage and uses 0 for "unset", which is
  -- stored as NULL: 1:0 is not a leverage, and an unset group must stay
  -- distinguishable from a configured one.
  leverage_default integer,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Stamped when a sync stops seeing a group an earlier one reported; cleared
  -- if it comes back. Marked rather than deleted, because deleting destroys the
  -- only evidence that a group backing live accounts ever existed, at exactly
  -- the moment somebody needs to explain those accounts.
  removed_at timestamptz
);

-- CASE-INSENSITIVE, because MT5 is: the server answers real\Standard and
-- Real\Standard as one group, and `catalogue.service.ts` already compares group
-- names with toLowerCase() for that reason. A plain unique index would let a
-- server that re-cased a group insert a second row for it, and then "is this
-- group still there" has two answers.
CREATE UNIQUE INDEX IF NOT EXISTS mt5_groups_name_uq
  ON mt5_groups (lower(name));

-- "Which groups are live right now" — the picker's own query.
CREATE INDEX IF NOT EXISTS mt5_groups_present_idx
  ON mt5_groups (name)
  WHERE removed_at IS NULL;
