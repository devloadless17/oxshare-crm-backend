-- 0157 — the two search expressions a masked reader uses, indexed like 0010's.
--
-- `clientIdentitySearch` never matches a fragment against a column the
-- reader's role hides (D-82): with the email hidden it searches the names
-- alone, with a name hidden the email alone. Each is a different expression
-- from 0010's concatenation, and an infix ILIKE is indexable only on its exact
-- expression, so without these a masked desk's every keystroke is a sequential
-- scan of `users`. The `::text` is the cast ILIKE applies to a varchar — 0125
-- is the record of an index built without it that nothing could use.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_name_search_trgm_idx" ON "users" USING gin (
  (coalesce("first_name", '') || ' ' || coalesce("last_name", '')) gin_trgm_ops
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_search_trgm_idx" ON "users" USING gin (
  (coalesce("email", '')::text) gin_trgm_ops
);
