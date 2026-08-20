-- RBAC-08 — the admin IP allowlist, restored.
--
-- Dropped by 0034 as unwanted scope. The root CLAUDE.md records the opposite:
-- the tech lead confirmed on 2 Aug 2026 that RBAC-08 is in scope and the
-- committed total is 41, and that deletion was never confirmed by them. The
-- scope decision on record wins (DECISIONS D-51).
--
-- Deliberately identical in shape to the table 0034 removed, so the two are
-- comparable in history rather than a near-miss: same columns, same widths, same
-- unique index on the canonical CIDR.
--
-- `IF NOT EXISTS` because a database that never ran 0034 — anything restored
-- from a backup taken before 7 Aug — still has the table, and this migration
-- must be a no-op there rather than an error that stops the whole chain.
CREATE TABLE IF NOT EXISTS "admin_ip_allowlist" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cidr" varchar(43) NOT NULL,
  "label" varchar(200) NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Canonicalised before insert, so `10.0.0.5/24` and `10.0.0.0/24` cannot both
-- exist and leave somebody believing they removed a rule that is still in force.
CREATE UNIQUE INDEX IF NOT EXISTS "admin_ip_allowlist_cidr_uq"
  ON "admin_ip_allowlist" ("cidr");
