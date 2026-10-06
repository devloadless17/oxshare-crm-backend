-- 0193 — every client carries their COUNTRY as a tag; "untriaged" is gone (6 Oct 2026).
--
-- The buyer's old CRM tags every client with their country and every admin's
-- clients with that admin's tags. Here a tag already decides WHO SEES A CLIENT
-- (admin_client_tag_scopes), so a country tag makes a country a territory: a
-- "Lebanon desk" is an administrator whose territory holds the Lebanon tag.
--
-- ## A country tag is DERIVED, never stored on the client
--
-- Storing it would be a second copy of `users.country` that some writer must
-- keep equal — the two-homes class the profile already paid for (0139). The
-- TAG ROW exists (one per country, so it can be a territory, a filter, a chip);
-- MEMBERSHIP is computed from `users.country` through `client_tag_memberships`,
-- the one view every reader of "which tags does a client carry" now uses.
-- `client_tag_assignments` keeps only the tags somebody chose, and a trigger
-- refuses a country tag there.
--
-- ## Every client has a country, so every client has a tag
--
-- `countries` (ISO code + the platform's English name, the same list as
-- WORLD_COUNTRIES in common/kyc/country-options.ts, plus ZZ "Unknown" for
-- imports) anchors both sides: `users.country` is NOT NULL with a foreign key to
-- it, and each country tag points at it by code. A client cannot exist without
-- a country tag, enforced by Postgres rather than remembered by code.
--
-- That retires D-60's intake pool. "Untriaged" was the state of carrying no
-- tag; no client can be in it any more, so `sees_untriaged` is dropped. A
-- scoped administrator sees a client when the client carries a tag in their
-- territory — assigned or derived — or they hold `sees_all_clients`.
--
-- Production has no clients and no tags yet (6 Oct 2026). On a development
-- database a missing or unrecognised country becomes "Unknown".
--
-- Not reversible by the previous build: it reads `sees_untriaged`. Deploy the
-- backend with this migration and restart at once (the release script does).

CREATE TABLE IF NOT EXISTS "countries" (
  "code" char(2) PRIMARY KEY NOT NULL,
  "name" varchar(100) NOT NULL,
  CONSTRAINT "countries_name_uq" UNIQUE ("name")
);--> statement-breakpoint
INSERT INTO "countries" ("code", "name") VALUES
  ('AF', 'Afghanistan'),
  ('AX', 'Aland'),
  ('AL', 'Albania'),
  ('DZ', 'Algeria'),
  ('AS', 'American Samoa'),
  ('AD', 'Andorra'),
  ('AO', 'Angola'),
  ('AI', 'Anguilla'),
  ('AQ', 'Antarctica'),
  ('AG', 'Antigua and Barbuda'),
  ('AR', 'Argentina'),
  ('AM', 'Armenia'),
  ('AW', 'Aruba'),
  ('AC', 'Ascension Island'),
  ('AU', 'Australia'),
  ('AT', 'Austria'),
  ('AZ', 'Azerbaijan'),
  ('BS', 'Bahamas'),
  ('BH', 'Bahrain'),
  ('BD', 'Bangladesh'),
  ('BB', 'Barbados'),
  ('BY', 'Belarus'),
  ('BE', 'Belgium'),
  ('BZ', 'Belize'),
  ('BJ', 'Benin'),
  ('BM', 'Bermuda'),
  ('BT', 'Bhutan'),
  ('BO', 'Bolivia'),
  ('BQ', 'Bonaire'),
  ('BA', 'Bosnia and Herzegovina'),
  ('BW', 'Botswana'),
  ('BV', 'Bouvet Island'),
  ('BR', 'Brazil'),
  ('IO', 'British Indian Ocean Territory'),
  ('VG', 'British Virgin Islands'),
  ('BN', 'Brunei'),
  ('BG', 'Bulgaria'),
  ('BF', 'Burkina Faso'),
  ('BI', 'Burundi'),
  ('CV', 'Cabo Verde'),
  ('KH', 'Cambodia'),
  ('CM', 'Cameroon'),
  ('CA', 'Canada'),
  ('KY', 'Cayman Islands'),
  ('CF', 'Central African Republic'),
  ('TD', 'Chad'),
  ('CL', 'Chile'),
  ('CN', 'China'),
  ('CX', 'Christmas Island'),
  ('CC', 'Cocos (Keeling) Islands'),
  ('CO', 'Colombia'),
  ('KM', 'Comoros'),
  ('CK', 'Cook Islands'),
  ('CR', 'Costa Rica'),
  ('HR', 'Croatia'),
  ('CU', 'Cuba'),
  ('CW', 'Curacao'),
  ('CY', 'Cyprus'),
  ('CZ', 'Czechia'),
  ('CD', 'Democratic Republic of the Congo'),
  ('DK', 'Denmark'),
  ('DJ', 'Djibouti'),
  ('DM', 'Dominica'),
  ('DO', 'Dominican Republic'),
  ('TL', 'East Timor'),
  ('EC', 'Ecuador'),
  ('EG', 'Egypt'),
  ('SV', 'El Salvador'),
  ('GQ', 'Equatorial Guinea'),
  ('ER', 'Eritrea'),
  ('EE', 'Estonia'),
  ('SZ', 'Eswatini'),
  ('ET', 'Ethiopia'),
  ('FK', 'Falkland Islands'),
  ('FO', 'Faroe Islands'),
  ('FJ', 'Fiji'),
  ('FI', 'Finland'),
  ('FR', 'France'),
  ('GF', 'French Guiana'),
  ('PF', 'French Polynesia'),
  ('TF', 'French Southern Territories'),
  ('GA', 'Gabon'),
  ('GM', 'Gambia'),
  ('GE', 'Georgia'),
  ('DE', 'Germany'),
  ('GH', 'Ghana'),
  ('GI', 'Gibraltar'),
  ('GR', 'Greece'),
  ('GL', 'Greenland'),
  ('GD', 'Grenada'),
  ('GP', 'Guadeloupe'),
  ('GU', 'Guam'),
  ('GT', 'Guatemala'),
  ('GG', 'Guernsey'),
  ('GN', 'Guinea'),
  ('GW', 'Guinea-Bissau'),
  ('GY', 'Guyana'),
  ('HT', 'Haiti'),
  ('HM', 'Heard Island and McDonald Islands'),
  ('HN', 'Honduras'),
  ('HK', 'Hong Kong'),
  ('HU', 'Hungary'),
  ('IS', 'Iceland'),
  ('IN', 'India'),
  ('ID', 'Indonesia'),
  ('IR', 'Iran'),
  ('IQ', 'Iraq'),
  ('IE', 'Ireland'),
  ('IM', 'Isle of Man'),
  ('IT', 'Italy'),
  ('CI', 'Ivory Coast'),
  ('JM', 'Jamaica'),
  ('JP', 'Japan'),
  ('JE', 'Jersey'),
  ('JO', 'Jordan'),
  ('KZ', 'Kazakhstan'),
  ('KE', 'Kenya'),
  ('KI', 'Kiribati'),
  ('XK', 'Kosovo'),
  ('KW', 'Kuwait'),
  ('KG', 'Kyrgyzstan'),
  ('LA', 'Laos'),
  ('LV', 'Latvia'),
  ('LB', 'Lebanon'),
  ('LS', 'Lesotho'),
  ('LR', 'Liberia'),
  ('LY', 'Libya'),
  ('LI', 'Liechtenstein'),
  ('LT', 'Lithuania'),
  ('LU', 'Luxembourg'),
  ('MO', 'Macao'),
  ('MG', 'Madagascar'),
  ('MW', 'Malawi'),
  ('MY', 'Malaysia'),
  ('MV', 'Maldives'),
  ('ML', 'Mali'),
  ('MT', 'Malta'),
  ('MH', 'Marshall Islands'),
  ('MQ', 'Martinique'),
  ('MR', 'Mauritania'),
  ('MU', 'Mauritius'),
  ('YT', 'Mayotte'),
  ('MX', 'Mexico'),
  ('FM', 'Micronesia'),
  ('MD', 'Moldova'),
  ('MC', 'Monaco'),
  ('MN', 'Mongolia'),
  ('ME', 'Montenegro'),
  ('MS', 'Montserrat'),
  ('MA', 'Morocco'),
  ('MZ', 'Mozambique'),
  ('MM', 'Myanmar'),
  ('NA', 'Namibia'),
  ('NR', 'Nauru'),
  ('NP', 'Nepal'),
  ('NL', 'Netherlands'),
  ('NC', 'New Caledonia'),
  ('NZ', 'New Zealand'),
  ('NI', 'Nicaragua'),
  ('NE', 'Niger'),
  ('NG', 'Nigeria'),
  ('NU', 'Niue'),
  ('NF', 'Norfolk Island'),
  ('KP', 'North Korea'),
  ('MK', 'North Macedonia'),
  ('MP', 'Northern Mariana Islands'),
  ('NO', 'Norway'),
  ('OM', 'Oman'),
  ('PK', 'Pakistan'),
  ('PW', 'Palau'),
  ('PS', 'Palestine'),
  ('PA', 'Panama'),
  ('PG', 'Papua New Guinea'),
  ('PY', 'Paraguay'),
  ('PE', 'Peru'),
  ('PH', 'Philippines'),
  ('PN', 'Pitcairn Islands'),
  ('PL', 'Poland'),
  ('PT', 'Portugal'),
  ('PR', 'Puerto Rico'),
  ('QA', 'Qatar'),
  ('CG', 'Republic of the Congo'),
  ('RE', 'Reunion'),
  ('RO', 'Romania'),
  ('RU', 'Russia'),
  ('RW', 'Rwanda'),
  ('BL', 'Saint Barthelemy'),
  ('SH', 'Saint Helena'),
  ('KN', 'Saint Kitts and Nevis'),
  ('LC', 'Saint Lucia'),
  ('MF', 'Saint Martin'),
  ('PM', 'Saint Pierre and Miquelon'),
  ('VC', 'Saint Vincent and the Grenadines'),
  ('WS', 'Samoa'),
  ('SM', 'San Marino'),
  ('ST', 'Sao Tome and Principe'),
  ('SA', 'Saudi Arabia'),
  ('SN', 'Senegal'),
  ('RS', 'Serbia'),
  ('SC', 'Seychelles'),
  ('SL', 'Sierra Leone'),
  ('SG', 'Singapore'),
  ('SX', 'Sint Maarten'),
  ('SK', 'Slovakia'),
  ('SI', 'Slovenia'),
  ('SB', 'Solomon Islands'),
  ('SO', 'Somalia'),
  ('ZA', 'South Africa'),
  ('GS', 'South Georgia and the South Sandwich Islands'),
  ('KR', 'South Korea'),
  ('SS', 'South Sudan'),
  ('ES', 'Spain'),
  ('LK', 'Sri Lanka'),
  ('SD', 'Sudan'),
  ('SR', 'Suriname'),
  ('SJ', 'Svalbard and Jan Mayen'),
  ('SE', 'Sweden'),
  ('CH', 'Switzerland'),
  ('SY', 'Syria'),
  ('TW', 'Taiwan'),
  ('TJ', 'Tajikistan'),
  ('TZ', 'Tanzania'),
  ('TH', 'Thailand'),
  ('TG', 'Togo'),
  ('TK', 'Tokelau'),
  ('TO', 'Tonga'),
  ('TT', 'Trinidad and Tobago'),
  ('TA', 'Tristan da Cunha'),
  ('TN', 'Tunisia'),
  ('TR', 'Türkiye'),
  ('TM', 'Turkmenistan'),
  ('TC', 'Turks and Caicos Islands'),
  ('TV', 'Tuvalu'),
  ('UM', 'U.S. Minor Outlying Islands'),
  ('VI', 'U.S. Virgin Islands'),
  ('UG', 'Uganda'),
  ('UA', 'Ukraine'),
  ('AE', 'United Arab Emirates'),
  ('GB', 'United Kingdom'),
  ('US', 'United States'),
  ('UY', 'Uruguay'),
  ('UZ', 'Uzbekistan'),
  ('VU', 'Vanuatu'),
  ('VA', 'Vatican City'),
  ('VE', 'Venezuela'),
  ('VN', 'Vietnam'),
  ('WF', 'Wallis and Futuna'),
  ('EH', 'Western Sahara'),
  ('YE', 'Yemen'),
  ('ZM', 'Zambia'),
  ('ZW', 'Zimbabwe')
,
  ('ZZ', 'Unknown')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name";--> statement-breakpoint

UPDATE "users" SET "country" = 'Unknown'
  WHERE "country" IS NULL OR "country" NOT IN (SELECT "name" FROM "countries");--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "country" SET DEFAULT 'Unknown';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "country" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_country_fk"
  FOREIGN KEY ("country") REFERENCES "countries"("name") ON UPDATE CASCADE ON DELETE RESTRICT;--> statement-breakpoint

ALTER TABLE "client_tags" ADD COLUMN IF NOT EXISTS "country_code" char(2)
  REFERENCES "countries"("code") ON DELETE RESTRICT;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_tags_country_code_uq" ON "client_tags" ("country_code");--> statement-breakpoint
INSERT INTO "client_tags" ("slug", "label", "country_code")
  SELECT 'country-' || lower("code"), "name", "code" FROM "countries";--> statement-breakpoint

-- A country tag is derived: never assigned by hand, never deleted, never re-pointed.
CREATE OR REPLACE FUNCTION client_tag_assignments_no_country() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM client_tags WHERE id = NEW.tag_id AND country_code IS NOT NULL) THEN
    RAISE EXCEPTION 'A country tag follows the client''s country and cannot be assigned'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "client_tag_assignments_no_country" BEFORE INSERT OR UPDATE ON "client_tag_assignments"
  FOR EACH ROW EXECUTE FUNCTION client_tag_assignments_no_country();--> statement-breakpoint
CREATE OR REPLACE FUNCTION client_tags_country_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.country_code IS NOT NULL THEN
      RAISE EXCEPTION 'A country tag cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.country_code IS DISTINCT FROM OLD.country_code
     OR (OLD.country_code IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug) THEN
    RAISE EXCEPTION 'A country tag''s country and slug are fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "client_tags_country_fixed" BEFORE UPDATE OR DELETE ON "client_tags"
  FOR EACH ROW EXECUTE FUNCTION client_tags_country_fixed();--> statement-breakpoint

-- THE definition of "the tags a client carries": chosen + derived.
CREATE OR REPLACE VIEW "client_tag_memberships" AS
  SELECT a."user_id", a."tag_id", a."assigned_by", a."assigned_at"
    FROM "client_tag_assignments" a
  UNION ALL
  SELECT u."id", t."id", NULL::uuid, u."created_at"
    FROM "users" u
    JOIN "countries" c ON c."name" = u."country"
    JOIN "client_tags" t ON t."country_code" = c."code";--> statement-breakpoint

ALTER TABLE "admins" DROP COLUMN IF EXISTS "sees_untriaged";--> statement-breakpoint
ALTER TABLE "admin_invites" DROP COLUMN IF EXISTS "sees_untriaged";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "sees_untriaged";
