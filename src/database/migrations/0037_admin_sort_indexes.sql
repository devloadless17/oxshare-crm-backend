-- The indexes that make the remaining admin lists actually sortable — R-2.5.
--
-- Hand-written rather than declared in `schema.ts`, matching 0010 and 0024:
-- these are composite and direction-pinned, and drizzle-kit expresses neither
-- faithfully. 0024 set the precedent for sort indexes specifically, and the
-- reasoning belongs beside the DDL either way.
--
-- ── Why these exist at all ──────────────────────────────────────────────────
--
-- 0024 did this for ONE list, the ADM-01 client index. Six others — the
-- withdrawal queue, the KYC queue, the audit trail, the partner application
-- queue, the partner list and the administrator directory — still had a single
-- hardcoded ORDER BY and no way for an operator to re-order them. Two of them
-- (`admins`, `roles`) had no ORDER BY AT ALL, which is a correctness bug rather
-- than a missing feature: SQL promises no row order without one, so the
-- directory could reorder itself between two reads and an operator looking for
-- a colleague could not distinguish that from a deletion.
--
-- Making the sort real means the API sorts, which means an index in the SAME
-- SHAPE as the ORDER BY. R-2.5 also requires that the sortable allowlist may
-- not exceed the indexes — so this file and the `*_SORT_COLUMNS` maps in the
-- stores are one change, and a key added to one without the other degrades to a
-- sort over the whole filtered set on every page.
--
-- ── The shape, and why every index repeats a unique column ──────────────────
--
-- Every ORDER BY here ends in the table's unique key, because none of the sort
-- columns is unique on its own: a `status` has six values, a `state` has five,
-- a `role` has two. Rows tied on the sort key and straddling a page boundary
-- sit in an order Postgres is free to change between queries, which is exactly
-- the row-skipping that keyset pagination exists to prevent — and on the
-- offset-paged lists it means a page can repeat one row and omit another.
--
-- The unique column DIFFERS per table and that is not cosmetic:
--   * `transactions`, `audit_log`, `ib_applications`, `admins`, `roles` → `id`
--   * `kyc_submissions` → `user_id` (one submission per client; no `id` column)
--   * `ib_accounts`     → `user_id` (one partner account per client)
--
-- DESC on both columns of every index, not because DESC is the only order
-- offered, but because a b-tree can be read backwards only when EVERY column
-- agrees. `(x DESC, key DESC)` serves `ORDER BY x DESC, key DESC` forwards and
-- `ORDER BY x ASC, key ASC` backwards, with no sort node either way. A mixed
-- `(x DESC, key ASC)` would serve neither of the orders we actually issue.
--
-- Indexes already covering a default ordering are NOT repeated: 0010's
-- `users_created_at_id_idx` and 0024's `users_email_id_idx` /
-- `users_first_name_id_idx` serve the joined client columns on the queues
-- below, which sort `users.email` / `users.first_name` directly.

-- ── Withdrawal queue (GET /admin/withdrawals) ───────────────────────────────
--
-- `amount` is NUMERIC(28,8) and is indexed AS numeric. The b-tree orders it by
-- true numeric value at full precision, which is the same comparison the query
-- issues — no cast anywhere in the path. An index on `amount::float8` would
-- have collapsed values differing beyond 2^53 into equal keys, which is the
-- money bug this whole column is typed to prevent (§6.1).
CREATE INDEX "transactions_amount_id_idx" ON "transactions" USING btree ("amount" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "transactions_state_id_idx" ON "transactions" USING btree ("state" DESC, "id" DESC);--> statement-breakpoint
-- The default ordering. `transactions_created_at_idx` exists from the original
-- schema but is on `created_at` alone, so it cannot serve the `(created_at, id)`
-- row comparison the keyset seek issues without re-sorting the ties.
CREATE INDEX "transactions_created_at_id_idx" ON "transactions" USING btree ("created_at" DESC, "id" DESC);--> statement-breakpoint

-- ── KYC review queue (GET /admin/kyc) ───────────────────────────────────────
--
-- `submitted_at` is NULLABLE — a submission row exists from the moment a client
-- starts one and is stamped only when they finish. The query pins `NULLS LAST`
-- in both directions so unsubmitted applications never lead the queue, and this
-- index declares the same, or the planner would sort rather than scan it.
CREATE INDEX "kyc_submissions_submitted_at_user_idx" ON "kyc_submissions" USING btree ("submitted_at" DESC NULLS LAST, "user_id" DESC);--> statement-breakpoint
-- `kyc_submissions_status_idx` exists on `status` alone; this adds the tiebreak
-- so a page boundary inside one status is stable.
CREATE INDEX "kyc_submissions_status_user_idx" ON "kyc_submissions" USING btree ("status" DESC, "user_id" DESC);--> statement-breakpoint
CREATE INDEX "kyc_submissions_created_at_user_idx" ON "kyc_submissions" USING btree ("created_at" DESC, "user_id" DESC);--> statement-breakpoint

-- ── Audit trail (GET /admin/audit-log) ──────────────────────────────────────
--
-- This table is append-only and grows forever, so it is the one most certain to
-- reach the depth where a missing index hurts — and the one where a skipped row
-- matters most, because a trail with a gap is believed.
CREATE INDEX "audit_log_created_at_id_idx" ON "audit_log" USING btree ("created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "audit_log_action_id_idx" ON "audit_log" USING btree ("action" DESC, "id" DESC);--> statement-breakpoint
-- `actor_email`, not `actor_id`: an operator scanning the log looks for a
-- person, and the email is denormalised onto the row at write time precisely so
-- history survives a later rename.
CREATE INDEX "audit_log_actor_email_id_idx" ON "audit_log" USING btree ("actor_email" DESC, "id" DESC);--> statement-breakpoint

-- ── Partner application queue (GET /admin/ib/applications) ──────────────────
--
-- `submitted_at` here is NOT NULL DEFAULT now(), unlike the KYC queue's, so it
-- needs no null handling: an application exists only once submitted.
CREATE INDEX "ib_applications_submitted_at_id_idx" ON "ib_applications" USING btree ("submitted_at" DESC, "id" DESC);--> statement-breakpoint
-- `ib_applications_status_submitted_idx` covers (status, submitted_at) already,
-- but the ORDER BY tiebreak is `id`, so the composite it can serve without a
-- sort is this one.
CREATE INDEX "ib_applications_status_id_idx" ON "ib_applications" USING btree ("status" DESC, "id" DESC);--> statement-breakpoint

-- ── Partner list (GET /admin/ib/partners) ───────────────────────────────────
--
-- `level` is the ladder rung and is indexed as the INTEGER it is, so 10 sorts
-- above 2. Ordering by the joined `ib_levels.name` instead would have compared
-- those as text — plausible-looking and wrong.
CREATE INDEX "ib_accounts_approved_at_user_idx" ON "ib_accounts" USING btree ("approved_at" DESC, "user_id" DESC);--> statement-breakpoint
CREATE INDEX "ib_accounts_level_user_idx" ON "ib_accounts" USING btree ("level" DESC, "user_id" DESC);--> statement-breakpoint
CREATE INDEX "ib_accounts_referral_code_user_idx" ON "ib_accounts" USING btree ("referral_code" DESC, "user_id" DESC);--> statement-breakpoint

-- ── Administrator directory (GET /admin/users) ──────────────────────────────
--
-- The default is `name ASC` — see `admins.store.ts`. A directory is a list you
-- look somebody up in, so it sorts alphabetically rather than newest-first like
-- the queues above.
CREATE INDEX "admins_name_id_idx" ON "admins" USING btree ("name" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "admins_email_id_idx" ON "admins" USING btree ("email" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "admins_role_id_idx" ON "admins" USING btree ("role" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "admins_status_id_idx" ON "admins" USING btree ("status" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "admins_created_at_id_idx" ON "admins" USING btree ("created_at" DESC, "id" DESC);--> statement-breakpoint

-- ── Role list (GET /admin/roles) ────────────────────────────────────────────
--
-- Small table, and the index matters less for speed than for STABILITY: this
-- list had no ORDER BY at all, so editing a role could move it because the
-- UPDATE rewrote the row to the end of the heap.
CREATE INDEX "roles_name_id_idx" ON "roles" USING btree ("name" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "roles_created_at_id_idx" ON "roles" USING btree ("created_at" DESC, "id" DESC);
