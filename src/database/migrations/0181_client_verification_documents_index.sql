-- 0181 — client_verification_documents had only its (verification_id,
-- document_id) primary key, which cannot serve `document_id = ?`. recordOf()
-- looks up each document version's latest decision that way, and the RESTRICT
-- foreign key on document_id checks it on every document delete: both scanned
-- the whole platform-wide link table.
CREATE INDEX IF NOT EXISTS "client_verification_documents_document_idx"
  ON "client_verification_documents" ("document_id", "verification_id");
