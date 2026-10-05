-- 0187 — the client portal's AI assistant (4 Oct 2026).
--
-- v1 answers general questions about trading, markets, MT5 and how the platform
-- works. It reads NOTHING about the client, and the model never sees who is
-- asking. These tables hold the conversations themselves, the switch an admin
-- turns it on with, and the numbers that bound what it may cost.
--
-- Three decisions live in constraints rather than in code:
--
--  * ONE QUESTION, ONE RECORD. The portal sends an id with each question and
--    reuses it on a retry; `assistant_messages_request_uq` refuses the second
--    copy, so a retry after a lost response never asks the question twice.
--  * ONE ANSWER IN FLIGHT PER CLIENT. `assistant_messages_one_streaming_uq` is a
--    partial unique index over the rows still streaming. A second send while an
--    answer is being written fails the INSERT and is answered 409. That is
--    what stops ten tabs streaming ten answers at once, and it holds across
--    instances with no lock service.
--  * USAGE IS A COUNT, NOT A COUNTER. The daily allowance is the number of
--    answers the client was given today, read from this table. No counter
--    exists to drift from what actually happened.
--  * A CLIENT'S CHATS GO WITH THE CLIENT. Both tables cascade from `users`, so
--    deleting an account (docs/scripts/purge-account.sh) leaves nothing behind.

CREATE TABLE IF NOT EXISTS "assistant_settings" (
  "id" boolean PRIMARY KEY DEFAULT true,
  "enabled" boolean NOT NULL DEFAULT false,
  "daily_message_limit" integer NOT NULL DEFAULT 30,
  "global_daily_message_limit" integer NOT NULL DEFAULT 5000,
  "updated_by" uuid,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "assistant_settings_singleton" CHECK ("id"),
  CONSTRAINT "assistant_settings_daily_limit_ck" CHECK ("daily_message_limit" BETWEEN 1 AND 1000),
  CONSTRAINT "assistant_settings_global_limit_ck" CHECK ("global_daily_message_limit" BETWEEN 1 AND 10000000)
);
--> statement-breakpoint
INSERT INTO "assistant_settings" ("id") VALUES (true) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "title" varchar(120),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_message_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_conversations_user_recent_idx"
  ON "assistant_conversations" ("user_id", "last_message_at" DESC);
--> statement-breakpoint
-- Retention prunes by last activity.
CREATE INDEX IF NOT EXISTS "assistant_conversations_last_message_idx"
  ON "assistant_conversations" ("last_message_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" uuid NOT NULL REFERENCES "assistant_conversations"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" varchar(16) NOT NULL,
  "content" text NOT NULL DEFAULT '',
  "status" varchar(16) NOT NULL DEFAULT 'complete',
  "followups" jsonb,
  "model" varchar(64),
  "input_tokens" integer,
  "cached_tokens" integer,
  "output_tokens" integer,
  "ttft_ms" integer,
  "latency_ms" integer,
  "feedback" smallint,
  "feedback_reason" varchar(32),
  "feedback_at" timestamp with time zone,
  -- The client's id for the question (one per question, reused by its retries).
  "request_id" uuid,
  -- Set when the client regenerated this answer. A separate column, not a
  -- status, so a FAILED answer stays failed (and free) after it is replaced.
  "superseded_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  CONSTRAINT "assistant_messages_role_ck" CHECK ("role" IN ('user', 'assistant')),
  CONSTRAINT "assistant_messages_status_ck" CHECK (
    "status" IN ('streaming', 'complete', 'aborted', 'failed', 'refused', 'interrupted')
  ),
  CONSTRAINT "assistant_messages_feedback_ck" CHECK ("feedback" IS NULL OR "feedback" IN (-1, 1))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assistant_messages_conversation_idx"
  ON "assistant_messages" ("conversation_id", "created_at");
--> statement-breakpoint
-- The per-client allowance: answers given to this client since midnight UTC.
CREATE INDEX IF NOT EXISTS "assistant_messages_user_answers_idx"
  ON "assistant_messages" ("user_id", "created_at") WHERE "role" = 'assistant';
--> statement-breakpoint
-- The platform-wide ceiling: every answer given since midnight UTC.
CREATE INDEX IF NOT EXISTS "assistant_messages_answers_idx"
  ON "assistant_messages" ("created_at") WHERE "role" = 'assistant';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_messages_one_streaming_uq"
  ON "assistant_messages" ("user_id") WHERE "status" = 'streaming';
--> statement-breakpoint
-- A question is recorded ONCE: a retry of a request the server already took
-- (its answer was lost on the way back) is refused, not asked again.
CREATE UNIQUE INDEX IF NOT EXISTS "assistant_messages_request_uq"
  ON "assistant_messages" ("user_id", "request_id") WHERE "request_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "scheduled_jobs" ("key", "interval_seconds")
VALUES ('assistant.prune', 86400)
ON CONFLICT ("key") DO NOTHING;
