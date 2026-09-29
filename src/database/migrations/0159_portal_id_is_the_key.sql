-- 0159 — THE PORTAL ID IS THE CLIENT'S KEY. The uuid is removed.
--
-- The owner's decision (28 Sep 2026, confirmed 29 Sep; D-83): a client has ONE
-- identifier, the Portal ID they are known by. Since 0133 the uuid was kept as
-- the primary key and every foreign key and hidden from every screen — two
-- identifiers for one person, one of them a secret the code had to keep. This
-- reverses the tech lead's 24 Sep ruling that the uuid stay, on the owner's
-- instruction.
--
-- After this migration `users.id` IS the Portal ID (integer, from
-- `users_id_seq`, 1,000,000 up, immutable by trigger) and every column that
-- named a client by uuid names them by it:
--   * 16 client foreign keys + the two partner-tree keys → integer, the same
--     ON DELETE RESTRICT, re-created on the new key;
--   * five columns that name an ADMIN or a CLIENT (audit actor, notification
--     recipient and subject, uploader, idempotency actor, refresh subject)
--     → text: an admin's uuid or a client's Portal ID, told apart by the row's
--     own kind column as before;
--   * stored references — audit subjects, client ids inside audit details and
--     notification params, client uuids inside refused-request lines — are
--     rewritten; the append-only guard is lifted for those statements only,
--     inside this transaction (the 0156 precedent);
--   * provider references are NOT rewritten: they are somebody else's text.
--
-- Converted IN PLACE (ALTER COLUMN … TYPE … USING), which rewrites each table
-- without firing row triggers, so append-only history converts without its
-- guards being disabled. Short-lived state bound to the old id is reset:
-- portal sessions (clients sign in again) and pending email codes (hashed with
-- the old id). Applied to an existing database it runs as one transaction: it all
-- happens or none of it does.

-- The map lives for the SESSION and is dropped at the end, never ON COMMIT DROP: on a fresh
-- database drizzle runs every migration on one connection, and 0111-0142 issue their own
-- COMMIT, after which each statement here commits on its own and an ON COMMIT DROP table
-- would vanish before the next one reads it.
CREATE TEMP TABLE pid_map (old uuid PRIMARY KEY, pid integer NOT NULL);
--> statement-breakpoint
INSERT INTO pid_map SELECT id, portal_id FROM users;
--> statement-breakpoint
CREATE FUNCTION pg_temp.pid(u uuid) RETURNS integer LANGUAGE sql STABLE AS $$ SELECT pid FROM pg_temp.pid_map WHERE old = u $$;
--> statement-breakpoint
-- A column that names an admin OR a client: a client's uuid becomes their
-- Portal ID; anything else (an admin, a purged client) keeps its uuid text.
CREATE FUNCTION pg_temp.pid_text(u uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT pid::text FROM pg_temp.pid_map WHERE old = u), u::text) $$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.rewrite_ids(j jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE k text; v jsonb; acc jsonb; found integer;
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      acc := '{}'::jsonb;
      FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
        acc := acc || jsonb_build_object(k, pg_temp.rewrite_ids(v));
      END LOOP;
      RETURN acc;
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(pg_temp.rewrite_ids(e) ORDER BY i), '[]'::jsonb)
        INTO acc FROM jsonb_array_elements(j) WITH ORDINALITY AS a(e, i);
      RETURN acc;
    WHEN 'string' THEN
      IF (j #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        found := pg_temp.pid((j #>> '{}')::uuid);
        IF found IS NOT NULL THEN RETURN to_jsonb(found); END IF;
      END IF;
      RETURN j;
    ELSE
      RETURN j;
  END CASE;
END $$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.rewrite_text(s text) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE m text; found integer; acc text := s;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  FOR m IN SELECT (regexp_matches(s, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'gi'))[1] LOOP
    found := pg_temp.pid(m::uuid);
    IF found IS NOT NULL THEN acc := replace(acc, m, found::text); END IF;
  END LOOP;
  RETURN acc;
END $$;
--> statement-breakpoint
DROP VIEW IF EXISTS identity_drift;
--> statement-breakpoint
ALTER TABLE "client_documents" DROP CONSTRAINT "client_documents_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "client_tag_assignments" DROP CONSTRAINT "client_tag_assignments_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "client_verifications" DROP CONSTRAINT "client_verifications_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "ib_accounts" DROP CONSTRAINT "ib_accounts_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "ib_accruals" DROP CONSTRAINT "ib_accruals_client_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "ib_accruals" DROP CONSTRAINT "ib_accruals_ib_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "ib_applications" DROP CONSTRAINT "ib_applications_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "ib_wallet_transfers" DROP CONSTRAINT "ib_wallet_transfers_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "kyc_submission_attempts" DROP CONSTRAINT "kyc_submission_attempts_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "kyc_submissions" DROP CONSTRAINT "kyc_submissions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "positions" DROP CONSTRAINT "positions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "stored_objects" DROP CONSTRAINT "stored_objects_owner_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "trading_accounts" DROP CONSTRAINT "trading_accounts_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "wallets" DROP CONSTRAINT "wallets_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "ib_accounts" DROP CONSTRAINT "ib_accounts_parent_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_referred_by_ib_accounts_user_id_fk";
--> statement-breakpoint
ALTER TABLE "client_documents"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "client_tag_assignments"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "client_verifications"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "ib_accounts"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id"),
  ALTER COLUMN "parent_ib_user_id" TYPE integer USING pg_temp.pid("parent_ib_user_id");
--> statement-breakpoint
ALTER TABLE "ib_accruals"
  ALTER COLUMN "client_user_id" TYPE integer USING pg_temp.pid("client_user_id"),
  ALTER COLUMN "ib_user_id" TYPE integer USING pg_temp.pid("ib_user_id");
--> statement-breakpoint
ALTER TABLE "ib_applications"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "ib_wallet_transfers"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "kyc_submission_attempts"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "kyc_submissions"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "positions"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "stored_objects"
  ALTER COLUMN "owner_user_id" TYPE integer USING pg_temp.pid("owner_user_id");
--> statement-breakpoint
ALTER TABLE "trading_accounts"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "transactions"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "transfers"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "wallets"
  ALTER COLUMN "user_id" TYPE integer USING pg_temp.pid("user_id");
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "referred_by_ib_user_id" TYPE integer USING pg_temp.pid("referred_by_ib_user_id");
--> statement-breakpoint
ALTER TABLE "audit_log"
  ALTER COLUMN "client_id" TYPE integer USING pg_temp.pid("client_id"),
  ALTER COLUMN "actor_id" TYPE text USING pg_temp.pid_text("actor_id");
--> statement-breakpoint
ALTER TABLE "notifications"
  ALTER COLUMN "subject_user_id" TYPE integer USING pg_temp.pid("subject_user_id"),
  ALTER COLUMN "recipient_id" TYPE text USING pg_temp.pid_text("recipient_id"),
  ALTER COLUMN "subject_id" TYPE text USING pg_temp.pid_text("subject_id");
--> statement-breakpoint
ALTER TABLE "stored_objects" ALTER COLUMN "uploaded_by_id" TYPE text USING pg_temp.pid_text("uploaded_by_id");
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "actor_id" TYPE text USING pg_temp.pid_text("actor_id");
--> statement-breakpoint
-- Portal sessions end: the access token's subject was the old id. Clients sign in again.
DELETE FROM "refresh_tokens" WHERE "surface" = 'portal';
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "subject_id" TYPE text USING "subject_id"::text;
--> statement-breakpoint
-- Stored references. The audit trail is append-only; its guard is lifted for
-- these three statements only, inside this transaction, and restored at once.
ALTER TABLE "audit_log" DISABLE TRIGGER audit_log_no_update;
--> statement-breakpoint
UPDATE "audit_log" SET "subject_id" = pg_temp.pid("subject_id"::uuid)::text
 WHERE "subject_type" IN ('user', 'kyc_submission', 'ib_account')
   AND "subject_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND pg_temp.pid("subject_id"::uuid) IS NOT NULL;
--> statement-breakpoint
UPDATE "audit_log" SET "subject_id" = pg_temp.rewrite_text("subject_id")
 WHERE "subject_type" = 'route' AND "subject_id" ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
--> statement-breakpoint
UPDATE "audit_log" SET "details" = pg_temp.rewrite_ids("details")
 WHERE "details" IS NOT NULL AND "details"::text ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE TRIGGER audit_log_no_update;
--> statement-breakpoint
UPDATE "notifications" SET "params" = pg_temp.rewrite_ids("params")
 WHERE "params" IS NOT NULL AND "params"::text ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
--> statement-breakpoint
UPDATE "notifications" SET "dedupe_key" = pg_temp.rewrite_text("dedupe_key")
 WHERE "dedupe_key" ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
--> statement-breakpoint
-- Pending email codes were hashed with the old id; a client mid sign-up asks for a new one.
UPDATE "users" SET "email_verification_code_hash" = NULL, "email_verification_code_expires_at" = NULL
 WHERE "email_verification_code_hash" IS NOT NULL;
--> statement-breakpoint
-- The key itself.
ALTER TABLE "users" DROP CONSTRAINT "users_pkey";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "id";
--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "portal_id" TO "id";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");
--> statement-breakpoint
DROP INDEX IF EXISTS "users_portal_id_uq";
--> statement-breakpoint
ALTER TABLE "users" RENAME CONSTRAINT "users_portal_id_positive" TO "users_id_positive";
--> statement-breakpoint
ALTER SEQUENCE "users_portal_id_seq" RENAME TO "users_id_seq";
--> statement-breakpoint
ALTER SEQUENCE "users_id_seq" OWNED BY "users"."id";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT nextval('users_id_seq');
--> statement-breakpoint
-- The keyset indexes went with the old column; the same seven, on the new key.
CREATE INDEX "users_created_at_id_idx" ON "users" ("created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "users_email_id_idx" ON "users" ("email" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "users_first_name_id_idx" ON "users" ("first_name" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "users_status_id_idx" ON "users" ("status" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "users_type_id_idx" ON "users" ("type" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "users_verification_level_id_idx" ON "users" ("verification_level" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "users_country_id_idx" ON "users" (COALESCE("country", ''::character varying) DESC, "id" DESC);
--> statement-breakpoint
-- A Portal ID never changes: it is printed on documents, typed by support and
-- carried by every foreign key. An importer writes old numbers at INSERT.
CREATE OR REPLACE FUNCTION users_id_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION 'A client''s Portal ID never changes (% cannot become %).', OLD."id", NEW."id";
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "users_id_immutable" BEFORE UPDATE OF "id" ON "users" FOR EACH ROW EXECUTE FUNCTION users_id_immutable();
--> statement-breakpoint
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "client_tag_assignments" ADD CONSTRAINT "client_tag_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "client_verifications" ADD CONSTRAINT "client_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ib_accounts" ADD CONSTRAINT "ib_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ib_accruals" ADD CONSTRAINT "ib_accruals_client_user_id_users_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ib_accruals" ADD CONSTRAINT "ib_accruals_ib_user_id_users_id_fk" FOREIGN KEY ("ib_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ib_applications" ADD CONSTRAINT "ib_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ib_wallet_transfers" ADD CONSTRAINT "ib_wallet_transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kyc_submission_attempts" ADD CONSTRAINT "kyc_submission_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "stored_objects" ADD CONSTRAINT "stored_objects_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "ib_accounts" ADD CONSTRAINT "ib_accounts_parent_fk" FOREIGN KEY ("parent_ib_user_id") REFERENCES "ib_accounts"("user_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_ib_accounts_user_id_fk" FOREIGN KEY ("referred_by_ib_user_id") REFERENCES "ib_accounts"("user_id") ON DELETE RESTRICT;
--> statement-breakpoint
-- The identity routines (0151–0153), same bodies, keyed on the Portal ID.
DROP FUNCTION IF EXISTS identity_adopt(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS identity_frozen_version(uuid, text, text, jsonb, timestamp with time zone);
--> statement-breakpoint
DROP FUNCTION IF EXISTS identity_working_version(uuid, text, text, jsonb);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.identity_frozen_version(p_user integer, p_slot text, p_doc_type text, p_pages jsonb, p_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF jsonb_array_length(p_pages) = 0 THEN
    RETURN NULL;
  END IF;
  SELECT d.id INTO v_id
    FROM client_documents d
   WHERE d.user_id = p_user AND d.slot = p_slot AND d.frozen_at IS NOT NULL
     AND d.doc_type IS NOT DISTINCT FROM p_doc_type
     AND identity_page_keys(identity_version_pages(d.id)) = identity_page_keys(p_pages)
   ORDER BY d.frozen_at, d.id
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  INSERT INTO client_documents (user_id, slot, doc_type, created_at, frozen_at)
  VALUES (p_user, p_slot, p_doc_type, p_at, p_at)
  RETURNING id INTO v_id;
  PERFORM identity_write_pages(v_id, p_pages);
  RETURN v_id;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.identity_working_version(p_user integer, p_slot text, p_doc_type text, p_pages jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_frozen uuid;
  v_draft uuid;
BEGIN
  SELECT id INTO v_draft FROM client_documents
   WHERE user_id = p_user AND slot = p_slot AND frozen_at IS NULL;

  IF jsonb_array_length(p_pages) > 0 THEN
    SELECT d.id INTO v_frozen
      FROM client_documents d
     WHERE d.user_id = p_user AND d.slot = p_slot AND d.frozen_at IS NOT NULL
       AND d.doc_type IS NOT DISTINCT FROM p_doc_type
       AND identity_page_keys(identity_version_pages(d.id)) = identity_page_keys(p_pages)
     ORDER BY d.frozen_at DESC, d.id
     LIMIT 1;
    IF v_frozen IS NOT NULL THEN
      RETURN v_frozen; -- the caller retires any stale draft
    END IF;
  ELSIF p_doc_type IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_draft IS NULL THEN
    INSERT INTO client_documents (user_id, slot, doc_type)
    VALUES (p_user, p_slot, p_doc_type)
    RETURNING id INTO v_draft;
    PERFORM identity_write_pages(v_draft, p_pages);
  ELSIF v_draft IS NOT NULL
    AND NOT (
      (SELECT doc_type FROM client_documents WHERE id = v_draft) IS NOT DISTINCT FROM p_doc_type
      AND identity_page_keys(identity_version_pages(v_draft)) = identity_page_keys(p_pages)
    ) THEN
    UPDATE client_documents SET doc_type = p_doc_type WHERE id = v_draft;
    DELETE FROM client_document_pages WHERE document_id = v_draft;
    PERFORM identity_write_pages(v_draft, p_pages);
  END IF;
  RETURN v_draft;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.identity_adopt(p_user integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_prev text := current_setting('oxshare.identity_maintenance', true);
  att record;
  sub record;
  f record;
  v_at timestamptz;
  v_identity uuid;
  v_address uuid;
  v_selfie uuid;
  v_other uuid;
  v_others uuid[];
  v_keep uuid[];
  v_verification uuid;
  v_reverification boolean;
  v_seq integer;
  v_latest smallint;
  v_level smallint;
  v_email text;
BEGIN
  PERFORM set_config('oxshare.identity_maintenance', 'on', true);

  -- One client is adopted by one transaction at a time. Every KYC path already
  -- holds this row when it calls here, so for them this is a no-op; a repair
  -- running beside live traffic (the boot check) waits for the KYC change in
  -- flight instead of racing it to the same versions. Taken FIRST, before any
  -- version is touched, which is the order the KYC paths take them in.
  PERFORM 1 FROM kyc_submissions WHERE user_id = p_user FOR NO KEY UPDATE;

  -- 1. Every archived attempt: its evidence frozen, its decision logged.
  FOR att IN
    SELECT * FROM kyc_submission_attempts WHERE user_id = p_user ORDER BY attempt_no
  LOOP
    v_at := coalesce(att.submitted_at, att.archived_at);
    v_identity := identity_frozen_version(p_user, 'identity', nullif(att.document->>'docType', ''),
                                          identity_pages('identity', att.document), v_at);
    v_address := identity_frozen_version(p_user, 'address', nullif(att.address_proof->>'docType', ''),
                                         identity_pages('address', att.address_proof), v_at);
    v_selfie := identity_frozen_version(p_user, 'selfie', NULL, identity_pages('selfie', att.selfie), v_at);
    v_others := ARRAY[]::uuid[];
    FOR f IN
      SELECT x.key, x.v
        FROM jsonb_each(coalesce(att.step_data, '{}'::jsonb)) s(slug, a),
             jsonb_each(CASE WHEN jsonb_typeof(s.a) = 'object' THEN s.a ELSE '{}'::jsonb END) x(key, v)
       WHERE jsonb_typeof(x.v) = 'object' AND x.v ? 'filePath'
    LOOP
      v_other := identity_frozen_version(p_user, identity_other_slot(f.key), NULL,
                                         identity_pages('other:x', f.v), v_at);
      IF v_other IS NOT NULL THEN
        v_others := v_others || v_other;
      END IF;
    END LOOP;

    UPDATE kyc_submission_attempts
       SET identity_document_id = v_identity,
           address_document_id = v_address,
           selfie_document_id = v_selfie
     WHERE id = att.id
       AND (identity_document_id, address_document_id, selfie_document_id)
           IS DISTINCT FROM (v_identity, v_address, v_selfie);

    IF att.verification_id IS NULL THEN
      -- A re-verification: flagged on the attempt by the code that archives it
      -- (from the dual write on), or — for history, archived as `rejected` —
      -- told apart by its audit row. The flag matters live: that audit row is
      -- written AFTER the decision commits, so an adoption inside the decision's
      -- own transaction could never see it.
      v_reverification := att.reverification OR att.status = 'rejected' AND EXISTS (
        SELECT 1 FROM audit_log a
         WHERE a.action = 'kyc.reverification_request'
           AND a.subject_id = p_user::text
           AND abs(extract(epoch FROM a.created_at - att.archived_at)) < 120);
      SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM client_verifications WHERE user_id = p_user;
      SELECT email INTO v_email FROM admins WHERE id = att.reviewed_by;
      INSERT INTO client_verifications
        (user_id, seq, outcome, level_after, method, admin_id, admin_email, reason_id, reason,
         returned_items, decided_at)
      VALUES (
        p_user, v_seq,
        CASE WHEN att.status = 'approved' THEN 'verified'
             WHEN v_reverification THEN 'reverification_requested'
             ELSE 'returned' END,
        CASE WHEN att.status = 'approved' THEN 1 ELSE 0 END,
        'manual_review', att.reviewed_by, v_email, att.reason_id, att.rejection_reason,
        CASE WHEN jsonb_typeof(att.rejected_fields) = 'array' THEN att.rejected_fields ELSE '[]'::jsonb END,
        coalesce(att.reviewed_at, att.archived_at))
      RETURNING id INTO v_verification;
      INSERT INTO client_verification_documents (verification_id, document_id)
      SELECT DISTINCT v_verification, d
        FROM unnest(ARRAY[v_identity, v_address, v_selfie] || v_others) AS d
       WHERE d IS NOT NULL
      ON CONFLICT DO NOTHING;
      UPDATE kyc_submission_attempts
         SET verification_id = v_verification, reverification = v_reverification
       WHERE id = att.id;
    END IF;
  END LOOP;

  -- 2. The live row: presented evidence frozen, work in progress a draft.
  SELECT * INTO sub FROM kyc_submissions WHERE user_id = p_user;
  IF FOUND THEN
    IF sub.status IN ('submitted', 'under_review', 'approved') THEN
      v_at := coalesce(sub.submitted_at, sub.updated_at);
      v_identity := identity_frozen_version(p_user, 'identity', nullif(sub.document->>'docType', ''),
                                            identity_pages('identity', sub.document), v_at);
      v_address := identity_frozen_version(p_user, 'address', nullif(sub.address_proof->>'docType', ''),
                                           identity_pages('address', sub.address_proof), v_at);
      v_selfie := identity_frozen_version(p_user, 'selfie', NULL, identity_pages('selfie', sub.selfie), v_at);
    ELSE
      v_identity := identity_working_version(p_user, 'identity', nullif(sub.document->>'docType', ''),
                                             identity_pages('identity', sub.document));
      v_address := identity_working_version(p_user, 'address', nullif(sub.address_proof->>'docType', ''),
                                            identity_pages('address', sub.address_proof));
      v_selfie := identity_working_version(p_user, 'selfie', NULL, identity_pages('selfie', sub.selfie));
    END IF;

    UPDATE kyc_submissions
       SET identity_document_id = v_identity,
           address_document_id = v_address,
           selfie_document_id = v_selfie
     WHERE user_id = p_user
       AND (identity_document_id, address_document_id, selfie_document_id)
           IS DISTINCT FROM (v_identity, v_address, v_selfie);

    -- A broker's uploads, the same way, one version per field.
    v_keep := ARRAY[v_identity, v_address, v_selfie];
    FOR f IN
      SELECT x.key, x.v
        FROM jsonb_each(coalesce(sub.step_data, '{}'::jsonb)) s(slug, a),
             jsonb_each(CASE WHEN jsonb_typeof(s.a) = 'object' THEN s.a ELSE '{}'::jsonb END) x(key, v)
       WHERE jsonb_typeof(x.v) = 'object' AND x.v ? 'filePath'
    LOOP
      IF sub.status IN ('submitted', 'under_review', 'approved') THEN
        v_other := identity_frozen_version(p_user, identity_other_slot(f.key), NULL,
                                           identity_pages('other:x', f.v), v_at);
      ELSE
        v_other := identity_working_version(p_user, identity_other_slot(f.key), NULL,
                                            identity_pages('other:x', f.v));
      END IF;
      v_keep := v_keep || v_other;
    END LOOP;
  ELSE
    v_keep := ARRAY[]::uuid[];
  END IF;

  -- A draft nothing points at any more is stale: the client is not working on it.
  DELETE FROM client_documents
   WHERE user_id = p_user AND frozen_at IS NULL
     AND NOT (id = ANY (array_remove(v_keep, NULL)));

  -- 3. The level always equals the latest decision.
  SELECT least(greatest(verification_level, 0), 1), email INTO v_level, v_email
    FROM users WHERE id = p_user;
  SELECT level_after INTO v_latest FROM client_verifications
   WHERE user_id = p_user ORDER BY seq DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM v_level AND NOT (v_latest IS NULL AND v_level = 0) THEN
    SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM client_verifications WHERE user_id = p_user;
    INSERT INTO client_verifications (user_id, seq, outcome, level_after, method, reason)
    VALUES (p_user, v_seq,
            CASE WHEN v_level = 1 THEN 'verified' ELSE 'returned' END,
            v_level,
            CASE WHEN v_email LIKE '%@oxshare-e2e%' THEN 'fixture' ELSE 'legacy' END,
            'Recorded from the account’s verification level when the log began (0152).');
  END IF;

  PERFORM set_config('oxshare.identity_maintenance', coalesce(v_prev, ''), true);
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.notify_notification_created()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  slim jsonb;
  payload jsonb;
  v_portal_id integer;
BEGIN
  -- 0047's routing fields — plus the Portal ID only when the row names a
  -- client, so a client row's announcement is byte-for-byte what it was.
  slim := jsonb_build_object(
    'id', NEW."id",
    'recipientKind', NEW."recipient_kind",
    'recipientId', NEW."recipient_id",
    'kind', NEW."kind"
  );
  IF NEW."subject_user_id" IS NOT NULL THEN
    -- The client's id IS their Portal ID since 0159.
    v_portal_id := NEW."subject_user_id";
    IF v_portal_id IS NOT NULL THEN
      slim := slim || jsonb_build_object('subjectPortalId', v_portal_id);
    END IF;
  END IF;

  payload := slim || jsonb_build_object('params', NEW."params");
  -- Over budget: 0061's fallback — route the event, let the toast go generic.
  IF octet_length(payload::text) > 6000 THEN
    payload := slim;
  END IF;

  PERFORM pg_notify('notification_created', payload::text);
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
-- A notification's subject names a record by uuid, or — for KYC — the client
-- by Portal ID: the column is text, and the resolver takes either.
DROP FUNCTION IF EXISTS resolve_admin_notifications(text, uuid, text, uuid, text[]);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_admin_notifications(p_subject_kind text, p_subject_id text, p_resolution text, p_resolved_by uuid, p_kinds text[] DEFAULT NULL::text[])
 RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  UPDATE "notifications"
     SET "resolved_at" = now(),
         "resolution" = left(p_resolution, 24),
         "resolved_by" = p_resolved_by
   WHERE "recipient_kind" = 'admin'
     AND "subject_kind" = p_subject_kind
     AND "subject_id" = p_subject_id
     AND "resolved_at" IS NULL
     AND (p_kinds IS NULL OR "kind" = ANY (p_kinds));
EXCEPTION WHEN OTHERS THEN
  -- Never veto the decision (0061). The row stays open — "needs action".
  RAISE WARNING 'resolve_admin_notifications(%, %) skipped: %', p_subject_kind, p_subject_id, SQLERRM;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_admin_notifications(p_subject_kind text, p_subject_id uuid, p_resolution text, p_resolved_by uuid, p_kinds text[] DEFAULT NULL::text[])
 RETURNS void LANGUAGE sql AS $$ SELECT resolve_admin_notifications(p_subject_kind, p_subject_id::text, p_resolution, p_resolved_by, p_kinds) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_admin_notifications(p_subject_kind text, p_subject_id integer, p_resolution text, p_resolved_by uuid, p_kinds text[] DEFAULT NULL::text[])
 RETURNS void LANGUAGE sql AS $$ SELECT resolve_admin_notifications(p_subject_kind, p_subject_id::text, p_resolution, p_resolved_by, p_kinds) $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS audit_log_client_of(text, text, jsonb, text, text);
--> statement-breakpoint
CREATE FUNCTION audit_log_client_of(
  p_subject_type text,
  p_subject_id text,
  p_details jsonb,
  p_actor_kind text,
  p_actor_id text
) RETURNS integer
LANGUAGE plpgsql STABLE AS $$
DECLARE
  uuid_re CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  id_re CONSTANT text := '^[1-9][0-9]{0,9}$';
  named text;
  found integer;
  segments text[];
BEGIN
  IF p_subject_type IN ('user', 'kyc_submission', 'ib_account') THEN
    -- The subject IS the client (a partner is a user too), by Portal ID.
    IF p_subject_id ~ id_re THEN RETURN p_subject_id::bigint::integer; END IF;

  ELSIF p_subject_type IN ('trading_account', 'transaction', 'wallet', 'ib_application', 'transfer') THEN
    -- `details` first (cheap, survives a deleted record), then the record's owner.
    named := COALESCE(p_details->>'clientId', p_details->>'userId');
    IF named ~ id_re THEN RETURN named::bigint::integer; END IF;
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
    IF p_subject_id ~* uuid_re THEN
      SELECT CASE WHEN a.kind = 'rebate' THEN a.client_user_id ELSE a.ib_user_id END
        INTO found FROM ib_accruals a WHERE a.id = p_subject_id::uuid;
      IF found IS NOT NULL THEN RETURN found; END IF;
    END IF;

  ELSIF p_subject_type = 'kyc_document' THEN
    SELECT d.user_id INTO found
      FROM client_document_pages p JOIN client_documents d ON d.id = p.document_id
     WHERE p.storage_key = 'uploads/kyc/' || p_subject_id LIMIT 1;
    IF found IS NULL THEN
      SELECT o.owner_user_id INTO found FROM stored_objects o
       WHERE o.bucket = 'kyc' AND o.storage_key = 'kyc/' || p_subject_id;
    END IF;
    IF found IS NOT NULL THEN RETURN found; END IF;

  ELSIF p_subject_type = 'deposit_proof' THEN
    SELECT o.owner_user_id INTO found FROM stored_objects o
     WHERE o.bucket = 'deposit-proofs' AND o.storage_key = 'deposit-proofs/' || p_subject_id;
    IF found IS NULL THEN
      SELECT t.user_id INTO found FROM transactions t WHERE t.proof_filename = p_subject_id LIMIT 1;
    END IF;
    IF found IS NOT NULL THEN RETURN found; END IF;

  ELSIF p_subject_type = 'route' THEN
    -- A refused request: a path segment that is a client's Portal ID names them.
    segments := string_to_array(split_part(split_part(p_subject_id, ' ', 2), '?', 1), '/');
    SELECT u.id INTO found FROM users u
     WHERE u.id IN (SELECT s::integer FROM unnest(segments) s WHERE s ~ '^[1-9][0-9]{0,8}$')
     LIMIT 1;
    IF found IS NOT NULL THEN RETURN found; END IF;
  END IF;

  -- A client acting concerns themselves.
  IF p_actor_kind = 'client' AND p_actor_id ~ id_re THEN RETURN p_actor_id::bigint::integer; END IF;
  RETURN NULL;
EXCEPTION WHEN numeric_value_out_of_range THEN
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE VIEW identity_drift AS  WITH live AS (
         SELECT k.user_id,
            k.document,
            k.address_proof,
            k.selfie,
            k.step_data,
            k.identity_document_id,
            k.address_document_id,
            k.selfie_document_id,
            k.status = ANY (ARRAY['submitted'::kyc_status, 'under_review'::kyc_status, 'approved'::kyc_status]) AS presented
           FROM kyc_submissions k
        ), live_documents AS (
         SELECT l.user_id,
            l.presented,
            s.slot,
                CASE s.slot
                    WHEN 'identity'::text THEN l.document
                    WHEN 'address'::text THEN l.address_proof
                    ELSE l.selfie
                END AS value,
                CASE s.slot
                    WHEN 'identity'::text THEN l.identity_document_id
                    WHEN 'address'::text THEN l.address_document_id
                    ELSE l.selfie_document_id
                END AS document_id
           FROM live l
             CROSS JOIN ( VALUES ('identity'::text), ('address'::text), ('selfie'::text)) s(slot)
        ), live_uploads AS (
         SELECT l.user_id,
            l.presented,
            identity_other_slot(x.key) AS slot,
            identity_pages('other:x'::text, x.v) AS pages
           FROM live l,
            LATERAL jsonb_each(COALESCE(l.step_data, '{}'::jsonb)) s(slug, a),
            LATERAL jsonb_each(
                CASE
                    WHEN jsonb_typeof(s.a) = 'object'::text THEN s.a
                    ELSE '{}'::jsonb
                END) x(key, v)
          WHERE jsonb_typeof(x.v) = 'object'::text AND x.v ? 'filePath'::text
        ), archived_pages AS (
         SELECT a.user_id,
            p.slot,
            e.value ->> 'key'::text AS storage_key
           FROM kyc_submission_attempts a
             CROSS JOIN LATERAL ( SELECT 'identity'::text AS slot,
                    identity_pages('identity'::text, a.document) AS pages
                UNION ALL
                 SELECT 'address'::text,
                    identity_pages('address'::text, a.address_proof) AS identity_pages
                UNION ALL
                 SELECT 'selfie'::text,
                    identity_pages('selfie'::text, a.selfie) AS identity_pages
                UNION ALL
                 SELECT identity_other_slot(x.key) AS identity_other_slot,
                    identity_pages('other:x'::text, x.v) AS identity_pages
                   FROM jsonb_each(COALESCE(a.step_data, '{}'::jsonb)) s(slug, answers),
                    LATERAL jsonb_each(
                        CASE
                            WHEN jsonb_typeof(s.answers) = 'object'::text THEN s.answers
                            ELSE '{}'::jsonb
                        END) x(key, v)
                  WHERE jsonb_typeof(x.v) = 'object'::text AND x.v ? 'filePath'::text) p
             CROSS JOIN LATERAL jsonb_array_elements(p.pages) e(value)
        )
 SELECT live_documents.user_id,
    live_documents.slot,
    'pages'::text AS problem
   FROM live_documents
  WHERE identity_page_keys(identity_pages(live_documents.slot, live_documents.value)) IS DISTINCT FROM COALESCE(identity_page_keys(identity_version_pages(live_documents.document_id)), '[]'::jsonb)
UNION ALL
 SELECT live_documents.user_id,
    live_documents.slot,
    'type'::text AS problem
   FROM live_documents
  WHERE live_documents.slot <> 'selfie'::text AND (NOT live_documents.presented OR jsonb_array_length(identity_pages(live_documents.slot, live_documents.value)) > 0) AND NULLIF(live_documents.value ->> 'docType'::text, ''::text) IS DISTINCT FROM (( SELECT d.doc_type
           FROM client_documents d
          WHERE d.id = live_documents.document_id))
UNION ALL
 SELECT l.user_id,
    l.slot,
    'not_frozen'::text AS problem
   FROM live_documents l
     JOIN client_documents d ON d.id = l.document_id
  WHERE l.presented AND d.frozen_at IS NULL
UNION ALL
 SELECT u.user_id,
    u.slot,
    'upload'::text AS problem
   FROM live_uploads u
  WHERE jsonb_array_length(u.pages) > 0 AND NOT (EXISTS ( SELECT 1
           FROM client_documents d
          WHERE d.user_id = u.user_id AND d.slot = u.slot AND (d.frozen_at IS NOT NULL OR NOT u.presented) AND identity_page_keys(identity_version_pages(d.id)) = identity_page_keys(u.pages)))
UNION ALL
 SELECT DISTINCT a.user_id,
    a.slot,
    'unrecorded_page'::text AS problem
   FROM archived_pages a
  WHERE NOT (EXISTS ( SELECT 1
           FROM client_document_pages p
             JOIN client_documents d ON d.id = p.document_id
          WHERE d.user_id = a.user_id AND d.slot = a.slot AND p.storage_key = a.storage_key))
UNION ALL
 SELECT d.user_id,
    d.slot,
    'stale_draft'::text AS problem
   FROM client_documents d
     LEFT JOIN live l ON l.user_id = d.user_id
  WHERE d.frozen_at IS NULL AND (l.user_id IS NULL OR l.presented OR
        CASE
            WHEN d.slot ~~ 'other:%'::text THEN NOT (EXISTS ( SELECT 1
               FROM live_uploads u
              WHERE u.user_id = d.user_id AND u.slot = d.slot AND jsonb_array_length(u.pages) > 0))
            ELSE d.id IS DISTINCT FROM
            CASE d.slot
                WHEN 'identity'::text THEN l.identity_document_id
                WHEN 'address'::text THEN l.address_document_id
                ELSE l.selfie_document_id
            END
        END)
UNION ALL
 SELECT kyc_submission_attempts.user_id,
    NULL::text AS slot,
    'undecided_attempt'::text AS problem
   FROM kyc_submission_attempts
  WHERE kyc_submission_attempts.verification_id IS NULL
UNION ALL
 SELECT u.id AS user_id,
    NULL::text AS slot,
    'level'::text AS problem
   FROM users u
  WHERE LEAST(GREATEST(u.verification_level, 0), 1) IS DISTINCT FROM COALESCE((( SELECT v.level_after
           FROM client_verifications v
          WHERE v.user_id = u.id
          ORDER BY v.seq DESC
         LIMIT 1))::integer, 0);
--> statement-breakpoint
-- The session's helpers go with the migration rather than with the connection, which a pool keeps.
DROP FUNCTION pg_temp.rewrite_text(text);
--> statement-breakpoint
DROP FUNCTION pg_temp.rewrite_ids(jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.pid_text(uuid);
--> statement-breakpoint
DROP FUNCTION pg_temp.pid(uuid);
--> statement-breakpoint
DROP TABLE pg_temp.pid_map;
