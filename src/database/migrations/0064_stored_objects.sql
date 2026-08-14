-- A registry of every file this system stores.
--
-- Hand-written rather than generated, matching 0027 onwards.
--
-- ── The question this exists to answer ──────────────────────────────────────
--
-- "Who uploaded this document, when, how big was it, and is it still ours?"
--
-- Until now there was no answer. File references are free-text values buried
-- inside JSONB blobs (`kyc_submissions.document -> 'frontFilePath'`), avatars and
-- payment logos store a bare filename on their owning row, and nothing anywhere
-- records the act of uploading. The only reverse lookup — "which client owns this
-- filename" — was an unindexed `::text ILIKE '%name%'` scan across three JSONB
-- columns in `kyc.store.ts`, which works and is not a record of anything.
--
-- On a system holding identity documents for a regulated broker, that question
-- gets asked under pressure: during a compliance review, after a support ticket,
-- or when somebody has to prove what the business held and when. It needs to be a
-- query.
--
-- ── This table does NOT replace the existing references ─────────────────────
--
-- The JSONB values stay exactly as they are, and `users.avatar_filename` /
-- `payment_methods.logo_url` stay as they are. This is additive: it records
-- objects, it does not own the association between a document and the submission
-- that uses it. Rewriting those references would have meant a data migration over
-- the compliance record for no benefit that this table does not already provide.
--
-- So a row here is evidence about an OBJECT, and the JSONB is the CLAIM about
-- which object a submission is made of. They are cross-checked by
-- `scripts/r2-reconcile.mjs`, in both directions.
--
-- ── Rows outlive the bytes, deliberately ────────────────────────────────────
--
-- `deleted_at` is a soft delete. When a client replaces a rejected passport scan
-- the object goes, and the record that it once existed must not — "what did the
-- document we refused look like" is exactly the question `kyc_submission_attempts`
-- was added to preserve, and a hard DELETE here would reopen the hole from the
-- other side.

CREATE TABLE IF NOT EXISTS "stored_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which logical bucket: 'kyc', 'avatars', 'payment-logos'. Matches
  -- `FileBucket.dir` in common/uploads/stored-files.service.ts, which is also the
  -- object-key prefix and the disk subdirectory — one name, three uses, mirrored
  -- on purpose (see common/uploads/storage/storage-key.ts).
  "bucket" varchar(32) NOT NULL,

  -- The provider key, e.g. 'kyc/9f2c….jpg'. Not a URL: the bucket is private and
  -- no URL to it is ever emitted. Serving goes through the authenticated
  -- controller, which builds this key from the requested filename.
  "storage_key" varchar(512) NOT NULL,

  -- 'r2' or 'disk'. Recorded per object rather than read from configuration
  -- because both are live at once: files uploaded before the R2 move are still on
  -- local disk and are still served, with no backfill migration. This column is
  -- what tells the reconciliation sweep which store to look in.
  "provider" varchar(16) NOT NULL,

  -- The SNIFFED type, decided from the file's own magic bytes at upload — never
  -- the uploader's multipart Content-Type. That header is a claim, and an HTML
  -- document declared image/png is how a stored file becomes stored XSS.
  "content_type" varchar(128) NOT NULL,

  "byte_size" bigint NOT NULL,

  -- Lowercase hex SHA-256 of the bytes, computed before upload and sent to R2 as
  -- an integrity checksum, so a transfer corrupted in flight is refused rather
  -- than accepted and served later as a damaged passport scan.
  --
  -- It is NOT a deduplication key. Two clients uploading identical bytes get two
  -- objects, deliberately: sharing one would mean deleting one client's document
  -- deletes another's, and it would leak that two accounts hold the same file.
  -- Indexed for DETECTION — "has this exact file been uploaded before" is a
  -- fraud-review question — never for collapsing storage.
  "sha256" char(64) NOT NULL,

  -- What the uploader called it. Display only, and never used to build a path or
  -- an extension: the stored name is a UUID chosen by this system.
  "original_name" varchar(255),

  -- The client the object is ABOUT. Nullable because payment-method logos are
  -- brand marks belonging to nobody.
  --
  -- RESTRICT, matching `kyc_submissions`: a DELETE FROM users must fail loudly
  -- rather than silently discard the record of what that client uploaded.
  -- Deleting a client is a deliberate act with a retention policy attached
  -- (PLATFORM-CONVENTIONS 12.9), not a side effect.
  "owner_user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,

  -- The actor who performed the upload, and which surface they were on. Kept as a
  -- bare id + kind rather than two nullable foreign keys because clients and
  -- admins live in different tables and the same shape is already used by
  -- `audit_log.actor_kind`.
  "uploaded_by_id" uuid NOT NULL,
  "uploaded_by_kind" varchar(16) NOT NULL,

  "created_at" timestamptz NOT NULL DEFAULT now(),

  -- Soft. Set when the bytes are removed; the row stays. See the note above.
  "deleted_at" timestamptz
);

-- Idempotency in a DATABASE CONSTRAINT, never check-then-insert (ARCHITECTURE
-- §6.3). A replayed upload — a retried request, a double-clicked form — collides
-- here instead of quietly writing a second row for one object.
CREATE UNIQUE INDEX IF NOT EXISTS "stored_objects_bucket_key_uq"
  ON "stored_objects" ("bucket", "storage_key");

-- The quota query: SUM(byte_size) for one client's live objects. Partial, because
-- soft-deleted rows must not count toward a ceiling — a client who replaced a
-- rejected document three times has not used four documents' worth of quota.
CREATE INDEX IF NOT EXISTS "stored_objects_owner_live_idx"
  ON "stored_objects" ("owner_user_id")
  WHERE "deleted_at" IS NULL;

-- Retention sweeps and the reconciliation report, both of which walk by age.
CREATE INDEX IF NOT EXISTS "stored_objects_created_at_idx"
  ON "stored_objects" ("created_at" DESC);

-- Duplicate DETECTION only — see the column note.
CREATE INDEX IF NOT EXISTS "stored_objects_sha256_idx"
  ON "stored_objects" ("sha256");

-- "Which client owns this filename", the lookup that used to be an ILIKE scan
-- across three JSONB columns. `storage_key` alone is covered by the unique index
-- above, but the authorization path in uploads.controller.ts asks by FILENAME
-- without knowing the bucket, so it matches on the key's suffix.
CREATE INDEX IF NOT EXISTS "stored_objects_key_idx"
  ON "stored_objects" ("storage_key");
