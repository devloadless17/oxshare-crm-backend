-- 0183 — an index under every foreign key that had none.
--
-- Postgres indexes the REFERENCED side of a foreign key, never the referencing
-- one. Deleting or re-keying a parent (a role, a tag, a reviewing admin, an IB
-- level, a wallet) therefore checked the child with a sequential scan, under
-- the parent's row lock — on tables that grow without bound (ib_accruals,
-- kyc_submission_attempts, transactions). Found by a pg_constraint/pg_index
-- census of the dev database. Nullable columns get PARTIAL indexes: the check
-- never looks for NULL, and most rows carry none.
--
-- Deliberately left out: FKs to small lookup tables (currency, provider_code),
-- whose parents are never deleted while referenced.

CREATE INDEX IF NOT EXISTS "admin_invites_role_id_fk_idx" ON "admin_invites" ("role_id") WHERE "role_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "admins_role_id_fk_idx" ON "admins" ("role_id") WHERE "role_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "kyc_submissions_address_document_id_fk_idx" ON "kyc_submissions" ("address_document_id") WHERE "address_document_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "kyc_submissions_identity_document_id_fk_idx" ON "kyc_submissions" ("identity_document_id") WHERE "identity_document_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "kyc_submissions_reviewed_by_fk_idx" ON "kyc_submissions" ("reviewed_by") WHERE "reviewed_by" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "kyc_submissions_selfie_document_id_fk_idx" ON "kyc_submissions" ("selfie_document_id") WHERE "selfie_document_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "kyc_submission_attempts_address_document_id_fk_idx" ON "kyc_submission_attempts" ("address_document_id") WHERE "address_document_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "kyc_submission_attempts_identity_document_id_fk_idx" ON "kyc_submission_attempts" ("identity_document_id") WHERE "identity_document_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "kyc_submission_attempts_reason_id_fk_idx" ON "kyc_submission_attempts" ("reason_id") WHERE "reason_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "kyc_submission_attempts_reviewed_by_fk_idx" ON "kyc_submission_attempts" ("reviewed_by") WHERE "reviewed_by" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "kyc_submission_attempts_selfie_document_id_fk_idx" ON "kyc_submission_attempts" ("selfie_document_id") WHERE "selfie_document_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "kyc_submission_attempts_verification_id_fk_idx" ON "kyc_submission_attempts" ("verification_id") WHERE "verification_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "admin_client_tag_scopes_tag_id_fk_idx" ON "admin_client_tag_scopes" ("tag_id");
CREATE INDEX IF NOT EXISTS "ib_applications_agency_id_fk_idx" ON "ib_applications" ("agency_id") WHERE "agency_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ib_accounts_application_id_fk_idx" ON "ib_accounts" ("application_id") WHERE "application_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "transactions_destination_trading_account_id_fk_idx" ON "transactions" ("destination_trading_account_id") WHERE "destination_trading_account_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "api_keys_created_by_fk_idx" ON "api_keys" ("created_by") WHERE "created_by" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ib_accruals_ledger_entry_id_fk_idx" ON "ib_accruals" ("ledger_entry_id") WHERE "ledger_entry_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ib_accruals_level_id_fk_idx" ON "ib_accruals" ("level_id") WHERE "level_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ib_accruals_program_id_fk_idx" ON "ib_accruals" ("program_id") WHERE "program_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ib_wallet_transfers_from_wallet_id_fk_idx" ON "ib_wallet_transfers" ("from_wallet_id");
CREATE INDEX IF NOT EXISTS "ib_wallet_transfers_to_wallet_id_fk_idx" ON "ib_wallet_transfers" ("to_wallet_id");
CREATE INDEX IF NOT EXISTS "client_document_pages_stored_object_id_fk_idx" ON "client_document_pages" ("stored_object_id") WHERE "stored_object_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "payment_unmatched_records_matched_tx_fk_idx" ON "payment_provider_unmatched_records" ("matched_transaction_id") WHERE "matched_transaction_id" IS NOT NULL;
