-- 0056 · System tags — a tag the PRODUCT depends on cannot be deleted.
--
-- The `new-client` intake tag (0055, D-60) is load-bearing before any admin is
-- scoped to it: registration attaches it, and deleting it would silently turn
-- intake back into an invisible pool. The scope FK (ON DELETE RESTRICT)
-- protects a tag only once somebody's territory references it; `is_system`
-- protects the ones the code itself references. Same pattern as the four
-- mandated KYC steps: label and colour stay editable, deletion is refused with
-- a sentence. Un-assigning it from a client stays allowed — that is triage.
ALTER TABLE client_tags ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
UPDATE client_tags SET is_system = true WHERE slug = 'new-client';
