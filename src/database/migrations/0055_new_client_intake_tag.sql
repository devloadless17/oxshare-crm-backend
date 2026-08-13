-- 0055 · The "New client" intake tag — D-60.
--
-- New registrations are a GROUP an operator team owns, not an invisible pool:
-- under row-level scoping (D-45) an untagged client matches no scoped admin's
-- territory, so before this tag existed a fresh registration was visible only
-- to unrestricted admins. Assigning this tag at registration makes intake a
-- territory like any other — scope the intake team to `new-client` and they
-- MUST see every registrant; triage is the ordinary tag UI (drop this tag,
-- add the territory's).
--
-- A MIGRATION rather than a seed, because seeds never run in production and
-- the registration path depends on this row existing. Idempotent on the slug,
-- like every backfill in this series. If an operator deletes the tag,
-- registration logs a warning and continues — creating an account must never
-- fail over its tagging.
INSERT INTO client_tags (slug, label, color, description)
VALUES (
  'new-client',
  'New client',
  '#0e7490',
  'Assigned automatically to every new registration. Scope your intake team to this tag; remove it when the client is triaged into a territory.'
)
ON CONFLICT (slug) DO NOTHING;
