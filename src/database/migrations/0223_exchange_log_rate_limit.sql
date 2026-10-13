-- 0223 — the exchange log keeps what a provider said about its request allowance (13 Oct 2026).
--
-- 3pay's server states its limits in response headers (`RateLimit-Policy`, `-Limit`,
-- `-Remaining`, `-Reset`), and they are NOT what its PDF guides print: 100 reads, 20 payment
-- links and 30 payout requests per fifteen minutes, against the guides' 60, 30 and 30 a minute
-- (its online reference agrees with the server). The adapter has followed those headers since
-- 0222's release, but nothing kept them: asked "what is production actually allowed?", the only
-- answer was a probe made by hand. The exchange log deliberately keeps no headers (they carry
-- the credentials), so these four numbers get columns of their own: the limit, what was left,
-- the seconds until the window ends, and how long the window is.
--
-- Outbound rows only, and only when the provider said something; NULL otherwise and on every
-- row written before this. Adding a nullable column rewrites nothing and fires no row trigger,
-- so the log's append-only guard (0175) is untouched.

ALTER TABLE "payment_provider_exchanges" ADD COLUMN IF NOT EXISTS "rate_limit" integer;--> statement-breakpoint
ALTER TABLE "payment_provider_exchanges" ADD COLUMN IF NOT EXISTS "rate_remaining" integer;--> statement-breakpoint
ALTER TABLE "payment_provider_exchanges" ADD COLUMN IF NOT EXISTS "rate_reset_seconds" integer;--> statement-breakpoint
ALTER TABLE "payment_provider_exchanges" ADD COLUMN IF NOT EXISTS "rate_window_seconds" integer;
