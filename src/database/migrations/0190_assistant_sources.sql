-- 0190 — an assistant answer records the web pages it cited (5 Oct 2026).
--
-- The assistant now searches the web for current prices and news (OpenAI's
-- hosted web search). Each answer keeps the pages it cited, shown to the client
-- under it and again when the chat is reopened, and how many searches it ran:
-- every search is billed, so the admin card sums them beside the tokens.
--
-- A deleted chat blanks `sources` with the words (0188): a list of pages says
-- what was asked about. Additive: the previous build ignores both columns.

ALTER TABLE "assistant_messages" ADD COLUMN IF NOT EXISTS "sources" jsonb;
--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN IF NOT EXISTS "web_searches" smallint;
