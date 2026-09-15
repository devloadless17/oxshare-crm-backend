-- 0124's actor-search index was built and could never be used.
--
-- ## What happened
--
-- 0124 created it as:
--
--     USING gin (COALESCE(actor_email, ''::character varying) gin_trgm_ops)
--
-- `actor_email` is `varchar(255)`, so `COALESCE(actor_email, '')` is a VARCHAR
-- expression. The QUERY is `... ILIKE '%term%'`, and `ILIKE` is `~~*`, which is
-- defined on `text` — so Postgres rewrites the query's expression to
-- `(COALESCE(actor_email, ''))::text`. An expression index matches on the
-- expression TREE, and a tree with a cast in it is not the tree without one.
--
-- So the index existed, `CREATE INDEX` succeeded, `\d audit_log` listed it, and
-- every actor search was a sequential scan over the append-only table that is
-- guaranteed to become the largest in the system. Measured on 20,000 rows
-- immediately after 0124:
--
--     Seq Scan on audit_log  (cost=0.00..676.06 rows=7)
--       Rows Removed by Filter: 20000
--
-- ⚠️ THE LESSON, because this is the second time this shape has bitten here:
-- "the index exists" and "the index is used" are different facts, and only the
-- second one is worth anything. 0010's users index avoided it by accident — its
-- expression CONCATENATES, and `||` already yields `text`, so the index and the
-- query agreed without anyone deciding they should.
--
-- `test/search-at-scale.spec.ts` is the check that turns this from a comment
-- into a red build: it asks the PLANNER what it intends to do, at a volume where
-- the planner has a real choice, and names the index it expects to see.
--
-- ## The fix
--
-- Cast in the index, exactly as the query is rewritten to. The `COALESCE` stays
-- for the reason 0124 gave — `actor_email` is NOT NULL today and an index that
-- assumes it forever is one that silently stops being used the day it is not.
DROP INDEX IF EXISTS "audit_log_actor_email_trgm_idx";--> statement-breakpoint

CREATE INDEX "audit_log_actor_email_trgm_idx" ON "audit_log" USING gin (
  ((COALESCE("actor_email", '')::text)) gin_trgm_ops
);
