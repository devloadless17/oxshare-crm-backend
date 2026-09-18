-- Four lists could be ordered by columns no index could serve.
--
-- R-2.5's other half — "every sortable column is indexed, and the allowlist may
-- not exceed them" — enforced for six lists by `test/admin-sort-indexes.spec.ts`
-- and for the client index by `client-list-indexes.spec.ts`. These four were
-- outside both.
--
-- ## What each one cost
--
-- `ib_accruals` — THE COMMISSION LEDGER. `IB_ACCRUAL_SORT_COLUMNS` offers
-- `createdAt`, `amount`, `status` and `depth`, and the table carried none of
-- them as a leading column: its three indexes lead with `ib_user_id`,
-- `status, created_at` and `batch_id`. So every sort of the partner payout
-- ledger was a full sort of the filtered set, on every page. It is also the ONLY
-- `*_SORT_COLUMNS` map absent from `admin-sort-indexes.spec.ts`, which is why
-- nothing said so — the spec imports the real maps precisely so a key added
-- without an index arrives in it automatically, and a map nobody imported is a
-- map that check never saw.
--
-- `ledger_entries` — the append-only money record, and the list
-- `wallet.service.ts` calls the one that "reaches OFFSET depth faster than any
-- other list here". It pages by KEYSET on `(created_at, id)` and had only a
-- single-column `created_at`. `0010_client_list_indexes.sql` already argues why
-- that is not enough — a row comparison over two columns needs both in the index
-- or the second is a filter after the fact — and that reasoning was applied to
-- `users` and never here.
--
-- The per-client DRILL-DOWNS — `GET /admin/clients/:id/transactions` and
-- `/positions`. Both filter on one column and order by another, with no index
-- carrying the pair. `positions` looked covered and was not: its
-- `positions_user_open_idx` is PARTIAL on `status = 'open'`, while `?status=` is
-- optional, so the default call — the one the profile screen makes — could not
-- use it at all. Neither partial index carries `id`, so neither could serve the
-- tiebreak either.
--
-- ## Why DESC, and why the tiebreak is in the index
--
-- Same shape as 0037 and 0038: `(col DESC, id DESC)`. A b-tree reads backwards
-- only when every column of the ORDER BY agrees, so matching directions is what
-- lets one index serve both `asc` and `desc`. The `id` is in the index because
-- it is in the ORDER BY — a keyset seek compares the PAIR, and an index missing
-- the second column leaves Postgres sorting to break the ties.
--
-- ## Cost
--
-- Seven indexes on tables that are written far less often than they are read.
-- `ledger_entries` is the busiest and it is append-only — no updates to
-- maintain, one insert per money movement. The alternative on that table is a
-- full sort of a client's whole history on every page of the ADM-13 view.

-- ── The commission ledger ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "ib_accruals_created_at_id_idx" ON "ib_accruals" USING btree ("created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_accruals_amount_id_idx" ON "ib_accruals" USING btree ("amount" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_accruals_status_id_idx" ON "ib_accruals" USING btree ("status" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_accruals_depth_id_idx" ON "ib_accruals" USING btree ("depth" DESC, "id" DESC);--> statement-breakpoint

-- ── The ledger, keyset-paged ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "ledger_entries_created_at_id_idx" ON "ledger_entries" USING btree ("created_at" DESC, "id" DESC);--> statement-breakpoint
-- The filtered form. `?walletId=` narrows to one wallet and then orders by the
-- same pair, so the wallet has to LEAD or the index above is read and discarded.
CREATE INDEX IF NOT EXISTS "ledger_entries_wallet_created_at_id_idx" ON "ledger_entries" USING btree ("wallet_id", "created_at" DESC, "id" DESC);--> statement-breakpoint

-- ── The per-client drill-downs ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "transactions_user_created_at_id_idx" ON "transactions" USING btree ("user_id", "created_at" DESC, "id" DESC);--> statement-breakpoint
-- NOT partial, unlike `positions_user_open_idx`. `?status=` is optional, so the
-- index that serves the default call cannot be predicated on a value the default
-- call does not supply.
CREATE INDEX IF NOT EXISTS "positions_user_opened_at_id_idx" ON "positions" USING btree ("user_id", "opened_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_user_closed_at_id_idx" ON "positions" USING btree ("user_id", "closed_at" DESC, "id" DESC);
