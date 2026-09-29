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

-- ── A client is VERIFIED only by a decision (identity-core plan, slice 7) ───
--
-- `users.verification_level` opens the money gates — a withdrawal or a
-- transfer is refused below 1 — and until now anything could raise it: a dev
-- script, a support query, a code path that forgot the log. Raising it now
-- needs the client's latest decision to be one that verifies them, in place by
-- COMMIT (deferred, because a decision is recorded after the level moves in
-- the same transaction — approve() writes the attempt, then the level, and
-- adoption records the decision).
--
-- LOWERING it is not refused: that closes a gate, and adoption records it
-- (`identity_drift` names it until then). Nor is an INSERT checked:
-- registration inserts 0, and seeds or an import that insert verified clients
-- are recorded by adoption as `fixture` or `legacy`. The one escape is the
-- record's own, `oxshare.identity_maintenance`, local to its transaction.
CREATE OR REPLACE FUNCTION identity_level_needs_decision() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('oxshare.identity_maintenance', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF (SELECT verification_level FROM users WHERE id = NEW.id) >= 1
     AND coalesce((SELECT level_after FROM client_verifications
                    WHERE user_id = NEW.id ORDER BY seq DESC LIMIT 1), 0) < 1 THEN
    RAISE EXCEPTION 'Client % was verified with no decision that verifies them. A client is verified only by approving their KYC (or a verification recorded in client_verifications).', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_verified_by_a_decision ON users;
CREATE CONSTRAINT TRIGGER users_verified_by_a_decision
  AFTER UPDATE OF verification_level ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.verification_level >= 1 AND OLD.verification_level IS DISTINCT FROM NEW.verification_level)
  EXECUTE FUNCTION identity_level_needs_decision();
