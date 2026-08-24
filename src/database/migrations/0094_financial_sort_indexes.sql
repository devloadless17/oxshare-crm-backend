-- The composite sort indexes for the two transfer tables the admin Financial
-- list unions in — R-2.5, extending 0037 to the union's other arms.
--
-- Hand-written and NOT declared in `schema.ts`, matching 0037/0024: these are
-- composite and direction-pinned, and drizzle-kit expresses neither faithfully.
--
-- ── Why now ─────────────────────────────────────────────────────────────────
--
-- GET /admin/transactions reads `transactions UNION ALL transfers UNION ALL
-- ib_wallet_transfers`, ordered by createdAt, amount or state with an `id`
-- tiebreak. `transactions` has had the matching `(col DESC, id DESC)` indexes
-- since 0037; the transfer tables only carried single-column indexes, so their
-- arms of the union sort the whole filtered set on every page. Postgres can
-- serve an inlined `UNION ALL … ORDER BY … LIMIT` through a Merge Append when
-- every branch is index-ordered — these are what make the branches eligible.
--
-- DESC on both columns for 0037's reason: a b-tree serves `ORDER BY x DESC,
-- id DESC` forwards and `ASC, ASC` backwards with no sort node either way; a
-- mixed-direction index serves neither. The `id` tiebreak matches the
-- `(sort_col, id)` row comparison the keyset seek issues.
--
-- `ib_wallet_transfers` gets no state index: the table has no state column —
-- a row existing IS the movement having happened (see schema.ts) — and the
-- union states it as a constant, which no index can help order.
--
-- IF NOT EXISTS on every statement, because this migration was RENUMBERED
-- (0093 → 0094; the slot collided with 0092_a_stuck_deal on origin) after a
-- dev database had applied it under the old number. The gotcha in CLAUDE.md
-- is exactly this file's history: a renumbered migration must be re-runnable,
-- since the repair for the watermark trap re-applies it.
CREATE INDEX IF NOT EXISTS "transfers_created_at_id_idx" ON "transfers" USING btree ("created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfers_amount_id_idx" ON "transfers" USING btree ("amount" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfers_state_id_idx" ON "transfers" USING btree ("state" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_wallet_transfers_created_at_id_idx" ON "ib_wallet_transfers" USING btree ("created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_wallet_transfers_amount_id_idx" ON "ib_wallet_transfers" USING btree ("amount" DESC, "id" DESC);
