-- One spelling for a permission key: dots.
--
-- Two spellings have been alive since RBAC was built. `config/permissions.json`
-- — the catalog, and the only grantable vocabulary — uses `kyc.review`. Issued
-- tokens and some stored grants carried `kyc:review`. Four separate
-- `replace(/:/g, '.')` shims bridged them: one in AdminRbacService, one in
-- PermissionsGuard, one in UploadsController, and one in the admin frontend.
--
-- A normalisation shim is a permanent invitation to a third spelling, and these
-- four had already drifted into being copy-pasted rather than shared. Worse,
-- `assertGrantable` normalised BEFORE checking the catalog, so `kyc:review`
-- passed validation and was then stored verbatim — the system kept generating
-- the inconsistency it was compensating for.
--
-- This migration converts what is stored. The shims come out in the same commit,
-- and the order matters: with the shims gone and colon keys still in the
-- database, an admin would silently stop matching their own permission and lose
-- access to a page with nothing to explain why. Data first, then code.
--
-- Idempotent: running it twice is a no-op, because after the first run there are
-- no colons left to replace.

-- Roles: the source of truth for anyone assigned via a role.
UPDATE roles
SET permissions = (
  SELECT jsonb_agg(lower(replace(value, ':', '.')))
  FROM jsonb_array_elements_text(permissions) AS value
)
WHERE permissions::text LIKE '%:%';
--> statement-breakpoint

-- Admins: the per-admin snapshot, used when an admin was invited with an
-- explicit permission list rather than a role.
UPDATE admins
SET permissions = (
  SELECT jsonb_agg(lower(replace(value, ':', '.')))
  FROM jsonb_array_elements_text(permissions) AS value
)
WHERE permissions::text LIKE '%:%';
--> statement-breakpoint

-- Pending invites carry a permission set that becomes an admin's on acceptance.
-- Missing these would reintroduce colon keys the moment someone accepted an
-- invite issued before this migration.
UPDATE admin_invites
SET permissions = (
  SELECT jsonb_agg(lower(replace(value, ':', '.')))
  FROM jsonb_array_elements_text(permissions) AS value
)
WHERE permissions IS NOT NULL AND permissions::text LIKE '%:%';
