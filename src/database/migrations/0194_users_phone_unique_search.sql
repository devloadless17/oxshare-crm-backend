-- 0194 — one client per phone number, and a client found BY phone.
--
-- The buyer's demo (6 Oct 2026): staff could not search a client by phone,
-- and a phone should name one person. Every writer (sign-up, the KYC personal
-- step, the admin Edit dialog) checks first and answers 409
-- PHONE_ALREADY_REGISTERED on the field; this index decides a race. NULLs do
-- not collide, so clients without a phone are unaffected. Phones are stored
-- E.164 (0139), so one number has one spelling.
--
-- The trigram index serves `clientIdentitySearch`'s phone fragment
-- (`phone::text LIKE '%70123456%'`), so a local number typed without its
-- country code is an index read. The `::text` is the cast the predicate
-- applies to the varchar (0125's lesson).
--
-- Existing duplicates: the OLDEST holder keeps the number and every later
-- holder's phone is cleared (they are asked for one again by the KYC form).
-- Production had no clients when this shipped, so there this does nothing;
-- dev and staging databases carry hundreds of e2e sign-ups made with one fixed
-- number, which would otherwise make the index impossible to build.

UPDATE "users" AS u SET "phone" = NULL
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "phone" ORDER BY "created_at", "id") AS n
  FROM "users" WHERE "phone" IS NOT NULL
) AS d
WHERE u."id" = d."id" AND d.n > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_unique" ON "users" ("phone");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_phone_trgm_idx" ON "users" USING gin (("phone"::text) gin_trgm_ops);
