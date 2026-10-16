-- 0230 — a transfer a PERSON released records who, on the row, in the release's own transaction
-- (16 Oct 2026, audit R3-10/R2-3). The only record used to be an audit row written after the
-- commit. No FK, like `reviewed_by`: an admin's deletion must not rewrite money history.
SET lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS released_by_admin_id uuid;
