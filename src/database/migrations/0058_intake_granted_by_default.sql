-- 0058 · The intake grant defaults to TRUE — restriction is the explicit act.
--
-- D-60 addendum (owner, 13 Aug 2026): giving an admin a territory must not
-- silently hide the intake pool from them — the same default-permissive stance
-- as D-10's empty-scope-means-unrestricted. A scoped admin who must NOT handle
-- new clients is the deliberate exception, expressed by unticking the grant.
--
-- Existing rows are backfilled: they were all created before the grant
-- existed, under a model where "sees intake" was not a choice anyone made, so
-- they get the new default rather than a false that was never chosen. The
-- seeded E2E Restricted fixture is re-asserted to FALSE by the seed — its
-- whole purpose is to be the provable exception.
ALTER TABLE admins ALTER COLUMN sees_untriaged SET DEFAULT true;
ALTER TABLE admin_invites ALTER COLUMN sees_untriaged SET DEFAULT true;
UPDATE admins SET sees_untriaged = true;
