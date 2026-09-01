-- The links the operator puts on the client's sidebar.
--
-- An economic calendar, a help centre, a Telegram channel, a market-analysis
-- blog. The broker adds them from the admin console and every client sees them
-- in the portal menu.
--
-- ── Why a table and not a settings field ───────────────────────────────────
--
-- The same argument `platform_links` settled (and `leverages` settled again in
-- 0067): this is operator content that changes constantly, changes for
-- marketing reasons, and is changed by somebody who does not ship releases. A
-- delimited string in a settings row can say what the list IS and nothing else
-- — no per-link description, no order the operator chose, and nowhere to say a
-- link has been taken down as distinct from never having existed.
--
-- ── Why a surrogate id ─────────────────────────────────────────────────────
--
-- Every other catalogue here is keyed on its natural value — `currencies.code`,
-- `leverages.ratio`, `platform_links.key` — because that value is what the rest
-- of the system stores and compares. A link has no such value. Two entries may
-- legitimately share a title, and the URL is the field edited most often, so
-- keying on either would make a routine correction a delete-and-recreate.
--
-- ── `url` is NOT NULL, unlike `platform_links.url` ─────────────────────────
--
-- There, a null url is a terminal nobody has configured yet, and the portal
-- renders "not available yet" rather than a button that goes nowhere. Here
-- there is no such state: a menu entry with no destination IS the button that
-- goes nowhere. Withdrawing a link is `enabled = false`, which keeps its title,
-- description and position for when it comes back.
--
-- Nothing is seeded. An empty table means the sidebar shows no extra section,
-- which is the correct rendering of "the operator has not added any links" —
-- the same reasoning migration 0083 records for the empty IP allowlist.
--
-- Idempotent, so it is re-runnable if it is ever renumbered — the trap
-- backend/CLAUDE.md documents, where a renumbered migration leaves the
-- bookkeeping watermark ahead of the journal and every later migration is
-- skipped in silence.
CREATE TABLE IF NOT EXISTS external_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       varchar(80)   NOT NULL,
  description varchar(300),
  url         varchar(2048) NOT NULL,
  enabled     boolean       NOT NULL DEFAULT true,
  sort_order  integer       NOT NULL DEFAULT 0,
  updated_by  uuid,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The portal's sidebar asks "what is enabled, in the operator's order" on every
-- page it draws. That is the only read shape this table has.
CREATE INDEX IF NOT EXISTS external_links_enabled_sort_idx
  ON external_links (enabled, sort_order);
--> statement-breakpoint

COMMENT ON TABLE external_links IS
  'Operator-curated links shown in the client portal sidebar. A disabled row is off the client menu and still on the admin screen; deleting is how a link goes away for good.';
--> statement-breakpoint

-- ── The permission grant, in the shape 0093/0087/0085/0075/0068 established ──
--
-- `externallinks.*` is a NEW key, and permissions are a stored SNAPSHOT on each
-- role rather than a live reference to `config/permissions.json`. The seed
-- writes the whole catalog into `Administrator` with
-- `onConflictDoNothing({ target: roles.name })` — deliberately, so a boot cannot
-- re-widen a role an operator narrowed on purpose — which means an EXISTING row
-- is frozen at whatever the catalog held the day it was created.
--
-- Without this, the symptom is a 403 on a screen the full-access account plainly
-- ought to reach, and it compounds: `assertGrantable` refuses to hand out a key
-- the granter does not hold, so nobody on that role can grant it onward either
-- and the gap cannot be closed from inside the console. That has been repaired
-- by hand five times now, twice after it reached production.
--
-- Scope is this role, BY NAME, and the two seeded admin snapshots — nothing
-- else. A role somebody built by hand is theirs, and widening it would be the
-- re-widening `onConflictDoNothing` exists to prevent. If your full-access role
-- is named something else, grant "External Links" on the Roles screen instead.
--
-- Idempotent: `UNION` + `jsonb_agg(DISTINCT …)` cannot produce a duplicate.
--
-- NO `pg_temp` HELPER FUNCTION — the warning 0068 earned and 0075/0085/0093
-- repeat. `pg_temp` is session-local and the migration runner does not guarantee
-- every statement lands on one session, so a factored-out helper can vanish
-- between its creation and the UPDATEs, each of which then succeeds against zero
-- rows rather than failing loudly.
UPDATE roles
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'externallinks.view'
         UNION SELECT 'externallinks.create'
         UNION SELECT 'externallinks.edit'
         UNION SELECT 'externallinks.delete'
       ) keys(k)
   )
 WHERE name = 'Administrator';
--> statement-breakpoint

-- The per-admin SNAPSHOT on the two seeded accounts, for 0075's reason:
-- `resolvePermissions(roleId, snapshot)` prefers the ROLE and falls back to the
-- snapshot only where no role is attached, so on a correctly seeded database the
-- statement above already suffices. This covers the case seed.ts documents at its
-- `WHERE roleId IS NULL` backfill.
--
-- Restricted to the two SEEDED addresses. A human administrator's snapshot is
-- their own and is not a place this migration may write. Pending invites and API
-- keys are excluded for the same reasons 0093 gives.
UPDATE admins
   SET permissions = (
     SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k), '[]'::jsonb)
       FROM (
         SELECT e.v AS k FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb)) e(v)
         UNION SELECT 'externallinks.view'
         UNION SELECT 'externallinks.create'
         UNION SELECT 'externallinks.edit'
         UNION SELECT 'externallinks.delete'
       ) keys(k)
   )
 WHERE email IN ('admin@oxshare.com', 'e2e-admin@oxshare.com');
