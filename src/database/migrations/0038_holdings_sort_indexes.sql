-- The indexes behind the two client-holdings lists — R-2.5, same rule as 0037.
--
-- `GET /admin/wallets` and `GET /admin/trading-accounts` are new, and each
-- arrives with a `*_SORT_COLUMNS` allowlist. R-2.5's other half is that the
-- allowlist MAY NOT EXCEED THE INDEXES: a sortable key with nothing behind it
-- degrades the ORDER BY to a sort over the whole filtered set on every page of
-- every filter, which is invisible to every kind of test except a query plan.
-- `test/admin-sort-indexes.spec.ts` asserts those plans and imports the real
-- allowlists, so a key added without an index here fails a spec rather than
-- making a screen quietly slow.
--
-- Hand-written rather than declared in `schema.ts`, matching 0010, 0024 and
-- 0037: these are composite and direction-pinned, and drizzle-kit expresses
-- neither faithfully.
--
-- ── The shape ───────────────────────────────────────────────────────────────
--
-- Every ORDER BY ends in the table's `id`, because none of the sort columns is
-- unique on its own — a currency has a handful of values, an environment has
-- two, a status has three, and two wallets are opened in the same second at
-- registration. Rows tied on the sort key and straddling a page boundary sit in
-- an order Postgres is free to change between queries, which is exactly the
-- row-skipping keyset pagination exists to prevent.
--
-- DESC on both columns of every index, for the reason 0037 records: a b-tree
-- can be read backwards only when EVERY column agrees, so `(x DESC, id DESC)`
-- serves `ORDER BY x DESC, id DESC` forwards and `ORDER BY x ASC, id ASC`
-- backwards with no sort node either way. A mixed `(x DESC, id ASC)` would
-- serve neither of the orders these queries actually issue.
--
-- Indexes already covering the joined client columns are NOT repeated: 0010's
-- `users_created_at_id_idx` and 0024's `users_email_id_idx` /
-- `users_first_name_id_idx` serve `userEmail` / `userFirstName` on both lists,
-- which sort `users.email` / `users.first_name` directly through the INNER JOIN.

-- ── Wallet list (GET /admin/wallets) ────────────────────────────────────────
--
-- `balance` is NUMERIC(28,8) and is indexed AS numeric. The b-tree orders it by
-- true numeric value at full precision, which is the same comparison the query
-- issues — no cast anywhere in the path. An index on `balance::float8` would
-- collapse values differing beyond 2^53 into equal keys, which is the money bug
-- this column is typed to prevent (§6.1). It is also the reason the keyset
-- cursor casts to `::numeric` rather than to a float.
CREATE INDEX "wallets_balance_id_idx" ON "wallets" USING btree ("balance" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "wallets_currency_id_idx" ON "wallets" USING btree ("currency" DESC, "id" DESC);--> statement-breakpoint
-- The default ordering. `wallets_user_idx` exists on `user_id` alone and serves
-- the `?userId=` filter, but cannot serve the `(created_at, id)` row comparison
-- the keyset seek issues.
CREATE INDEX "wallets_created_at_id_idx" ON "wallets" USING btree ("created_at" DESC, "id" DESC);--> statement-breakpoint

-- ── Trading-account list (GET /admin/trading-accounts) ──────────────────────
--
-- `login` is NULLABLE — an account has no MT5 login until one is assigned, and
-- there is no bridge to assign one yet, so in practice most rows are null. The
-- query pins `NULLS LAST` in BOTH directions so unassigned accounts never lead
-- the list, and this index declares the same; without the matching null
-- placement the planner sorts instead of scanning. Same reasoning as 0037's
-- `kyc_submissions_submitted_at_user_idx`.
CREATE INDEX "trading_accounts_login_id_idx" ON "trading_accounts" USING btree ("login" DESC NULLS LAST, "id" DESC);--> statement-breakpoint
-- Indexed as numeric, for the reason `wallets_balance_id_idx` records.
CREATE INDEX "trading_accounts_balance_id_idx" ON "trading_accounts" USING btree ("balance" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "trading_accounts_currency_id_idx" ON "trading_accounts" USING btree ("currency" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "trading_accounts_status_id_idx" ON "trading_accounts" USING btree ("status" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "trading_accounts_environment_id_idx" ON "trading_accounts" USING btree ("environment" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "trading_accounts_created_at_id_idx" ON "trading_accounts" USING btree ("created_at" DESC, "id" DESC);
