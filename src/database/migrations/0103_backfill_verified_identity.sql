-- 0103 · backfill phone and country from APPROVED KYC submissions
--
-- Hand-written (see the 0040 header: the committed drizzle snapshots stop at
-- 0026, so drizzle-kit generate diffs against a stale baseline).
--
-- `KycService.approve` now promotes the verified phone and country from the
-- submission's `personal_info` onto the client row. Everyone approved BEFORE
-- that change still has the evidence locked in the JSONB and empty columns —
-- so an operator opening a verified client sees "—" for both, and the client
-- list's country filter (which `users_country_idx` exists to serve) matches
-- none of them.
--
-- Only APPROVED submissions are read: a claim nobody checked must not become
-- the client's record. Only EMPTY columns are written, so a value taken at
-- registration or corrected by an administrator is never overwritten by this
-- one-time repair. NULLIF(...,'') treats an empty string as absent, which is
-- what the registration form actually stores when the field is skipped.
UPDATE users u
SET
  phone   = COALESCE(NULLIF(u.phone, ''),   NULLIF(TRIM(k.personal_info ->> 'phone'), '')),
  country = COALESCE(NULLIF(u.country, ''), NULLIF(TRIM(k.personal_info ->> 'country'), ''))
FROM kyc_submissions k
WHERE k.user_id = u.id
  AND k.status = 'approved'
  AND (
    (NULLIF(u.phone, '')   IS NULL AND NULLIF(TRIM(k.personal_info ->> 'phone'), '')   IS NOT NULL)
    OR
    (NULLIF(u.country, '') IS NULL AND NULLIF(TRIM(k.personal_info ->> 'country'), '') IS NOT NULL)
  );
