-- 0188 — a deleted assistant chat keeps its rows, with the words erased (5 Oct 2026).
--
-- 0187 deleted a chat for good, and every allowance (the per-minute limit, the
-- daily limit, the platform ceiling) is a COUNT over those same rows. So a client
-- reset all three by deleting their chats, and deleting one mid-answer freed the
-- one-answer-at-a-time index while the model call ran on, recorded nowhere.
--
-- Now a client's delete stamps `deleted_at` and erases what was SAID (the title,
-- every message's content, follow-ups and feedback reasons). What was USED stays:
-- the rows, their status and their tokens, so every count is still true. The
-- streaming row stays streaming, so the index still holds. The retention job
-- removes a deleted chat two days later, when no daily window can still see it.
--
-- Additive: the previous build ignores the column and still runs.

ALTER TABLE "assistant_conversations" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
