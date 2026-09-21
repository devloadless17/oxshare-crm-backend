-- Every wallet carries a NAME: "USD Wallet", "Commission Wallet".
--
-- The wallets list showed a bare currency code beside an amount, so a partner
-- holding a main USD wallet and a commission USD wallet saw two cards reading
-- "USD" with different balances and nothing on either saying which was which.
-- The kind was on the wire the whole time; nothing rendered it.
--
-- ## GENERATED, not written by the application
--
-- Three separate paths insert wallets: `getOrCreateWallet`, `lockWallet`, and
-- the set-based `openForAllClients` backfill that no application generator can
-- reach (which is exactly why `wallet_number` is a column DEFAULT rather than
-- application code). A plain column would need all three to remember, and the
-- one that forgot would produce a nameless wallet nobody notices until it is on
-- a client's screen.
--
-- Generated means the database answers for it. Every existing row is named the
-- moment this runs, every future insert is named whatever wrote it, and the
-- name cannot drift from the currency and kind it describes — which is the
-- failure a stored copy invites the day a wallet's kind changes.
--
-- ## Why STORED and not a view
--
-- It is selected on the hot wallet list and sorted on in the admin console.
-- A generated column is materialised, so those reads cost nothing extra; a view
-- or a per-query expression would recompute it for every row of every list.
--
-- ## The English is deliberate, and it is not the display string
--
-- This is the CANONICAL name — what an operator greps for, what a support
-- ticket quotes, what a CSV export carries. The apps still translate for
-- display (Arabic is a supported locale, FSD §10), so a client reading Arabic
-- sees an Arabic label built from `currency` and `kind`. Storing a translated
-- name would freeze one language into the database and make the column wrong
-- for every other reader.
ALTER TABLE "wallets"
  ADD COLUMN "name" varchar(60) GENERATED ALWAYS AS (
    CASE "kind"
      WHEN 'commission' THEN 'Commission Wallet'
      ELSE "currency" || ' Wallet'
    END
  ) STORED;
