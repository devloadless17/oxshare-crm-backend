-- ============================================================================
-- The identity record follows the KYC rows at every commit — whoever wrote them
-- ============================================================================
--
-- Until the contract slice the KYC columns are the source, and the client's
-- identity record (0151) is derived from them by `identity_adopt` (0152).
-- Current code calls it inside every KYC transaction
-- (`ClientIdentityService.recordFromKyc`), which keeps the record current
-- WITHIN that transaction. These triggers make it hold for EVERY writer:
--
--   - an older build during a rollback, which knows nothing of the record;
--   - raw SQL, dev scripts, test fixtures;
--   - a KYC path added later by somebody who never heard of the record.
--
-- The stance the admin bell took (0140): a new path that moves the KYC rows
-- needs no record code.
--
-- ## DEFERRED to COMMIT, and that is the point
--
-- A decision is several writes — the status, the archived attempt, the
-- verification level — in one transaction. Adopting after the FIRST of them
-- reads a half-made decision: an attempt archived before the level has moved
-- looks like a level the log does not explain, and adoption would "explain" it
-- with an invented legacy decision. At commit the state is whole. A rolled
-- back transaction adopts nothing.
--
-- ## Only on writes that change what the record is derived from
--
-- Evidence, answers and status. `identity_adopt`'s own writes — the version
-- pointers, an attempt's decision id — are none of those, so they do not fire
-- it again.
--
-- ## The boot repair stays, as the DETECTOR
--
-- `ClientIdentityService.repairDrift` now catches only what these cannot see:
-- a verification level written directly (until the level trigger, slice 7),
-- rows written with triggers disabled (a restore, replication), and anything
-- edited through the record's own maintenance escape.
--
-- Safe to run twice.

CREATE OR REPLACE FUNCTION identity_follow_kyc() RETURNS trigger AS $$
BEGIN
  PERFORM identity_adopt(CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kyc_submissions_identity_follow ON kyc_submissions;
CREATE CONSTRAINT TRIGGER kyc_submissions_identity_follow
  AFTER INSERT OR DELETE ON kyc_submissions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION identity_follow_kyc();

DROP TRIGGER IF EXISTS kyc_submissions_identity_follow_update ON kyc_submissions;
CREATE CONSTRAINT TRIGGER kyc_submissions_identity_follow_update
  AFTER UPDATE ON kyc_submissions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
     OR OLD.document IS DISTINCT FROM NEW.document
     OR OLD.selfie IS DISTINCT FROM NEW.selfie
     OR OLD.address_proof IS DISTINCT FROM NEW.address_proof
     OR OLD.step_data IS DISTINCT FROM NEW.step_data)
  EXECUTE FUNCTION identity_follow_kyc();

DROP TRIGGER IF EXISTS kyc_attempts_identity_follow ON kyc_submission_attempts;
CREATE CONSTRAINT TRIGGER kyc_attempts_identity_follow
  AFTER INSERT OR DELETE ON kyc_submission_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION identity_follow_kyc();

DROP TRIGGER IF EXISTS kyc_attempts_identity_follow_update ON kyc_submission_attempts;
CREATE CONSTRAINT TRIGGER kyc_attempts_identity_follow_update
  AFTER UPDATE ON kyc_submission_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
     OR OLD.document IS DISTINCT FROM NEW.document
     OR OLD.selfie IS DISTINCT FROM NEW.selfie
     OR OLD.address_proof IS DISTINCT FROM NEW.address_proof
     OR OLD.step_data IS DISTINCT FROM NEW.step_data)
  EXECUTE FUNCTION identity_follow_kyc();
