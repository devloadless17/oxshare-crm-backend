-- The two indexes the audit log needs to be INVESTIGATED rather than browsed.
--
-- ## What was missing
--
-- `/audit-log` offered exactly two filters — `action` and `subjectType` — and
-- both are categories. Neither answers either question an incident actually
-- starts from:
--
--   "what did this administrator do"        -> the actor
--   "what has been done to this client"     -> the subject
--
-- The store already accepted `actorId`; no route exposed it, so the filter
-- existed and was unreachable. `subjectId` was accepted nowhere. So the way to
-- answer "everything that happened to this client" was to page a forensic
-- record that grows forever and read it — which on a table whose whole value is
-- completeness is the reading most likely to miss the row that matters.
--
-- ## 1. The subject seek
--
-- `subject_id` is a VARCHAR carrying a uuid for client- and admin-subject rows.
-- An equality filter, so a b-tree — and composite with `created_at DESC` because
-- the screen reads one subject NEWEST FIRST, which is an index scan with no
-- sort step rather than a filter-then-sort over every row that client ever
-- touched.
CREATE INDEX "audit_log_subject_id_created_at_idx"
  ON "audit_log" USING btree ("subject_id", "created_at" DESC);--> statement-breakpoint

-- ## 2. The actor search box
--
-- The screen shows the actor by EMAIL — `actor_email` is denormalised onto the
-- row precisely so a deleted admin's trail still names them — so the filter has
-- to accept an email, and a partial one: an investigator types the part they
-- remember.
--
-- A LEADING wildcard cannot use a b-tree, so without this every keystroke is a
-- sequential scan over the whole audit log, which is the ONE table in this
-- system guaranteed to be the largest: it is append-only and never pruned.
-- That is ARCHITECTURE §5's "unindexed filters" risk in its worst location.
--
-- gin_trgm_ops over the expression the query uses, character for character. The
-- `coalesce` is redundant today (`actor_email` is NOT NULL) and is kept because
-- Postgres matches the index by the EXPRESSION: if the column is ever made
-- nullable and the query gains a coalesce, an index written without one stops
-- being used, silently, and the only symptom is that the page gets slow.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "audit_log_actor_email_trgm_idx" ON "audit_log" USING gin (
  (coalesce("actor_email", '')) gin_trgm_ops
);
