import { countries } from 'countries-list';

/**
 * The country and nationality choices offered on a KYC form.
 *
 * ## Why these live on the SERVER
 *
 * They were 258 lines in the client portal, and the two `select` fields that
 * used them carried no `options` at all — `step-field.tsx` special-cased them
 * BY FIELD NAME, filling `nationality` and `country` from a local array.
 *
 * That made them invisible everywhere else. The admin builder showed both as
 * "Dropdown with no choices" because, as far as the config was concerned, they
 * had none: an operator could not see the list, could not edit it, and a field
 * they created called anything else got an empty dropdown with no hint why.
 *
 * Serving them puts the answer in one place. The config says what a field
 * offers, and the portal renders it without knowing which field it is.
 *
 * ## The exclusion is a legal constraint, not a preference
 *
 * The broker operates from Lebanon, where trading with Israel is prohibited
 * outright. It moved here with the list and is applied at the point the options
 * are built, so nothing downstream has to remember it.
 *
 * PRESENTATION, NOT ENFORCEMENT. Removing an option stops it being offered; it
 * does not stop it being sent. A client can still POST any value, and the
 * validation that refuses one is a separate concern (R-5.1 — every constraint
 * is re-derived server-side).
 */

/** ISO2 codes this platform does not offer. See the header. */
const EXCLUDED_COUNTRY_CODES = new Set(['IL']);

/** The same exclusion as demonyms — the nationality list has no code to match. */
const EXCLUDED_NATIONALITIES = new Set(['Israeli']);

/**
 * Derived from `countries-list` rather than hand-written, so the list tracks
 * the package instead of drifting. Sorted by name, because a dropdown of 250
 * entries in dictionary order is the only one a client can use.
 */
export const KYC_COUNTRY_OPTIONS: string[] = Object.entries(countries)
  .filter(([code]) => !EXCLUDED_COUNTRY_CODES.has(code.toUpperCase()))
  .map(([, country]) => country.name)
  .sort((a, b) => a.localeCompare(b));

/**
 * Demonyms, hand-maintained because `countries-list` does not carry them —
 * "Lebanon" is in the package, "Lebanese" is not.
 */
export const KYC_NATIONALITY_OPTIONS: string[] = [
  'Afghan',
  'Albanian',
  'Algerian',
  'American',
  'Andorran',
  'Angolan',
  'Antiguan',
  'Argentine',
  'Armenian',
  'Australian',
  'Austrian',
  'Azerbaijani',
  'Bahamian',
  'Bahraini',
  'Bangladeshi',
  'Barbadian',
  'Belarusian',
  'Belgian',
  'Belizean',
  'Beninese',
  'Bhutanese',
  'Bolivian',
  'Bosnian',
  'Brazilian',
  'British',
  'Bruneian',
  'Bulgarian',
  'Burkinabe',
  'Burmese',
  'Burundian',
  'Cambodian',
  'Cameroonian',
  'Canadian',
  'Cape Verdean',
  'Central African',
  'Chadian',
  'Chilean',
  'Chinese',
  'Colombian',
  'Comoran',
  'Congolese',
  'Costa Rican',
  'Croatian',
  'Cuban',
  'Cypriot',
  'Czech',
  'Danish',
  'Djiboutian',
  'Dominican',
  'Dutch',
  'East Timorese',
  'Ecuadorean',
  'Egyptian',
  'Emirati',
  'Equatorial Guinean',
  'Eritrean',
  'Estonian',
  'Ethiopian',
  'Fijian',
  'Filipino',
  'Finnish',
  'French',
  'Gabonese',
  'Gambian',
  'Georgian',
  'German',
  'Ghanaian',
  'Greek',
  'Grenadian',
  'Guatemalan',
  'Guinean',
  'Guyanese',
  'Haitian',
  'Honduran',
  'Hungarian',
  'Icelander',
  'Indian',
  'Indonesian',
  'Iranian',
  'Iraqi',
  'Irish',
  'Israeli',
  'Italian',
  'Ivorian',
  'Jamaican',
  'Japanese',
  'Jordanian',
  'Kazakhstani',
  'Kenyan',
  'Kittitian',
  'Kuwaiti',
  'Kyrgyz',
  'Laotian',
  'Latvian',
  'Lebanese',
  'Liberian',
  'Libyan',
  'Liechtensteiner',
  'Lithuanian',
  'Luxembourger',
  'Macedonian',
  'Malagasy',
  'Malawian',
  'Malaysian',
  'Maldivian',
  'Malian',
  'Maltese',
  'Marshallese',
  'Mauritanian',
  'Mauritian',
  'Mexican',
  'Micronesian',
  'Moldovan',
  'Monacan',
  'Mongolian',
  'Montenegrin',
  'Moroccan',
  'Mozambican',
  'Namibian',
  'Nauruan',
  'Nepalese',
  'New Zealander',
  'Nicaraguan',
  'Nigerian',
  'Nigerien',
  'North Korean',
  'Norwegian',
  'Omani',
  'Pakistani',
  'Palauans',
  'Palestinian',
  'Panamanian',
  'Papua New Guinean',
  'Paraguayan',
  'Peruvian',
  'Polish',
  'Portuguese',
  'Qatari',
  'Romanian',
  'Russian',
  'Rwandan',
  'Saint Lucian',
  'Salvadoran',
  'Samoan',
  'San Marinese',
  'Sao Tomean',
  'Saudi',
  'Senegalese',
  'Serbian',
  'Seychellois',
  'Sierra Leonean',
  'Singaporean',
  'Slovak',
  'Slovenian',
  'Solomon Islander',
  'Somali',
  'South African',
  'South Korean',
  'South Sudanese',
  'Spanish',
  'Sri Lankan',
  'Sudanese',
  'Surinamer',
  'Swazi',
  'Swedish',
  'Swiss',
  'Syrian',
  'Taiwanese',
  'Tajik',
  'Tanzanian',
  'Thai',
  'Togolese',
  'Tongan',
  'Trinidadian',
  'Tunisian',
  'Turkish',
  'Turkmen',
  'Tuvaluan',
  'Ugandan',
  'Ukrainian',
  'Uruguayan',
  'Uzbek',
  'Vanuatuans',
  'Venezuelan',
  'Vietnamese',
  'Yemeni',
  'Zambian',
  'Zimbabwean',
]
  .filter((nationality) => !EXCLUDED_NATIONALITIES.has(nationality))
  .sort((a, b) => a.localeCompare(b));

/*
 * ── The countries a broker OFFERS (0178, the owner's ruling 1 Oct 2026) ─────
 *
 * The admin chooses which countries the platform offers — not every country in
 * the world. One list drives BOTH the country and the nationality dropdowns,
 * because they are two words for one thing ("Lebanon" / "Lebanese"): a
 * nationality is offered when its country is. Stored as ISO codes, so a
 * rename in `countries-list` never orphans a choice.
 *
 * A client's SAVED value is always kept (the profile writers accept an
 * unchanged value off the list), so shrinking the list never breaks anybody.
 */

/** One country of the world the platform knows. */
export interface WorldCountry {
  code: string;
  name: string;
}

/** Every country the platform can offer, by name. */
export const WORLD_COUNTRIES: readonly WorldCountry[] = Object.entries(countries)
  .filter(([code]) => !EXCLUDED_COUNTRY_CODES.has(code.toUpperCase()))
  .map(([code, country]) => ({ code: code.toUpperCase(), name: country.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

const BY_CODE = new Map(WORLD_COUNTRIES.map((country) => [country.code, country]));
const fold = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').trim().replace(/\s+/g, ' ').toLowerCase();
const BY_NAME = new Map(WORLD_COUNTRIES.map((country) => [fold(country.name), country]));

/** A country by its ISO code, or undefined. */
export function countryByCode(code: string): WorldCountry | undefined {
  return BY_CODE.get(code.trim().toUpperCase());
}

/** A country by its name, however it was typed or accented; undefined if not a country. */
export function countryByName(name: string): WorldCountry | undefined {
  return BY_NAME.get(fold(name));
}

/**
 * Which country each nationality belongs to. Two countries share one word
 * ("Congolese", "Dominican"); a country with no demonym on the list simply
 * offers no nationality, as before.
 */
export const NATIONALITY_COUNTRIES: Readonly<Record<string, readonly string[]>> = {
  Afghan: ['AF'],
  Albanian: ['AL'],
  Algerian: ['DZ'],
  American: ['US'],
  Andorran: ['AD'],
  Angolan: ['AO'],
  Antiguan: ['AG'],
  Argentine: ['AR'],
  Armenian: ['AM'],
  Australian: ['AU'],
  Austrian: ['AT'],
  Azerbaijani: ['AZ'],
  Bahamian: ['BS'],
  Bahraini: ['BH'],
  Bangladeshi: ['BD'],
  Barbadian: ['BB'],
  Belarusian: ['BY'],
  Belgian: ['BE'],
  Belizean: ['BZ'],
  Beninese: ['BJ'],
  Bhutanese: ['BT'],
  Bolivian: ['BO'],
  Bosnian: ['BA'],
  Brazilian: ['BR'],
  British: ['GB'],
  Bruneian: ['BN'],
  Bulgarian: ['BG'],
  Burkinabe: ['BF'],
  Burmese: ['MM'],
  Burundian: ['BI'],
  Cambodian: ['KH'],
  Cameroonian: ['CM'],
  Canadian: ['CA'],
  'Cape Verdean': ['CV'],
  'Central African': ['CF'],
  Chadian: ['TD'],
  Chilean: ['CL'],
  Chinese: ['CN'],
  Colombian: ['CO'],
  Comoran: ['KM'],
  Congolese: ['CD', 'CG'],
  'Costa Rican': ['CR'],
  Croatian: ['HR'],
  Cuban: ['CU'],
  Cypriot: ['CY'],
  Czech: ['CZ'],
  Danish: ['DK'],
  Djiboutian: ['DJ'],
  Dominican: ['DM', 'DO'],
  Dutch: ['NL'],
  'East Timorese': ['TL'],
  Ecuadorean: ['EC'],
  Egyptian: ['EG'],
  Emirati: ['AE'],
  'Equatorial Guinean': ['GQ'],
  Eritrean: ['ER'],
  Estonian: ['EE'],
  Ethiopian: ['ET'],
  Fijian: ['FJ'],
  Filipino: ['PH'],
  Finnish: ['FI'],
  French: ['FR'],
  Gabonese: ['GA'],
  Gambian: ['GM'],
  Georgian: ['GE'],
  German: ['DE'],
  Ghanaian: ['GH'],
  Greek: ['GR'],
  Grenadian: ['GD'],
  Guatemalan: ['GT'],
  Guinean: ['GN'],
  Guyanese: ['GY'],
  Haitian: ['HT'],
  Honduran: ['HN'],
  Hungarian: ['HU'],
  Icelander: ['IS'],
  Indian: ['IN'],
  Indonesian: ['ID'],
  Iranian: ['IR'],
  Iraqi: ['IQ'],
  Irish: ['IE'],
  Italian: ['IT'],
  Ivorian: ['CI'],
  Jamaican: ['JM'],
  Japanese: ['JP'],
  Jordanian: ['JO'],
  Kazakhstani: ['KZ'],
  Kenyan: ['KE'],
  Kittitian: ['KN'],
  Kuwaiti: ['KW'],
  Kyrgyz: ['KG'],
  Laotian: ['LA'],
  Latvian: ['LV'],
  Lebanese: ['LB'],
  Liberian: ['LR'],
  Libyan: ['LY'],
  Liechtensteiner: ['LI'],
  Lithuanian: ['LT'],
  Luxembourger: ['LU'],
  Macedonian: ['MK'],
  Malagasy: ['MG'],
  Malawian: ['MW'],
  Malaysian: ['MY'],
  Maldivian: ['MV'],
  Malian: ['ML'],
  Maltese: ['MT'],
  Marshallese: ['MH'],
  Mauritanian: ['MR'],
  Mauritian: ['MU'],
  Mexican: ['MX'],
  Micronesian: ['FM'],
  Moldovan: ['MD'],
  Monacan: ['MC'],
  Mongolian: ['MN'],
  Montenegrin: ['ME'],
  Moroccan: ['MA'],
  Mozambican: ['MZ'],
  Namibian: ['NA'],
  Nauruan: ['NR'],
  Nepalese: ['NP'],
  'New Zealander': ['NZ'],
  Nicaraguan: ['NI'],
  Nigerian: ['NG'],
  Nigerien: ['NE'],
  'North Korean': ['KP'],
  Norwegian: ['NO'],
  Omani: ['OM'],
  Pakistani: ['PK'],
  Palauans: ['PW'],
  Palestinian: ['PS'],
  Panamanian: ['PA'],
  'Papua New Guinean': ['PG'],
  Paraguayan: ['PY'],
  Peruvian: ['PE'],
  Polish: ['PL'],
  Portuguese: ['PT'],
  Qatari: ['QA'],
  Romanian: ['RO'],
  Russian: ['RU'],
  Rwandan: ['RW'],
  'Saint Lucian': ['LC'],
  Salvadoran: ['SV'],
  Samoan: ['WS'],
  'San Marinese': ['SM'],
  'Sao Tomean': ['ST'],
  Saudi: ['SA'],
  Senegalese: ['SN'],
  Serbian: ['RS'],
  Seychellois: ['SC'],
  'Sierra Leonean': ['SL'],
  Singaporean: ['SG'],
  Slovak: ['SK'],
  Slovenian: ['SI'],
  'Solomon Islander': ['SB'],
  Somali: ['SO'],
  'South African': ['ZA'],
  'South Korean': ['KR'],
  'South Sudanese': ['SS'],
  Spanish: ['ES'],
  'Sri Lankan': ['LK'],
  Sudanese: ['SD'],
  Surinamer: ['SR'],
  Swazi: ['SZ'],
  Swedish: ['SE'],
  Swiss: ['CH'],
  Syrian: ['SY'],
  Taiwanese: ['TW'],
  Tajik: ['TJ'],
  Tanzanian: ['TZ'],
  Thai: ['TH'],
  Togolese: ['TG'],
  Tongan: ['TO'],
  Trinidadian: ['TT'],
  Tunisian: ['TN'],
  Turkish: ['TR'],
  Turkmen: ['TM'],
  Tuvaluan: ['TV'],
  Ugandan: ['UG'],
  Ukrainian: ['UA'],
  Uruguayan: ['UY'],
  Uzbek: ['UZ'],
  Vanuatuans: ['VU'],
  Venezuelan: ['VE'],
  Vietnamese: ['VN'],
  Yemeni: ['YE'],
  Zambian: ['ZM'],
  Zimbabwean: ['ZW'],
};

/** What a broker's list offers: country names and the nationalities that go with them. */
export interface OfferedLists {
  /** The ISO codes chosen; null = every country (nothing chosen yet). */
  codes: readonly string[] | null;
  countries: string[];
  nationalities: string[];
}

/** The two dropdowns for a stored list of codes (null = the whole world, as before 0178). */
export function offeredLists(codes: readonly string[] | null): OfferedLists {
  if (codes === null) {
    return {
      codes: null,
      countries: [...KYC_COUNTRY_OPTIONS],
      nationalities: [...KYC_NATIONALITY_OPTIONS],
    };
  }
  const chosen = new Set(codes);
  return {
    codes,
    countries: WORLD_COUNTRIES.filter((c) => chosen.has(c.code)).map((c) => c.name),
    nationalities: KYC_NATIONALITY_OPTIONS.filter((n) =>
      (NATIONALITY_COUNTRIES[n] ?? []).some((code) => chosen.has(code)),
    ),
  };
}
