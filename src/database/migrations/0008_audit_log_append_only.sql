-- D-21: the admin action log is append-only. Enforced by the database, not by
-- the shape of a TypeScript class.
--
-- `ledger_entries` has carried this guarantee since 0002. `audit_log` — the
-- table that answers "who approved this payout" — had only the fact that
-- AuditLogStore exposes no update() and no delete(). That is a convention, and
-- a convention is bypassed by any future service, any later migration, any
-- `psql` session, and any ORM call written by someone who has not read the
-- store.
--
-- D-21's own argument for building the log at all is that it "cannot be
-- retrofitted, because history not recorded is history lost". The same argument
-- applies one level down: history that CAN be edited is not history. The ledger
-- got the stronger guarantee and the audit log did not, which is backwards
-- relative to which of the two answers a compliance question.
--
-- A trigger rather than REVOKE, for the reason 0002 already gives: it holds even
-- for a superuser connection, which is what migrations and local development
-- run as.
--
-- Corrections are new rows. An audit entry recorded in error is itself a fact
-- about what happened, and the fix is another entry describing the correction.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (D-21): % is forbidden. An audit entry recorded in error is itself a fact — write a correcting entry instead.', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
-- Indexes for the columns that are actually filtered on.
--
-- audit-log.store.ts `findAll()` filters on action (indexed), subject_type (was
-- NOT) and actor_id (was NOT). subject_type matters more since KYC document
-- reads became audited events — those are now the highest-volume row type in
-- this table, and "show me every kyc_document read" was a sequential scan.
CREATE INDEX "audit_log_subject_type_idx" ON "audit_log" USING btree ("subject_type");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
-- Every IB earnings query needs this, and none exists yet — which is exactly
-- when adding it is free. IB-11/IB-12 will read accruals by ib_user_id; today
-- the only index is (status, available_at) for the confirm job.
CREATE INDEX "commission_accruals_ib_user_idx" ON "commission_accruals" USING btree ("ib_user_id");
