-- ============================================================================
-- A payout RUN credits a wallet once, instead of once per trade
-- ============================================================================
--
-- Commission is confirmed every minute since 0113. Keyed per accrual, that
-- wrote one ledger row per closed trade per earner: 252 rows across four
-- wallets in a single day of testing, and a client's wallet history became an
-- unreadable column of two-dollar credits. At real volume it is thousands a
-- day, on the one screen a client uses to account for their own balance.
--
-- `ib_accrual_batches` is one row per (wallet, kind) per run. The ledger entry
-- keys off IT — `reference_type = 'accrual_batch'` — so the client sees one
-- "Commission" line for the run rather than forty.
--
-- ── WHAT DELIBERATELY DOES NOT CHANGE ───────────────────────────────────────
--
-- `ib_accruals` still holds ONE ROW PER TRADE PER EARNER. That is the whole
-- audit trail: which trade paid what, at which rate, on which rung. Merging
-- those too would have made the ledger tidy by destroying the only record of
-- how each amount was arrived at, and would make a dealer-cancelled trade
-- impossible to claw back individually (FR-IB, and `reverseAccrual`).
--
-- So this is a change to how money is WRITTEN, not to what is KNOWN. The
-- commissions page reads `ib_accruals` and is untouched.
--
-- ── REVERSAL STILL WORKS PER TRADE ──────────────────────────────────────────
--
-- `reverseAccrual` posts a COMPENSATING `adjustment` entry — it never edits the
-- credit, because `ledger_entries` is append-only. That was already true when
-- the credit was per-accrual, so reversing one trade out of a merged batch is
-- the same operation it always was: a small negative row beside a large
-- positive one, which is exactly how a ledger is supposed to record a partial
-- correction.
--
-- ⚠️ `ib_accruals.ledger_entry_id` now points at the BATCH's entry, so several
-- accruals share one. It was never unique and nothing assumed it was — it is
-- the link from "what was earned" to "how it was paid", and that link is still
-- correct when the payment covered more than one earning.
--
-- ⚠️ ROWS ALREADY WRITTEN ARE NOT MIGRATED. Every existing ledger entry keeps
-- `reference_type = 'accrual'` pointing at its own accrual. They credited real
-- wallets, the table is append-only, and rewriting settled money to make a
-- report tidier is the one thing this migration must not do. Both shapes are
-- readable for ever; only new payouts batch.

BEGIN;

CREATE TABLE IF NOT EXISTS ib_accrual_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHO was paid and INTO WHICH wallet. The wallet is the grouping key rather
  -- than the user: a partner who is also a client is paid commission into their
  -- commission wallet and rebates into their main one, and those must never
  -- merge into a single credit.
  wallet_id     uuid NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,

  -- `commission` or `rebate`. Mirrors `ib_accruals.kind`, and is part of what
  -- keeps the two apart on one wallet in the rare case they share one.
  kind          ib_accrual_kind NOT NULL,

  currency      varchar(10) NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,

  -- The SUM of the accruals in this batch, and the amount actually credited.
  -- NUMERIC(28,8) like every other money column (§6.1) — never a float.
  amount        numeric(28, 8) NOT NULL,

  -- How many accruals it covers. Stored rather than counted on read: it is what
  -- the client's transaction line says ("Commission - 40 trades"), and a COUNT
  -- over a growing table for a label is a query nobody should pay for.
  accrual_count integer NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),

  -- A batch that paid nothing is a bug, not an empty state: the confirm loop
  -- only creates one once it has something to credit.
  CONSTRAINT ib_accrual_batches_amount_positive
    CHECK (amount > 0 AND amount IS NOT NULL),
  -- ⚠️ `IS NOT NULL` beside `> 0` deliberately. A CHECK evaluating to NULL
  -- PASSES in Postgres, so `count > 0` alone would accept a NULL count. The
  -- same trap 0111 hit and 0114 documented.
  CONSTRAINT ib_accrual_batches_count_positive
    CHECK (accrual_count > 0 AND accrual_count IS NOT NULL)
);

-- The batch an accrual was paid in. NULLABLE, because every accrual confirmed
-- before this migration was paid on its own and belongs to no batch — and
-- because a PENDING accrual has not been paid at all yet.
ALTER TABLE ib_accruals
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES ib_accrual_batches(id) ON DELETE RESTRICT;

-- Reading a batch's members — the drill-down from one wallet line to the trades
-- behind it, which is the whole reason the per-trade rows are kept.
CREATE INDEX IF NOT EXISTS ib_accruals_batch_idx
  ON ib_accruals (batch_id) WHERE batch_id IS NOT NULL;

-- The confirm loop's own read: everything this wallet was paid, newest first.
CREATE INDEX IF NOT EXISTS ib_accrual_batches_wallet_idx
  ON ib_accrual_batches (wallet_id, created_at DESC);

COMMIT;
