-- ============================================================================
-- The KYC form, customizable end to end (Phase 2, 29 Sep 2026)
-- ============================================================================
--
-- The owner's ruling: every part of the KYC flow is the broker's to arrange —
-- the built-in steps retitled, reordered or switched off; the identity details
-- placed, required or optional, or not asked at all (sign-up already has them);
-- documents and the selfie required or optional; questions of any type on any
-- step. What the platform keeps is what makes the identity SOLID: an identity
-- detail keeps its name and meaning and is asked at most once, and no question
-- may duplicate one.
--
-- 1. Each evidence step says whether its evidence is REQUIRED (default: yes,
--    as before).
-- 2. Personal Information stores its identity PLACEMENTS: until now the
--    platform injected all ten details on every read and stripped them on every
--    write. Every configuration gets them written out exactly as readers were
--    shown them — first, in the platform's order, with its tiers — so nothing a
--    client sees changes until a broker changes it. Only where none is stored
--    yet: a re-run never undoes a broker's placement.
-- 3. A submission records the REQUIREMENTS it was made under, so approval
--    re-checks against those and a form tightened later never strands it.
--
-- Safe to run twice.

ALTER TABLE kyc_config_steps
  ADD COLUMN IF NOT EXISTS evidence_required boolean NOT NULL DEFAULT true;

UPDATE kyc_config_steps
   SET fields = '[
     {"id": "f-1", "name": "firstName", "label": "First Name", "type": "text", "required": true},
     {"id": "f-2", "name": "lastName", "label": "Last Name", "type": "text", "required": true},
     {"id": "f-3", "name": "dateOfBirth", "label": "Date of Birth", "type": "date", "required": true},
     {"id": "f-5", "name": "nationality", "label": "Nationality", "type": "select", "required": true},
     {"id": "f-4", "name": "phone", "label": "Phone Number", "type": "phone", "required": true},
     {"id": "f-6", "name": "country", "label": "Country of Residence", "type": "select", "required": true},
     {"id": "f-7", "name": "address", "label": "Residential Address", "type": "text", "required": true},
     {"id": "f-city", "name": "city", "label": "City", "type": "text", "required": true},
     {"id": "f-state-province", "name": "stateProvince", "label": "State / Province", "type": "text", "required": false},
     {"id": "f-postal-code", "name": "postalCode", "label": "Postal / ZIP code", "type": "text", "required": false}
   ]'::jsonb || coalesce(fields, '[]'::jsonb)
 WHERE slug = 'personal'
   AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(coalesce(fields, '[]'::jsonb)) AS e
          WHERE e->>'name' IN ('firstName', 'lastName', 'dateOfBirth', 'nationality', 'phone',
                               'country', 'address', 'city', 'stateProvince', 'postalCode'));

ALTER TABLE kyc_submissions ADD COLUMN IF NOT EXISTS form_policy jsonb;
