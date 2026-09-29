-- 0156 — every audit row carries the client it concerns, stamped when it is written.
--
-- The audit trail follows the reader's client scope (D-54). It decided which
-- client a row concerns with a CASE over subject types at READ time, and a
-- type the CASE did not know resolved to NULL — which the scope filter KEPT for
-- everyone. Measured on the dev database before this migration: every KYC
-- document read (746 rows), every deposit-receipt read (25), every commission
-- reversal, and every refused request naming a client in its path were shown
-- to administrators holding no territory over that client. An omission was a
-- leak, and a new row type was an omission until somebody remembered it.
--
-- Now:
--   * `audit_log_client_of` is the ONE definition of "which client does this
--     row concern", in the database, where it can look up what a row names
--     only by reference (a file, an accrual, a request line);
--   * a BEFORE INSERT trigger stamps `client_id` on EVERY write — the admin
--     service, the uploads controller, the profile writer, raw SQL — so a new
--     writer needs no scope code (the 0140/0153 stance);
--   * the read filter uses the column, and a NULL is trusted to mean "about no
--     client" only for the subject types declared as such in
--     `audit-log.store.ts` (`NON_CLIENT_SUBJECT_TYPES`). Any other row whose
--     client could not be resolved is hidden from a scoped reader: the wrong
--     answer is now a hidden row, never a leaked one.
--
-- A writer may state `client_id` itself; the trigger fills it only when absent.
-- The function never fails the insert: an audit row must never be refused, and
-- on the money path it shares the transaction that moves the money.

ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "client_id" uuid;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_log_client_of(
  p_subject_type text,
  p_subject_id text,
  p_details jsonb,
  p_actor_kind text,
  p_actor_id text
) RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  uuid_re CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  named text;
  found uuid;
  segments text[];
BEGIN
  IF p_subject_type IN ('user', 'kyc_submission', 'ib_account') THEN
    -- The subject IS the client (a partner is a user too).
    IF p_subject_id ~* uuid_re THEN RETURN p_subject_id::uuid; END IF;

  ELSIF p_subject_type IN ('trading_account', 'transaction', 'wallet', 'ib_application', 'transfer') THEN
    -- The subject is the RECORD, and the record knows its owner. `details` is
    -- read first (cheap, and it survives a deleted record), but most money
    -- writers never put the client there: 414 approvals, rejections and
    -- payouts on the dev database named their client only through the
    -- transaction — and were shown to every desk.
    named := COALESCE(p_details->>'clientId', p_details->>'userId');
    IF named ~* uuid_re THEN RETURN named::uuid; END IF;
    IF p_subject_id ~* uuid_re THEN
      CASE p_subject_type
        WHEN 'trading_account' THEN SELECT r.user_id INTO found FROM trading_accounts r WHERE r.id = p_subject_id::uuid;
        WHEN 'transaction' THEN SELECT r.user_id INTO found FROM transactions r WHERE r.id = p_subject_id::uuid;
        WHEN 'wallet' THEN SELECT r.user_id INTO found FROM wallets r WHERE r.id = p_subject_id::uuid;
        WHEN 'ib_application' THEN SELECT r.user_id INTO found FROM ib_applications r WHERE r.id = p_subject_id::uuid;
        ELSE SELECT r.user_id INTO found FROM transfers r WHERE r.id = p_subject_id::uuid;
      END CASE;
      IF found IS NOT NULL THEN RETURN found; END IF;
    END IF;

  ELSIF p_subject_type = 'ib_accrual' THEN
    -- Whose money the accrual is: the partner for a commission, the trading
    -- client for a rebate — the wallet a reversal debits.
    IF p_subject_id ~* uuid_re THEN
      SELECT CASE WHEN a.kind = 'rebate' THEN a.client_user_id ELSE a.ib_user_id END
        INTO found
        FROM ib_accruals a
       WHERE a.id = p_subject_id::uuid;
      IF found IS NOT NULL THEN RETURN found; END IF;
    END IF;

  ELSIF p_subject_type = 'kyc_document' THEN
    -- The subject is the file name. Its owner, as the uploads route decides it:
    -- the identity record first, then the storage registry.
    SELECT d.user_id INTO found
      FROM client_document_pages p
      JOIN client_documents d ON d.id = p.document_id
     WHERE p.storage_key = 'uploads/kyc/' || p_subject_id
     LIMIT 1;
    IF found IS NULL THEN
      SELECT o.owner_user_id INTO found
        FROM stored_objects o
       WHERE o.bucket = 'kyc' AND o.storage_key = 'kyc/' || p_subject_id;
    END IF;
    IF found IS NOT NULL THEN RETURN found; END IF;

  ELSIF p_subject_type = 'deposit_proof' THEN
    SELECT o.owner_user_id INTO found
      FROM stored_objects o
     WHERE o.bucket = 'deposit-proofs' AND o.storage_key = 'deposit-proofs/' || p_subject_id;
    IF found IS NULL THEN
      SELECT t.user_id INTO found FROM transactions t WHERE t.proof_filename = p_subject_id LIMIT 1;
    END IF;
    IF found IS NOT NULL THEN RETURN found; END IF;

  ELSIF p_subject_type = 'route' THEN
    -- A refused request: `PATCH /v1/admin/clients/<ref>/…`. A path segment
    -- that is a client's uuid or Portal ID names that client. A number that
    -- merely equals some Portal ID (an MT5 login, say) over-hides the row,
    -- which is the safe direction.
    segments := string_to_array(split_part(split_part(p_subject_id, ' ', 2), '?', 1), '/');
    SELECT u.id INTO found
      FROM users u
     WHERE u.id IN (SELECT s::uuid FROM unnest(segments) s WHERE s ~* uuid_re)
        OR u.portal_id IN (SELECT s::integer FROM unnest(segments) s WHERE s ~ '^[1-9][0-9]{0,8}$')
     LIMIT 1;
    IF found IS NOT NULL THEN RETURN found; END IF;
  END IF;

  -- A client acting concerns themselves: reading their own document,
  -- editing their own profile.
  IF p_actor_kind = 'client' AND p_actor_id ~* uuid_re THEN RETURN p_actor_id::uuid; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_log_stamp_client() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.client_id IS NULL THEN
    BEGIN
      NEW.client_id := audit_log_client_of(
        NEW.subject_type, NEW.subject_id, NEW.details, NEW.actor_kind::text, NEW.actor_id::text);
    EXCEPTION WHEN OTHERS THEN
      -- Never refuse the row. Left NULL, a client-type row is hidden from every
      -- scoped reader (see the header), so this fails closed.
      RAISE WARNING 'audit_log_stamp_client: % (%), row kept without client_id', SQLERRM, SQLSTATE;
    END;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_stamp_client ON "audit_log";
--> statement-breakpoint
CREATE TRIGGER audit_log_stamp_client
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_stamp_client();
--> statement-breakpoint

-- The backfill is the one UPDATE this append-only table has ever taken: it adds
-- a derived column and changes no recorded value. The guard is lifted for this
-- statement only, inside the migration's transaction, and restored before it
-- commits — `test/audit-log-append-only.spec.ts` still attempts both prohibited
-- acts against a migrated database.
ALTER TABLE "audit_log" DISABLE TRIGGER audit_log_no_update;
--> statement-breakpoint
UPDATE "audit_log"
   SET "client_id" = audit_log_client_of(subject_type, subject_id, details, actor_kind::text, actor_id::text)
 WHERE "client_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE TRIGGER audit_log_no_update;
--> statement-breakpoint

-- 0134's index was on the old read-time CASE; the column replaces it.
DROP INDEX IF EXISTS "audit_log_client_id_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_client_id_idx" ON "audit_log" ("client_id") WHERE "client_id" IS NOT NULL;
