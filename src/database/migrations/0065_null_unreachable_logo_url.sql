-- 0065 · The seeded Whish logo URL can never render — remove it.
--
-- Hand-written (see the 0040 header: snapshots stop at 0026).
--
-- 0033 seeded `payment_methods.logo_url` with a URL on Whish's marketing CDN
-- (cdn.prod.website-files.com). Both frontends serve a Content-Security-Policy
-- of `img-src 'self' data: blob:`, so that image is refused by every browser
-- that ever loads the deposit screen — the seed shipped a logo that cannot be
-- displayed anywhere, whose only observable behaviour is a CSP violation in
-- the console on each page view.
--
-- NULL rather than a replacement URL: a rail renders perfectly well without a
-- logo (the UI shows its name), and the real fix is operational — an operator
-- uploads the logo through the console, which stores it same-origin where the
-- CSP allows it. Scoped to the CDN host, not `logo_url IS NOT NULL`, so any
-- operator-uploaded logo is untouched.
UPDATE "payment_methods"
SET "logo_url" = NULL
WHERE "logo_url" LIKE 'https://cdn.prod.website-files.com/%';
--> statement-breakpoint
UPDATE "withdrawal_payment_methods"
SET "logo_url" = NULL
WHERE "logo_url" LIKE 'https://cdn.prod.website-files.com/%';
