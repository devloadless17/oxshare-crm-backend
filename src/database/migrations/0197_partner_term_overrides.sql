-- 0197 — PER-SUB-PARTNER COMMISSION AND REBATE, AND A TWO-LEVEL TREE (6 Oct 2026).
--
-- The owner's rules:
--   * A level 1 partner earns 100% of the product's commission on their OWN
--     clients, and on a sub-partner's clients whatever the sub-partner does
--     not take (100 - the sub-partner's share). Level 1's own share on the
--     ladder no longer decides anything.
--   * A sub-partner (level 2) earns level 2's share by default (30%), or a
--     percentage set for them alone — the override below.
--   * The rebate a sub-partner's clients get back is level 2's rebate share,
--     or a percentage set for that sub-partner alone. It goes to the CLIENTS.
--   * The tree is at most two levels deep; enforced in the application.
--
-- ib_accounts.commission_share_override  NULL = the level's share.
-- ib_accounts.rebate_share_override      NULL = the level's rebate share.
-- Both are percentages, 0..100, numeric(12,4) like the ladder's.
--
-- RE-LEVELLED BY POSITION. From here on the level is what decides which side
-- of the split a partner is paid on (level 1 takes the rest), so a partner
-- standing under another but still labelled level 1 — which the old "change
-- level" control allowed — would be paid as a main partner and leave their
-- real main partner nothing. No parent → 1; a parent who has none → 2. Rows
-- deeper than that (a third tier from before the cap) are left as they are and
-- earn on their own rung, if one exists.
--
-- Idempotent; no transaction scope assumed.

ALTER TABLE ib_accounts ADD COLUMN IF NOT EXISTS commission_share_override numeric(12,4);
--> statement-breakpoint
ALTER TABLE ib_accounts ADD COLUMN IF NOT EXISTS rebate_share_override numeric(12,4);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ib_accounts_commission_override_range') THEN
    ALTER TABLE ib_accounts ADD CONSTRAINT ib_accounts_commission_override_range
      CHECK (commission_share_override IS NULL OR commission_share_override BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ib_accounts_rebate_override_range') THEN
    ALTER TABLE ib_accounts ADD CONSTRAINT ib_accounts_rebate_override_range
      CHECK (rebate_share_override IS NULL OR rebate_share_override BETWEEN 0 AND 100);
  END IF;
END $$;
--> statement-breakpoint
UPDATE ib_accounts SET level = 1, updated_at = now()
  WHERE parent_ib_user_id IS NULL AND level <> 1;
--> statement-breakpoint
UPDATE ib_accounts AS child SET level = 2, updated_at = now()
  FROM ib_accounts AS parent
  WHERE child.parent_ib_user_id = parent.user_id
    AND parent.parent_ib_user_id IS NULL
    AND child.level <> 2;
