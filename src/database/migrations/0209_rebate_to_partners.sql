-- 0209 — the rebate is PARTNER money (owner, 7 Oct 2026).
--
-- A commission type's `rebate_per_lot` used to be paid back to the TRADING
-- CLIENT, at the introducer's rebate share, into the client's main wallet. It
-- is now split down the partner chain exactly like commission (a sub-partner
-- takes their rebate share, level 1 takes the rest) and paid to each partner's
-- COMMISSION wallet. The client receives nothing.
--
-- `paid_to_client` marks ONLY rebates whose money already reached a client —
-- confirmed (paid) or reversed — so a reversal takes it back from the client's
-- main wallet it actually went to. Nothing new is ever paid to a client: a
-- rebate still PENDING here is the partner's like every new one (false), and
-- is credited to the introducing partner's commission wallet.

ALTER TABLE "ib_accruals" ADD COLUMN IF NOT EXISTS "paid_to_client" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "ib_accruals" SET "paid_to_client" = true
 WHERE "kind" = 'rebate' AND "status" IN ('confirmed', 'reversed') AND NOT "paid_to_client";
