-- ARCHITECTURE §6.4, rule 4 of the four money rules:
--   "The ledger is append-only. No UPDATE, no DELETE on ledger_entries.
--    Corrections are compensating rows."
--
-- THIS GUARANTEE HAS BEEN ABSENT SINCE 0033, IN EVERY DATABASE, AND NOTHING SAID SO.
--
--   0002  creates ledger_entries AND the two append-only triggers
--   0028  DROPS the table (the commission/money removal) — a DROP TABLE takes
--         the table's triggers with it, which is why no migration mentions them
--   0033  recreates the table in the money rebuild, WITHOUT the triggers
--
-- No migration between then and now recreates them, so a database migrated from
-- scratch today has none. Verified on a fresh Testcontainers database, not
-- inferred from reading: UPDATE and DELETE both succeed on ledger_entries.
--
-- ## Why nothing caught it
--
-- `money-schema-constraints.spec.ts` carries a case named "keeps the ledger
-- append-only in the shape callers actually use". It INSERTS a row and counts
-- it. It never attempts an UPDATE or a DELETE, so it passes identically with the
-- protection and without it. A test for a prohibition has to perform the
-- prohibited act; `ledger-append-only-trigger.spec.ts` now does, including a
-- direct assertion that these two triggers are attached, so a future table
-- recreation fails naming them.
--
-- ## Why this is not redundant with the revoked grants
--
-- The sibling protection — revoking UPDATE/DELETE from the application role —
-- survived, because it is granted to a role rather than attached to the table.
-- That is exactly why this stayed invisible: the APP still could not mutate the
-- ledger, so no application behaviour changed.
--
-- 0002's own comment says why the trigger is still needed: it "holds even for a
-- superuser connection, which is what local dev and migrations run as". Local
-- development connects as a superuser here, and a superuser bypasses grants
-- entirely — so on a developer's machine, and in any migration script, the
-- ledger has had no protection of either kind.
--
-- ## Re-runnable on purpose
--
-- `IF EXISTS` / `OR REPLACE` throughout, so this applies cleanly to a database
-- that somehow still has the 0002 triggers as well as to one that has none. See
-- the repo's note on renumbered migrations: one that may be re-applied must be
-- written to survive it.
--
-- NOTHING IS BACKFILLED, because nothing can be. Any UPDATE or DELETE that
-- already happened is not recoverable from here, and this migration deliberately
-- does not pretend otherwise — it closes the door from now on.

CREATE OR REPLACE FUNCTION ledger_entries_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only (ARCHITECTURE §6.4): % is forbidden. Write a compensating entry instead.', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ledger_entries_no_update ON "ledger_entries";--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS ledger_entries_no_delete ON "ledger_entries";--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();
