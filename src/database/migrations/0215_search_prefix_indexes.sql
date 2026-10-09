-- One index lookup per client search at any size (9 Oct 2026).
--
--  * reverse(phone) — a local number typed without its country code is the END
--    of the stored E.164, so its reverse is a PREFIX: one btree range, where the
--    old `%digits%` infix grew with the table.
--  * lower(email|first_name|last_name) — one- and two-letter searches, which a
--    trigram index cannot serve, become three prefix ranges.
-- text_pattern_ops so LIKE 'x%' uses the index whatever the database collation.
-- On a table that is already large, build these by hand first with
-- CREATE INDEX CONCURRENTLY under the same names; IF NOT EXISTS then skips them.

CREATE INDEX IF NOT EXISTS "users_phone_reverse_idx"
  ON "users" ((reverse("phone"::text)) text_pattern_ops);

CREATE INDEX IF NOT EXISTS "users_email_lower_prefix_idx"
  ON "users" ((lower("email")) text_pattern_ops);

CREATE INDEX IF NOT EXISTS "users_first_name_lower_prefix_idx"
  ON "users" ((lower("first_name")) text_pattern_ops);

CREATE INDEX IF NOT EXISTS "users_last_name_lower_prefix_idx"
  ON "users" ((lower("last_name")) text_pattern_ops);
