-- 0179 — THE CLIENT PORTAL SPEAKS ARABIC (2 Oct 2026).
--
-- The portal gains Arabic (RTL) beside English. Its own strings live in the
-- portal's catalogue; what THIS migration adds is the Arabic for text an
-- OPERATOR writes and a client reads, plus the one fact the server needs to
-- write in the client's language on its own: the language itself.
--
-- 1. `users.locale` — 'en' | 'ar'. The portal sets it when the client switches
--    language (`PUT /profile/locale`) and at registration. Read by what the
--    server writes WITHOUT a request in hand — an email about a KYC decision,
--    a paid withdrawal. Anything answering a request uses the request's own
--    `X-OxShare-Locale` instead. Defaults to English: every existing client
--    has only ever read English.
--
-- 2. An Arabic twin, NULLABLE, beside every operator-authored text a client
--    reads. NULL (or blank) means "not translated" and the portal shows the
--    English — an untranslated name is still a name, while an empty label is
--    a broken screen. None of these columns is required, so no admin form
--    breaks and nothing has to be backfilled before the deploy.
--
--    kyc_config_steps     title_ar, description_ar   (a field's own Arabic —
--                         label, hint, choices — lives in its `fields` JSON)
--    rejection_reasons    label_ar
--    external_links       title_ar, description_ar
--    payment_methods      name_ar   (proof fields: labelAr/hintAr in JSON)
--    withdrawal_payment_methods  name_ar
--    trading_products     name_ar
--    agencies             name_ar, description_ar
--    currencies           name_ar
--
-- 3. The SEEDED rejection reasons get their Arabic here, matched on the exact
--    seeded wording. A reason an operator has since reworded keeps its NULL
--    and shows English until somebody writes the Arabic.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locale" varchar(5) NOT NULL DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_locale_ck";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale_ck" CHECK ("locale" IN ('en', 'ar'));--> statement-breakpoint

ALTER TABLE "kyc_config_steps"
  ADD COLUMN IF NOT EXISTS "title_ar" varchar(200),
  ADD COLUMN IF NOT EXISTS "description_ar" text;--> statement-breakpoint
ALTER TABLE "rejection_reasons" ADD COLUMN IF NOT EXISTS "label_ar" varchar(500);--> statement-breakpoint
ALTER TABLE "external_links"
  ADD COLUMN IF NOT EXISTS "title_ar" varchar(80),
  ADD COLUMN IF NOT EXISTS "description_ar" varchar(300);--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN IF NOT EXISTS "name_ar" varchar(80);--> statement-breakpoint
ALTER TABLE "withdrawal_payment_methods" ADD COLUMN IF NOT EXISTS "name_ar" varchar(80);--> statement-breakpoint
ALTER TABLE "trading_products" ADD COLUMN IF NOT EXISTS "name_ar" varchar(80);--> statement-breakpoint
ALTER TABLE "agencies"
  ADD COLUMN IF NOT EXISTS "name_ar" varchar(80),
  ADD COLUMN IF NOT EXISTS "description_ar" text;--> statement-breakpoint
ALTER TABLE "currencies" ADD COLUMN IF NOT EXISTS "name_ar" varchar(80);--> statement-breakpoint

UPDATE "rejection_reasons" AS r SET "label_ar" = v.ar
FROM (VALUES
  ('kyc', 'Identity document is blurry or unreadable', 'وثيقة الهوية غير واضحة أو غير مقروءة'),
  ('kyc', 'Identity document is expired', 'وثيقة الهوية منتهية الصلاحية'),
  ('kyc', 'Selfie does not match the identity document', 'الصورة الشخصية لا تطابق وثيقة الهوية'),
  ('kyc', 'Proof of address is older than 3 months', 'إثبات العنوان أقدم من 3 أشهر'),
  ('kyc', 'Proof of address does not match the declared address', 'إثبات العنوان لا يطابق العنوان المُصرَّح به'),
  ('kyc', 'Personal information does not match the documents', 'المعلومات الشخصية لا تطابق الوثائق'),
  ('kyc', 'Document appears altered or tampered with', 'يبدو أن الوثيقة معدَّلة أو تم التلاعب بها'),
  ('withdrawal', 'Beneficiary details do not match the account holder', 'بيانات المستفيد لا تطابق صاحب الحساب'),
  ('withdrawal', 'Insufficient verified balance', 'الرصيد الموثَّق غير كافٍ'),
  ('withdrawal', 'Account verification (KYC) incomplete', 'التحقق من هوية الحساب غير مكتمل'),
  ('withdrawal', 'Suspicious activity — additional verification required', 'نشاط مشبوه — يلزم تحقق إضافي'),
  ('partner', 'Insufficient trading or introducing experience', 'خبرة غير كافية في التداول أو في إحالة العملاء'),
  ('partner', 'Introducing volume does not meet the programme minimum', 'حجم الإحالات لا يبلغ الحد الأدنى للبرنامج'),
  ('partner', 'Unable to verify the website or business details provided', 'تعذّر التحقق من الموقع الإلكتروني أو بيانات النشاط التجاري المقدَّمة'),
  ('partner', 'Application is incomplete or unclear', 'الطلب غير مكتمل أو غير واضح'),
  ('partner', 'Does not meet the eligibility criteria for this programme', 'لا يستوفي شروط الأهلية لهذا البرنامج'),
  ('deposit', 'The receipt is unreadable — please send a clearer photo', 'الإيصال غير مقروء — يُرجى إرسال صورة أوضح'),
  ('deposit', 'The amount on the receipt does not match the amount requested', 'المبلغ الوارد في الإيصال لا يطابق المبلغ المطلوب'),
  ('deposit', 'No payment matching this receipt has reached our account', 'لم تصل إلى حسابنا أي دفعة مطابقة لهذا الإيصال'),
  ('deposit', 'The receipt is for a different transfer we have already credited', 'الإيصال يخص تحويلاً آخر سبق أن أضفناه إلى رصيدك'),
  ('deposit', 'The receipt does not show who sent the payment', 'الإيصال لا يُظهر اسم مُرسِل الدفعة')
) AS v(context, en, ar)
WHERE r."context"::text = v.context AND r."label" = v.en AND r."label_ar" IS NULL;--> statement-breakpoint

-- 4. THE REMAINING ARABIC GAPS (3 Oct 2026).
--
--    a. A product's DESCRIPTION, beside its name.
--    b. A reason a REVIEWER WRITES is copied onto the record with the decision
--       — the English as before, and now its Arabic beside it (`*_ar`): the
--       reviewer's own Arabic when they gave one, else the configured reason's
--       Arabic as it read AT THE DECISION (a later edit of the catalogue must not
--       change what a client was told). NULL = no Arabic; the reader falls back
--       to the catalogue lookup on read, then to the English.
--         kyc_submissions.rejection_reason_ar, kyc_submission_attempts.rejection_reason_ar,
--         client_verifications.reason_ar (copied by identity_record_decision),
--         transactions.rejection_reason_ar, ib_applications.rejection_reason_ar,
--         transfers.failure_reason_ar
--    c. Every currency the platform commonly holds gets its Arabic name, and
--       the two built-in products theirs — only where nobody has written one.

ALTER TABLE "trading_products" ADD COLUMN IF NOT EXISTS "description_ar" text;--> statement-breakpoint
ALTER TABLE "kyc_submissions" ADD COLUMN IF NOT EXISTS "rejection_reason_ar" text;--> statement-breakpoint
ALTER TABLE "kyc_submission_attempts" ADD COLUMN IF NOT EXISTS "rejection_reason_ar" text;--> statement-breakpoint
ALTER TABLE "client_verifications" ADD COLUMN IF NOT EXISTS "reason_ar" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "rejection_reason_ar" text;--> statement-breakpoint
ALTER TABLE "ib_applications" ADD COLUMN IF NOT EXISTS "rejection_reason_ar" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN IF NOT EXISTS "failure_reason_ar" text;--> statement-breakpoint

-- The decision log copies the attempt's Arabic too (0171's function, plus reason_ar).
CREATE OR REPLACE FUNCTION identity_record_decision(p_attempt uuid) RETURNS uuid AS $$
DECLARE
  v_prev text := current_setting('oxshare.identity_maintenance', true);
  att record;
  f record;
  v_at timestamptz;
  v_ids uuid[];
  v_frozen uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_other uuid;
  v_verification uuid;
  v_seq integer;
  v_email text;
BEGIN
  SELECT * INTO att FROM kyc_submission_attempts WHERE id = p_attempt;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF att.verification_id IS NOT NULL THEN
    RETURN att.verification_id; -- decided once; a replay is a no-op
  END IF;
  PERFORM set_config('oxshare.identity_maintenance', 'on', true);
  v_at := coalesce(att.submitted_at, att.archived_at);

  v_ids := ARRAY[att.identity_document_id, att.address_document_id, att.selfie_document_id];
  FOREACH v_id IN ARRAY v_ids LOOP
    IF v_id IS NOT NULL AND EXISTS (SELECT 1 FROM client_documents WHERE id = v_id AND frozen_at IS NULL) THEN
      SELECT identity_frozen_version(d.user_id, d.slot, d.doc_type, identity_version_pages(d.id), v_at)
        INTO v_id FROM client_documents d WHERE d.id = v_id;
    END IF;
    v_frozen := v_frozen || v_id;
  END LOOP;

  UPDATE kyc_submission_attempts
     SET identity_document_id = v_frozen[1],
         address_document_id = v_frozen[2],
         selfie_document_id = v_frozen[3]
   WHERE id = att.id
     AND (identity_document_id, address_document_id, selfie_document_id)
         IS DISTINCT FROM (v_frozen[1], v_frozen[2], v_frozen[3]);

  -- The broker's uploads the attempt answered, frozen as it presented them.
  FOR f IN
    SELECT x.key, x.v
      FROM jsonb_each(coalesce(att.step_data, '{}'::jsonb)) s(slug, a),
           jsonb_each(CASE WHEN jsonb_typeof(s.a) = 'object' THEN s.a ELSE '{}'::jsonb END) x(key, v)
     WHERE jsonb_typeof(x.v) = 'object' AND x.v ? 'filePath'
  LOOP
    v_other := identity_frozen_version(att.user_id, identity_other_slot(f.key), NULL,
                                       identity_pages('other:x', f.v), v_at);
    IF v_other IS NOT NULL THEN
      v_frozen := v_frozen || v_other;
    END IF;
  END LOOP;

  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM client_verifications WHERE user_id = att.user_id;
  SELECT email INTO v_email FROM admins WHERE id = att.reviewed_by;
  INSERT INTO client_verifications
    (user_id, seq, outcome, level_after, method, admin_id, admin_email, reason_id, reason,
     reason_ar, returned_items, decided_at)
  VALUES (
    att.user_id, v_seq,
    CASE WHEN att.status = 'approved' THEN 'verified'
         WHEN att.reverification THEN 'reverification_requested'
         ELSE 'returned' END,
    CASE WHEN att.status = 'approved' THEN 1 ELSE 0 END,
    'manual_review', att.reviewed_by, v_email, att.reason_id, att.rejection_reason,
    att.rejection_reason_ar,
    CASE WHEN jsonb_typeof(att.rejected_fields) = 'array' THEN att.rejected_fields ELSE '[]'::jsonb END,
    coalesce(att.reviewed_at, att.archived_at))
  RETURNING id INTO v_verification;
  INSERT INTO client_verification_documents (verification_id, document_id)
  SELECT DISTINCT v_verification, d FROM unnest(v_frozen) AS d WHERE d IS NOT NULL
  ON CONFLICT DO NOTHING;
  UPDATE kyc_submission_attempts SET verification_id = v_verification WHERE id = att.id;

  PERFORM set_config('oxshare.identity_maintenance', coalesce(v_prev, ''), true);
  RETURN v_verification;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

UPDATE "currencies" AS c SET "name_ar" = v.ar
FROM (VALUES
  ('USD', 'دولار أمريكي'), ('EUR', 'يورو'), ('GBP', 'جنيه إسترليني'), ('USDT', 'تيثر (USDT)'),
  ('USDC', 'USD Coin (USDC)'), ('AED', 'درهم إماراتي'), ('SAR', 'ريال سعودي'),
  ('LBP', 'ليرة لبنانية'), ('JPY', 'ين ياباني'), ('CHF', 'فرنك سويسري'), ('CAD', 'دولار كندي'),
  ('AUD', 'دولار أسترالي'), ('NZD', 'دولار نيوزيلندي'), ('CNY', 'يوان صيني'),
  ('BTC', 'بيتكوين'), ('ETH', 'إيثريوم'), ('KWD', 'دينار كويتي'), ('QAR', 'ريال قطري'),
  ('BHD', 'دينار بحريني'), ('OMR', 'ريال عماني'), ('JOD', 'دينار أردني'), ('EGP', 'جنيه مصري'),
  ('TRY', 'ليرة تركية'), ('IQD', 'دينار عراقي'), ('SYP', 'ليرة سورية'), ('MAD', 'درهم مغربي'),
  ('TND', 'دينار تونسي'), ('DZD', 'دينار جزائري'), ('LYD', 'دينار ليبي'), ('INR', 'روبية هندية'),
  ('RUB', 'روبل روسي'), ('XAU', 'ذهب'), ('XAG', 'فضة')
) AS v(code, ar)
WHERE c."code" = v.code AND c."name_ar" IS NULL;--> statement-breakpoint

UPDATE "trading_products" SET "name_ar" = 'تجريبي'
WHERE "name" = 'Demo' AND "name_ar" IS NULL;--> statement-breakpoint
UPDATE "trading_products" SET "description_ar" = 'حسابات تدريبية بأموال افتراضية. المنتج التجريبي الوحيد — متاح لكل عميل بصرف النظر عن الوكالة.'
WHERE "description" = 'Practice accounts on virtual funds. The single demo product — offered to every client regardless of agency.'
  AND "description_ar" IS NULL;--> statement-breakpoint
UPDATE "trading_products" SET "name_ar" = 'قياسي'
WHERE "name" = 'Standard' AND "name_ar" IS NULL;
