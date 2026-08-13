-- 0057 · "New client" is a STATE, not a tag — D-60, final form.
--
-- 0055 materialised "not yet triaged" as a tag registration had to assign and
-- triage had to remove; 0056 then had to make that tag undeletable. Each guard
-- protected an invariant the derived state gets BY CONSTRUCTION: untriaged now
-- simply MEANS "has no tag assignments". Nothing to attach, nothing to forget,
-- and — the decisive property — no orphan class: removing a client's last
-- territory tag returns them to intake instead of making them invisible to
-- every scoped admin.
--
-- Seeing intake becomes an explicit grant on the ADMIN: `sees_untriaged`,
-- edited beside their territory tags, honoured by clientScopePredicate as an
-- OR-branch. Unrestricted admins see everything as before; the flag only means
-- something for a scoped admin.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS sees_untriaged boolean NOT NULL DEFAULT false;
-- Chosen at invite time and applied on acceptance, like scoped_tag_ids and for
-- the same reason: an intake-only invitee must not be unrestricted in the
-- window between clicking the link and being configured.
ALTER TABLE admin_invites ADD COLUMN IF NOT EXISTS sees_untriaged boolean NOT NULL DEFAULT false;

-- The materialised tag goes. Assignments cascade with it; admins scoped to it
-- would have blocked the delete via the FK, so those scope rows are removed
-- first — an admin whose ONLY scope row was the intake tag becomes an
-- intake-only admin under the new model rather than silently unrestricted.
UPDATE admins SET sees_untriaged = true
WHERE id IN (
  SELECT s.admin_id FROM admin_client_tag_scopes s
  JOIN client_tags t ON t.id = s.tag_id
  WHERE t.slug = 'new-client'
);
DELETE FROM admin_client_tag_scopes
WHERE tag_id IN (SELECT id FROM client_tags WHERE slug = 'new-client');
DELETE FROM client_tags WHERE slug = 'new-client';
