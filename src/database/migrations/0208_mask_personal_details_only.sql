-- 0208 — MASKING COVERS THE CLIENT'S PERSONAL DETAILS ONLY (owner, 7 Oct 2026)
--
-- A role could hide client tags, the registration date, the broker's extra KYC
-- answers and partner-application answers as well as personal details. Each
-- extra was a special case on screens that need it (tags drive who sees which
-- client and the list's filters), so the owner narrowed masking to personal
-- details: config/client-fields.json now LOCKS those four, with the reason.
--
-- A locked key stops being enforced the moment the catalog says so
-- (`ClientFieldsService.expand` reads maskable keys only). What this migration
-- fixes is SAVING: `assertMaskable` refuses a locked key, the editor never shows
-- one, and so a role still storing it could not be saved at all — a trap that
-- was already live for `client.payoutDestination` (locked 29 Sep 2026, never
-- stripped). Every locked key is removed from every stored mask: roles, admins'
-- personal overrides, pending invites, API keys. NULL (= follow the role) stays
-- NULL. Re-runnable.

UPDATE roles
   SET masked_fields = (
     SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb)
       FROM jsonb_array_elements_text(masked_fields) AS e(k)
      WHERE k <> ALL (ARRAY['client.createdAt', 'client.emailVerified', 'client.id', 'client.kycStatus', 'client.partnerApplication', 'client.payoutDestination', 'client.portalId', 'client.referrer', 'client.status', 'client.tags', 'client.type', 'client.verificationLevel', 'kyc.stepData']::text[])
   )
 WHERE masked_fields IS NOT NULL
   AND jsonb_typeof(masked_fields) = 'array'
   AND masked_fields ?| ARRAY['client.createdAt', 'client.emailVerified', 'client.id', 'client.kycStatus', 'client.partnerApplication', 'client.payoutDestination', 'client.portalId', 'client.referrer', 'client.status', 'client.tags', 'client.type', 'client.verificationLevel', 'kyc.stepData'];

UPDATE admins
   SET masked_fields = (
     SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb)
       FROM jsonb_array_elements_text(masked_fields) AS e(k)
      WHERE k <> ALL (ARRAY['client.createdAt', 'client.emailVerified', 'client.id', 'client.kycStatus', 'client.partnerApplication', 'client.payoutDestination', 'client.portalId', 'client.referrer', 'client.status', 'client.tags', 'client.type', 'client.verificationLevel', 'kyc.stepData']::text[])
   )
 WHERE masked_fields IS NOT NULL
   AND jsonb_typeof(masked_fields) = 'array'
   AND masked_fields ?| ARRAY['client.createdAt', 'client.emailVerified', 'client.id', 'client.kycStatus', 'client.partnerApplication', 'client.payoutDestination', 'client.portalId', 'client.referrer', 'client.status', 'client.tags', 'client.type', 'client.verificationLevel', 'kyc.stepData'];

UPDATE admin_invites
   SET masked_fields = (
     SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb)
       FROM jsonb_array_elements_text(masked_fields) AS e(k)
      WHERE k <> ALL (ARRAY['client.createdAt', 'client.emailVerified', 'client.id', 'client.kycStatus', 'client.partnerApplication', 'client.payoutDestination', 'client.portalId', 'client.referrer', 'client.status', 'client.tags', 'client.type', 'client.verificationLevel', 'kyc.stepData']::text[])
   )
 WHERE masked_fields IS NOT NULL
   AND jsonb_typeof(masked_fields) = 'array'
   AND masked_fields ?| ARRAY['client.createdAt', 'client.emailVerified', 'client.id', 'client.kycStatus', 'client.partnerApplication', 'client.payoutDestination', 'client.portalId', 'client.referrer', 'client.status', 'client.tags', 'client.type', 'client.verificationLevel', 'kyc.stepData'];

UPDATE api_keys
   SET masked_fields = (
     SELECT COALESCE(jsonb_agg(k ORDER BY k), '[]'::jsonb)
       FROM jsonb_array_elements_text(masked_fields) AS e(k)
      WHERE k <> ALL (ARRAY['client.createdAt', 'client.emailVerified', 'client.id', 'client.kycStatus', 'client.partnerApplication', 'client.payoutDestination', 'client.portalId', 'client.referrer', 'client.status', 'client.tags', 'client.type', 'client.verificationLevel', 'kyc.stepData']::text[])
   )
 WHERE masked_fields IS NOT NULL
   AND jsonb_typeof(masked_fields) = 'array'
   AND masked_fields ?| ARRAY['client.createdAt', 'client.emailVerified', 'client.id', 'client.kycStatus', 'client.partnerApplication', 'client.payoutDestination', 'client.portalId', 'client.referrer', 'client.status', 'client.tags', 'client.type', 'client.verificationLevel', 'kyc.stepData'];
