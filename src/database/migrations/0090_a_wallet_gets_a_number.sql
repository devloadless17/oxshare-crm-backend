-- Every wallet gets a number a human can actually say.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── Why a second identifier ────────────────────────────────────────────────
--
-- The wallet's uuid is the key the MONEY depends on: `ledger_entries`,
-- `transactions`, `transfers` and `ib_wallet_transfers` all FK it, and
-- `ledger_entries_wallet_reference_uq` makes it half of the idempotency
-- guarantee. None of that moves. But a uuid on a support ticket or a wallet
-- card is 36 characters nobody can read back, so screens showed either the
-- raw uuid or no identifier at all — an operator confirming "close this
-- wallet" was confirming a currency and an email, not a wallet.
--
-- `wallet_number` is the human handle: 12 lowercase characters from the
-- Crockford base32 alphabet (no i/l/o/u, so `0`/`o` and `1`/`l` cannot be
-- confused — the same set `depositReference()` uses for OX- references,
-- lowercased). It is DISPLAY ONLY. Nothing joins on it, nothing keys
-- idempotency on it, and the two admin endpoints that accept a wallet
-- identifier still take the uuid.
--
-- ── Why the generator is a column DEFAULT ──────────────────────────────────
--
-- Wallets are inserted from four places — `getOrCreateWallet`, `lockWallet`,
-- provisioning, and the set-based `openForAllClients` INSERT … SELECT that
-- backfills a newly-enabled currency for every client in one statement. An
-- application-side generator would need all four taught about the column, and
-- the set-based one cannot call a per-row helper without becoming a loop.
-- A DEFAULT covers every INSERT that exists and every INSERT anyone writes
-- later; forgetting the column yields a numbered wallet, not a NULL.
--
-- 32^12 ≈ 1.15e18 values, so a collision is astronomically unlikely; the
-- function still checks and retries (bounded, like the referral-code
-- generator) and the unique index is the real guarantee. Entropy comes from
-- gen_random_uuid() because this database deliberately avoids pgcrypto (see
-- 0027). Bytes 6 and 8 of a v4 uuid carry the version and variant bits — NOT
-- fully random — so the byte positions below deliberately skip them; using
-- them would bias those output characters toward half the alphabet.
CREATE OR REPLACE FUNCTION wallet_number() RETURNS varchar AS $$
DECLARE
  alphabet CONSTANT text := '0123456789abcdefghjkmnpqrstvwxyz';
  positions CONSTANT int[] := ARRAY[0,1,2,3,4,5,7,9,10,11,12,13];
  bytes bytea;
  candidate text;
  p int;
BEGIN
  FOR attempt IN 1..8 LOOP
    bytes := uuid_send(gen_random_uuid());
    candidate := '';
    FOREACH p IN ARRAY positions LOOP
      candidate := candidate || substr(alphabet, (get_byte(bytes, p) % 32) + 1, 1);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM wallets WHERE wallet_number = candidate) THEN
      RETURN candidate;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'wallet_number: no free number in 8 attempts';
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "wallet_number" varchar(12);
--> statement-breakpoint
-- Backfill before NOT NULL: a random value has no constant default, so
-- existing rows are numbered here. The function is VOLATILE, so it re-rolls
-- per row and its EXISTS check sees rows this same UPDATE already wrote.
UPDATE "wallets" SET "wallet_number" = wallet_number() WHERE "wallet_number" IS NULL;
--> statement-breakpoint
ALTER TABLE "wallets" ALTER COLUMN "wallet_number" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "wallets" ALTER COLUMN "wallet_number" SET DEFAULT wallet_number();
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_wallet_number_uq" ON "wallets" ("wallet_number");
--> statement-breakpoint
-- The format lives in the database, like every other invariant here: a value
-- that is not exactly 12 lowercase Crockford characters is a bug, not data.
DO $$ BEGIN
  ALTER TABLE "wallets" ADD CONSTRAINT "wallets_wallet_number_format"
    CHECK ("wallet_number" ~ '^[0-9a-hjkmnp-tv-z]{12}$');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
