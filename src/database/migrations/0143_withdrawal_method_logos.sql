-- ============================================================================
-- Withdrawal methods get the logo their deposit twin already has
-- ============================================================================
--
-- The withdrawal list (`withdrawal_payment_methods`, 0062) was seeded with a
-- key and a name only — Whish went in with no logo, while the deposit Whish
-- row carries the one an operator uploaded. With the Withdrawal methods screen
-- now in the console, the two lists sit side by side and the withdrawal one
-- read as missing its logos.
--
-- So: a withdrawal method with NO logo takes the logo of the deposit method
-- with the SAME key, when that one has one. Both tables accept the same URLs
-- (the shared upload under /v1/uploads/payment-logos/), so the value is valid
-- as it stands.
--
-- Only fills a gap. A withdrawal method that already has a logo is never
-- touched, and re-running this changes nothing once every gap is filled.

UPDATE withdrawal_payment_methods AS w
   SET logo_url = d.logo_url,
       updated_at = now()
  FROM payment_methods AS d
 WHERE d.key = w.key
   AND w.logo_url IS NULL
   AND d.logo_url IS NOT NULL;
