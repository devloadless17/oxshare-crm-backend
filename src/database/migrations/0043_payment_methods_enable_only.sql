-- Payment methods reduced to the one decision an operator actually makes:
-- is this method offered to clients, or not?
--
-- Hand-written, matching 0027 onwards — the committed drizzle snapshots stop at
-- 0026, so `drizzle-kit generate` diffs against a stale baseline.
--
-- ── ⚠️ THIS DROPS A COLUMN AND DELETES A ROW. READ BEFORE APPLYING ──────────
--
-- `kind` is DESTROYED, along with the `payment_method_kind` enum type. There is
-- no down migration.
--
-- ── Why `kind` goes ────────────────────────────────────────────────────────
--
-- It was never a fact about the row. It was a fact about the CODE: whether a
-- gateway implementation exists for that key. `PaymentMethodsService` already
-- knew that and had stopped trusting the column — `effectiveKind` overrode the
-- stored value with `PaymentGateways.isImplemented(key)` on every read, because
-- the seeded Whish row said `manual` while the Whish gateway existed.
--
-- A column every reader overrides is not data. It is a second copy of an answer
-- the code holds, kept only long enough to disagree — and while it survived, an
-- operator was asked to classify a method in the admin form and a client was
-- shown the word "Manual" on the deposit screen. Neither is something either of
-- them can act on.
--
-- The flow is now derived where it is known: `PaymentGateways.isImplemented`
-- decides whether a deposit starts a hosted payment, and the API tells the
-- portal the outcome by returning a `paymentUrl` or not. Adding a provider is a
-- case in one switch, exactly as before.
--
-- ── Why `usdt_trc20` goes ──────────────────────────────────────────────────
--
-- Migration 0042 seeded it to exercise the `crypto` branch. There is no crypto
-- branch any more, and no crypto provider behind the key — so the row is an
-- enabled deposit method that no code can complete. Whish is the method this
-- platform runs; a crypto method comes back as a row when there is an
-- implementation to put behind it.
--
-- The DELETE is GUARDED on there being no transaction referencing it.
-- `transactions.method_key` is a RESTRICT foreign key, so an unguarded delete
-- would abort this whole migration on any database where somebody had already
-- deposited through it. If a deposit does reference the row it stays, disabled
-- by the UPDATE above it, and every historical deposit keeps a readable method
-- name — which is the same trade `remove()` was deleted over.

-- Disabled FIRST, so the row stops being offered to clients whether or not the
-- delete below can proceed.
UPDATE "payment_methods" SET "enabled" = false WHERE "key" = 'usdt_trc20';
--> statement-breakpoint

DELETE FROM "payment_methods"
WHERE "key" = 'usdt_trc20'
  AND NOT EXISTS (SELECT 1 FROM "transactions" WHERE "method_key" = 'usdt_trc20');
--> statement-breakpoint

ALTER TABLE "payment_methods" DROP COLUMN IF EXISTS "kind";
--> statement-breakpoint

-- The enum type outlives its column. Dropped separately, and AFTER the column,
-- because a type still in use refuses to drop.
DROP TYPE IF EXISTS "payment_method_kind";
