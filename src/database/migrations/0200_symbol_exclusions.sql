-- 0200 — SYMBOLS A COMMISSION TYPE DOES NOT PAY ON (6 Oct 2026).
--
-- The owner's rule: a commission type may exclude whole MT5 symbol folders —
-- the categories the terminal's symbol search shows (Forex, Metals, Crypto,
-- Indices…) — and single symbols. A closing deal on an excluded symbol is
-- stored as always and pays NO commission and NO rebate. A folder excludes
-- every symbol beneath it, including symbols added to it later.
--
-- mt5_symbols  the CRM's copy of the server's symbol list with each symbol's
--              folder path, synced with the MT5 groups. The engine reads a
--              deal's folder from here, so pricing never waits on the bridge.
--              Case-insensitive on the symbol, as MT5 is. A symbol the server
--              stops reporting is marked removed, not deleted.
-- ib_commission_types.excluded_paths    folder paths, e.g. 'Crypto'.
-- ib_commission_types.excluded_symbols  symbol names, e.g. 'BTCUSD'.
--
-- Idempotent; no transaction scope assumed.

CREATE TABLE IF NOT EXISTS mt5_symbols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol varchar(50) NOT NULL,
  path varchar(255) NOT NULL DEFAULT '',
  description varchar(255) NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mt5_symbols_symbol_uq ON mt5_symbols (lower(symbol));
--> statement-breakpoint
ALTER TABLE ib_commission_types ADD COLUMN IF NOT EXISTS excluded_paths text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE ib_commission_types ADD COLUMN IF NOT EXISTS excluded_symbols text[] NOT NULL DEFAULT '{}';
