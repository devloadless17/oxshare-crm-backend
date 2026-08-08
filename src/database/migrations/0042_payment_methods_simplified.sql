-- Payment methods reduced to what an operator actually configures, plus a
-- crypto method to exercise the third deposit flow.
--
-- Hand-written, matching 0027 onwards — the committed drizzle snapshots stop at
-- 0026, so `drizzle-kit generate` diffs against a stale baseline.
--
-- ── ⚠️ THIS DROPS COLUMNS. READ BEFORE APPLYING TO PRODUCTION ───────────────
--
-- `pay_to`, `instructions`, `min_amount` and `max_amount` are DESTROYED. There
-- is no down migration and no way to recover the values afterwards — take a dump
-- first if any of them hold real operator configuration.
--
-- ── What each drop costs ───────────────────────────────────────────────────
--
-- `pay_to` and `instructions` were the account number and the transfer notes a
-- MANUAL method showed the client. Without them a manual deposit tells the
-- client a reference and nothing about where to send the money.
--
-- That is a deliberate product decision, made explicitly and twice: the admin
-- surface is now name, key, logo and an enable/disable toggle, and the deposit
-- flow the platform actually runs is the GATEWAY one, where the client is
-- redirected and never sees an account number.
--
-- IF MANUAL DEPOSITS ARE REVIVED, these columns come back — not as a form field
-- somebody forgets to fill in, but with `listAvailable` refusing to offer a
-- manual method that has no destination. That was the rule this schema used to
-- carry, and it existed because "inventing an IBAN is the same failure as the
-- fake $0.00 balances, with a worse outcome: the money leaves and does not
-- arrive."
--
-- `min_amount` and `max_amount` were PER-METHOD deposit bounds. Nothing is lost
-- operationally: `PaymentMethodsService.withEffectiveBounds` now reports the
-- platform-wide floor and ceiling (`MoneyLimits`, §12.4) on every method, which
-- is what makes the limits identical across methods — the thing that was asked
-- for. `requestDeposit` still enforces them.
--
-- KEPT, and not up for removal:
--   `currency`    decides which wallet a deposit lands in. NOT NULL, and a
--                 foreign key into `currencies`.
--   `kind`        decides the deposit FLOW. Now derived from the key at read
--                 time, but still stored so a row is readable on its own.
--   `sort_order`  the operator's presentation order, which `listAvailable`
--                 still sorts by.

ALTER TABLE "payment_methods" DROP COLUMN IF EXISTS "pay_to";
--> statement-breakpoint
ALTER TABLE "payment_methods" DROP COLUMN IF EXISTS "instructions";
--> statement-breakpoint
ALTER TABLE "payment_methods" DROP COLUMN IF EXISTS "min_amount";
--> statement-breakpoint
ALTER TABLE "payment_methods" DROP COLUMN IF EXISTS "max_amount";
--> statement-breakpoint

-- ── A crypto method, for testing the third flow ────────────────────────────
--
-- `kind = 'crypto'` is the one branch neither Whish (gateway) nor a bank
-- transfer (manual) exercises, and it has had no row to test against.
--
-- Seeded ENABLED, deliberately and unlike the Whish row: `enabled` is now the
-- operator's whole decision about whether clients see a method, so a seeded
-- disabled row would be invisible and test nothing. Turn it off in the admin
-- console when it is no longer wanted — there is no delete, by design.
--
-- USDT settles in its own currency, which is why the row names USDT rather than
-- USD: the METHOD decides the deposit currency, and a USDT deposit landing in a
-- USD wallet is money in a denomination the operator never agreed to receive.
--
-- ON CONFLICT DO NOTHING so re-running this migration — or applying it to a
-- database where somebody already added the key by hand — is a no-op rather
-- than a failure.
INSERT INTO "payment_methods" ("key", "name", "kind", "currency", "enabled", "sort_order")
VALUES ('usdt_trc20', 'USDT (TRC20)', 'crypto', 'USDT', true, 10)
ON CONFLICT ("key") DO NOTHING;
