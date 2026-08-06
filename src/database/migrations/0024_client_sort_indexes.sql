-- The indexes that make ADM-01's client list actually sortable — R-2.5.
--
-- Hand-written rather than declared in `schema.ts`, matching 0010: these are
-- composite, direction-pinned and in one case an expression, and drizzle-kit
-- expresses none of that faithfully. 0010 set the precedent and the reasoning
-- belongs beside the DDL either way.
--
-- ── Why these exist at all ──────────────────────────────────────────────────
--
-- The admin client table declared seven columns `sortable: true` and passed no
-- sort handler, so clicking a header re-ordered THE 25 ROWS ON SCREEN and
-- presented the result as if it were the dataset. PLATFORM-CONVENTIONS R-2.5
-- names this exactly: "sorting the 25 rows you happen to be holding looks
-- identical to sorting the dataset, and is wrong in a way no one notices until
-- someone acts on the top row."
--
-- Making it real means the API sorts, which means a keyset seek on each
-- sortable column, which means an index in the SAME shape as the seek. R-2.5
-- also requires that the sortable allowlist may not exceed the indexes — so
-- this file and `SORTABLE_COLUMNS` in `users.store.ts` are one change, and a
-- column added to one without the other is a sequential scan over 219,000 rows
-- on every page.
--
-- ── The shape, and why every column repeats `id` ────────────────────────────
--
-- The seek is a row comparison, `(col, id) < (?, ?)`, because `col` is not
-- unique on any of these — two clients can share a status, a country, a name, a
-- verification level, and `created_at` collides during a marketing push. Ties
-- that straddle a page boundary in an order Postgres is free to change between
-- queries is precisely the row-skipping keyset pagination exists to prevent, so
-- `id` is in the sort key and therefore has to be in the index.
--
-- DESC on both columns of every index, not because DESC is the only order
-- offered, but because a b-tree can be read backwards only when EVERY column
-- agrees. `(x DESC, id DESC)` serves `ORDER BY x DESC, id DESC` forwards and
-- `ORDER BY x ASC, id ASC` backwards, with no sort node either way. A mixed
-- `(x DESC, id ASC)` would serve neither of the orders we actually issue.
--
-- `users_created_at_id_idx` already exists from 0010 and is not repeated here.

CREATE INDEX "users_email_id_idx" ON "users" USING btree ("email" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "users_first_name_id_idx" ON "users" USING btree ("first_name" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "users_status_id_idx" ON "users" USING btree ("status" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "users_type_id_idx" ON "users" USING btree ("type" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "users_verification_level_id_idx" ON "users" USING btree ("verification_level" DESC, "id" DESC);--> statement-breakpoint

-- `country` is NULLABLE, and that is why this one is an expression index.
--
-- A seek comparing `(country, id) < (?, ?)` is UNKNOWN — not false — for every
-- row where country is null, so those rows silently vanish from the page rather
-- than sorting to one end. On a compliance screen a filter that hides rows
-- without saying so is the worst available outcome, so the query coalesces to
-- '' and this index has to match that expression exactly or it will not be used.
--
-- Same failure mode as 0010's trigram index: change the expression in
-- `users.store.ts` and the index silently stops being consulted. That is what
-- `client-list-indexes.spec.ts` asserts the query PLAN for, rather than trusting
-- the two to stay in step by inspection.
CREATE INDEX "users_country_id_idx" ON "users" USING btree ((coalesce("country", '')) DESC, "id" DESC);
