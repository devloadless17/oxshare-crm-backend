-- ============================================================================
-- The client's identity RECORD: documents, the selfie, and every verification
-- decision, owned by the client (owner, 28 Sep 2026)
-- ============================================================================
--
-- "The identity of our client is the most important thing … KYC may later be
-- an external system." A passport is the CLIENT's document: it exists before
-- KYC and after it, and KYC only collects and checks it. Until now it had no
-- home of its own — it was a file path inside the client's current KYC
-- submission, a replaced one survived only as an attempt snapshot, and nothing
-- recorded how, when or by whom a client was verified.
--
-- This migration only ADDS the record. Nothing reads or writes it yet (the
-- next slices adopt the existing evidence, then write through it), so it can
-- ship and roll back on its own.
--
--   client_documents          one row per VERSION of a document or selfie.
--                             A DRAFT is what the client is assembling; a
--                             FROZEN version (frozen_at) is what was presented
--                             for a decision, and never changes again.
--   client_document_pages     its pages: the stored file, by storage key.
--   client_verifications      the append-only log of every decision —
--                             approve, return, re-verification — by whom or
--                             by what, with the reason.
--   client_verification_documents   which versions each decision covered.
--
-- A document's STATUS (verified, returned, in review, replaced) is derived from
-- the log. It is deliberately not a column: a decision stored twice drifts.
--
-- ## The protection holds against a superuser
--
-- The ledger lesson (0120): a guarantee that attaches to an application ROLE
-- does nothing for a migration or a psql session, which run as a superuser.
-- So the rules are TRIGGERS. Their one escape is explicit and local to a
-- transaction — `SELECT set_config('oxshare.identity_maintenance', 'on', true)`
-- — for test teardown and a future retention job. A migration that sets it
-- must unset it before its file ends, because the deploy runs every pending
-- migration in ONE transaction.
--
-- Safe to run twice.

CREATE OR REPLACE FUNCTION oxshare_identity_maintenance() RETURNS boolean AS $$
  SELECT coalesce(current_setting('oxshare.identity_maintenance', true), '') = 'on';
$$ LANGUAGE sql STABLE;

-- ── Documents and the selfie, per version ──────────────────────────────────

CREATE TABLE IF NOT EXISTS client_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- `identity` | `address` | `selfie`, or a broker's own upload `other:<field key>`.
  slot         text NOT NULL,
  -- The catalogue value (`passport`, `utility_bill`, …) — checked in code
  -- (`documentTypeFor`), not here, so a catalogue edit is never a migration.
  -- NULL for the selfie and for a broker's upload.
  doc_type     text,
  -- Who supplied it. Only `client` is written today; the others are room for
  -- an external KYC tool and for an import from the old platform.
  source       text NOT NULL DEFAULT 'client',
  provider_ref text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  frozen_at    timestamptz,
  CONSTRAINT client_documents_slot_ck
    CHECK (slot IN ('identity', 'address', 'selfie') OR slot ~ '^other:[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT client_documents_source_ck CHECK (source IN ('client', 'provider', 'import')),
  CONSTRAINT client_documents_doc_type_ck CHECK (doc_type IS NULL OR doc_type ~ '^[a-z][a-z0-9_]{0,63}$')
);

-- One DRAFT per client and slot: the thing being assembled is singular.
CREATE UNIQUE INDEX IF NOT EXISTS client_documents_one_draft_uq
  ON client_documents (user_id, slot) WHERE frozen_at IS NULL;
CREATE INDEX IF NOT EXISTS client_documents_user_slot_idx
  ON client_documents (user_id, slot, created_at DESC);

CREATE TABLE IF NOT EXISTS client_document_pages (
  document_id      uuid NOT NULL REFERENCES client_documents(id) ON DELETE CASCADE,
  -- The catalogue's part index: 0 front / first page, 1 back / second page.
  part             smallint NOT NULL,
  -- `uploads/kyc/<file>` as the KYC columns hold it; the file route resolves
  -- its owner through this. NOT NULL, while `stored_object_id` may be NULL:
  -- files uploaded before `stored_objects` (0064) have no registry row.
  storage_key      text NOT NULL,
  stored_object_id uuid REFERENCES stored_objects(id) ON DELETE RESTRICT,
  file_name        text,
  added_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, part),
  CONSTRAINT client_document_pages_part_ck CHECK (part BETWEEN 0 AND 9)
);
CREATE INDEX IF NOT EXISTS client_document_pages_storage_key_idx
  ON client_document_pages (storage_key);

-- A frozen version never changes; only a draft can be deleted; freezing needs
-- at least one page — a presented document with nothing in it is no evidence.
CREATE OR REPLACE FUNCTION client_documents_guard() RETURNS trigger AS $$
BEGIN
  IF oxshare_identity_maintenance() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'client_documents: a frozen version is evidence and cannot be deleted (%).', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE
  IF OLD.frozen_at IS NOT NULL THEN
    RAISE EXCEPTION 'client_documents: a frozen version never changes (%).', OLD.id;
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.slot <> OLD.slot THEN
    RAISE EXCEPTION 'client_documents: a document keeps its client and its slot (%).', OLD.id;
  END IF;
  IF NEW.frozen_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM client_document_pages WHERE document_id = NEW.id) THEN
    RAISE EXCEPTION 'client_documents: a version with no pages cannot be frozen (%).', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS client_documents_guard_trg ON client_documents;
CREATE TRIGGER client_documents_guard_trg
  BEFORE UPDATE OR DELETE ON client_documents
  FOR EACH ROW EXECUTE FUNCTION client_documents_guard();

-- A frozen version's pages are as fixed as the version.
CREATE OR REPLACE FUNCTION client_document_pages_guard() RETURNS trigger AS $$
DECLARE
  doc uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
BEGIN
  IF oxshare_identity_maintenance() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF EXISTS (SELECT 1 FROM client_documents WHERE id = doc AND frozen_at IS NOT NULL) THEN
    RAISE EXCEPTION 'client_document_pages: the pages of a frozen version never change (%).', doc;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.document_id <> OLD.document_id THEN
    RAISE EXCEPTION 'client_document_pages: a page stays in its document.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS client_document_pages_guard_trg ON client_document_pages;
CREATE TRIGGER client_document_pages_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON client_document_pages
  FOR EACH ROW EXECUTE FUNCTION client_document_pages_guard();

-- ── Every verification decision, append-only ────────────────────────────────

CREATE TABLE IF NOT EXISTS client_verifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- 1, 2, 3 … per client: the order of their decisions, whatever the clock.
  seq            integer NOT NULL,
  outcome        text NOT NULL,
  -- The client's verification level AFTER this decision — the money gate.
  level_after    smallint NOT NULL,
  -- How it was decided. `legacy` and `fixture` mark rows recorded from the
  -- time before this log; `provider` is room for an external KYC tool.
  method         text NOT NULL,
  -- Who decided, as they were. NOT a foreign key: an admin who leaves must stay
  -- removable (`kyc_submissions.reviewed_by` says why), and `SET NULL` would be
  -- an UPDATE of history. The email keeps the row readable after they go.
  admin_id       uuid,
  admin_email    text,
  -- The configured reason chosen, if any. NOT a foreign key: `ON DELETE SET
  -- NULL` would be an UPDATE of history (refused below), so deleting a reason
  -- from the catalogue would fail. `reason` keeps the words as they were.
  reason_id      uuid,
  reason         text,
  -- What was returned: profile keys and page slots — the core's own ids.
  returned_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider       text,
  provider_ref   text,
  decided_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_verifications_seq_uq UNIQUE (user_id, seq),
  CONSTRAINT client_verifications_outcome_ck
    CHECK (outcome IN ('verified', 'returned', 'reverification_requested')),
  CONSTRAINT client_verifications_level_ck CHECK (level_after IN (0, 1)),
  CONSTRAINT client_verifications_method_ck
    CHECK (method IN ('manual_review', 'legacy', 'fixture', 'import', 'provider')),
  CONSTRAINT client_verifications_outcome_level_ck
    CHECK ((outcome = 'verified') = (level_after = 1)),
  CONSTRAINT client_verifications_returned_items_ck CHECK (jsonb_typeof(returned_items) = 'array'),
  CONSTRAINT client_verifications_provider_ck
    CHECK ((method = 'provider') = (provider IS NOT NULL AND provider_ref IS NOT NULL))
);
-- A provider's webhook re-delivered is the SAME decision: idempotent by key.
CREATE UNIQUE INDEX IF NOT EXISTS client_verifications_provider_ref_uq
  ON client_verifications (provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS client_verification_documents (
  verification_id uuid NOT NULL REFERENCES client_verifications(id) ON DELETE RESTRICT,
  document_id     uuid NOT NULL REFERENCES client_documents(id) ON DELETE RESTRICT,
  PRIMARY KEY (verification_id, document_id)
);

-- A decision is history: it is never rewritten or removed. A later decision
-- is a new row.
CREATE OR REPLACE FUNCTION client_verifications_append_only() RETURNS trigger AS $$
BEGIN
  IF oxshare_identity_maintenance() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION '%: a verification decision is history — % is forbidden. Record a new decision instead.',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS client_verifications_no_change ON client_verifications;
CREATE TRIGGER client_verifications_no_change
  BEFORE UPDATE OR DELETE ON client_verifications
  FOR EACH ROW EXECUTE FUNCTION client_verifications_append_only();
DROP TRIGGER IF EXISTS client_verification_documents_no_change ON client_verification_documents;
CREATE TRIGGER client_verification_documents_no_change
  BEFORE UPDATE OR DELETE ON client_verification_documents
  FOR EACH ROW EXECUTE FUNCTION client_verifications_append_only();

-- The same rule for the application role, as 0033 did for the ledger — the
-- trigger is what also holds for a superuser.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    REVOKE UPDATE, DELETE ON TABLE client_verifications, client_verification_documents FROM app;
  END IF;
END $$;

-- ── The KYC layer POINTS at the record (filled by the next slices) ─────────

ALTER TABLE kyc_submissions
  ADD COLUMN IF NOT EXISTS identity_document_id uuid REFERENCES client_documents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS address_document_id  uuid REFERENCES client_documents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS selfie_document_id   uuid REFERENCES client_documents(id) ON DELETE RESTRICT;

ALTER TABLE kyc_submission_attempts
  ADD COLUMN IF NOT EXISTS identity_document_id uuid REFERENCES client_documents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS address_document_id  uuid REFERENCES client_documents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS selfie_document_id   uuid REFERENCES client_documents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS verification_id      uuid REFERENCES client_verifications(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reason_id            uuid REFERENCES rejection_reasons(id) ON DELETE SET NULL,
  -- A re-verification was archived as `rejected`; this tells the two apart.
  ADD COLUMN IF NOT EXISTS reverification       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS form_snapshot        jsonb;
