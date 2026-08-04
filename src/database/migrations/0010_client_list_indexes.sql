-- The two indexes ADM-01's client list actually needs.
--
-- ARCHITECTURE §5 is explicit that ~219,000 client rows are trivial for
-- Postgres and that "the risk is unindexed filters and N+1 queries in the admin
-- table, not row count". These are the two unindexed filters.
--
-- ── 1. The keyset seek ──────────────────────────────────────────────────────
--
-- `findPage()` orders by `(created_at DESC, id DESC)` and seeks with the row
-- comparison `(created_at, id) < (?, ?)`. There is an index on `created_at`
-- alone, which lets Postgres find the right neighbourhood and then re-check `id`
-- per row — fine at any page, wasteful at every page, and it cannot serve the
-- ORDER BY without a sort once ties exist.
--
-- A composite in the SAME direction as the query turns the whole thing into one
-- index scan with no sort step. The direction matters: a DESC query against an
-- ASC index can be read backwards, but only when every column agrees, which is
-- why both are declared DESC here rather than relying on it.
--
-- `created_at` is not unique — two clients registering in the same millisecond
-- is not hypothetical during a marketing push — which is exactly why `id` is in
-- the sort key and therefore has to be in the index.
CREATE INDEX "users_created_at_id_idx" ON "users" USING btree ("created_at" DESC, "id" DESC);--> statement-breakpoint

-- ── 2. The search box ───────────────────────────────────────────────────────
--
-- `findPage()` searches with `ILIKE '%term%'` across email, first_name and
-- last_name. A LEADING wildcard cannot use a b-tree at all, so the existing
-- unique index on email does nothing here: every keystroke is a sequential scan
-- over the whole table.
--
-- pg_trgm's GIN index is what makes an infix ILIKE indexable. gin_trgm_ops
-- handles `%term%` and is case-insensitive by construction, which matches what
-- ILIKE already promised.
--
-- One index over the three columns concatenated, not three separate ones: the
-- query ORs across all three, and a single expression index lets Postgres answer
-- it with one scan instead of a BitmapOr over three. The expression must match
-- the query's shape exactly or it will not be used — see the note in
-- users.store.ts, which is why the search predicate lives next to this comment
-- in spirit even though it cannot live next to it in fact.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "users_search_trgm_idx" ON "users" USING gin (
  (coalesce("email", '') || ' ' || coalesce("first_name", '') || ' ' || coalesce("last_name", ''))
  gin_trgm_ops
);
