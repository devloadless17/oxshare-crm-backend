-- Who introduced this client.
--
-- The partner programme has generated referral links since the portal's
-- /partner screen shipped — `${portal}/auth/register?ref=CODE` — and the admin
-- copies the same URL from the partners list. Nothing read the parameter, so
-- every client who followed one arrived unattributed and the code was silently
-- discarded. This is the column that catches it.
--
-- ── A column, not a table ───────────────────────────────────────────────────
--
-- The deleted `referral_attributions` carried `UNIQUE(client_user_id)` because
-- attribution is one partner per client (§6.3). A unique index over a table
-- whose every row is one-to-one with `users` is a join standing in for a
-- column, so this is a column.
--
-- ── Permanent by construction ───────────────────────────────────────────────
--
-- Written once at registration and never rewritten. A partner is paid on the
-- activity of clients attributed to them, so anything that could move this
-- value could move one partner's earnings to another. Nothing in the partner
-- surface offers to change it, and this migration adds no path that does.
--
-- ── RESTRICT, like every other reference to a person ────────────────────────
--
-- A partner with attributed clients cannot be deleted out from under them. That
-- matches `ib_accounts` itself, which has no delete route at all: suspension
-- keeps the code and the tree, because removing the row would orphan everybody
-- beneath it. The same reasoning applies one level further out, to the clients.

ALTER TABLE "users" ADD COLUMN "referred_by_ib_user_id" uuid;--> statement-breakpoint

ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_ib_accounts_user_id_fk"
	FOREIGN KEY ("referred_by_ib_user_id") REFERENCES "public"."ib_accounts"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- "Which clients did this partner introduce?" — asked per partner by every
-- commission calculation the engine will eventually run, and by the partner's
-- own portal screen once it reports anything.
CREATE INDEX "users_referred_by_idx" ON "users" ("referred_by_ib_user_id");
