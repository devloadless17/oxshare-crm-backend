-- 0192 — an administrator who may reach the console from ANY network (5 Oct 2026).
--
-- RBAC-08 admits the admin surface only from the allowlisted ranges. The owner
-- asked to name individual administrators who bypass that check — the owner
-- travelling, say — while everyone else stays on the office networks. A row here
-- skips the NETWORK check and nothing else: permissions, client scope, masks,
-- CSRF and session expiry apply exactly as before, and API keys are never exempt.
--
-- A reason is required for the same reason a rule needs a label: an exemption
-- nobody remembers granting is one nobody ever removes.
--
-- CASCADE: an exemption belongs to its administrator and means nothing without
-- them. Additive: the previous build ignores the table.
CREATE TABLE IF NOT EXISTS "admin_ip_allowlist_exemptions" (
  "admin_id" uuid PRIMARY KEY NOT NULL REFERENCES "admins"("id") ON DELETE CASCADE,
  "reason" varchar(200) NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
