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

/*
 * ── THE LISTS IN ARABIC (0179) ───────────────────────────────────────────────
 *
 * The stored answer is always the ENGLISH value — "Lebanon", "Lebanese" — which
 * is what the profile accepts and every screen and report reads. Arabic is only
 * what an Arabic reader is SHOWN beside it, served as `optionsAr` on the KYC form
 * and as `countryLabelsAr` / `nationalityLabelsAr` on `GET /profile/options`,
 * keyed by that English value. One pair of functions builds both.
 */

/**
 * Countries in Arabic, from the runtime's own CLDR data by ISO code — the same
 * source that names them in every Arabic browser, so nothing here is typed by
 * hand. Node ships full ICU.
 */
const ARABIC_REGIONS = new Intl.DisplayNames(['ar'], { type: 'region' });

/** A country's Arabic name by ISO code, or undefined when the runtime has none. */
export function countryNameAr(code: string): string | undefined {
  const iso = code.trim().toUpperCase();
  try {
    const name = ARABIC_REGIONS.of(iso);
    return name && name !== iso ? name : undefined;
  } catch {
    return undefined;
  }
}

const COUNTRY_AR_BY_NAME: ReadonlyMap<string, string> = new Map(
  WORLD_COUNTRIES.flatMap((country) => {
    const arabic = countryNameAr(country.code);
    return arabic ? [[country.name, arabic] as const] : [];
  }),
);

/** Arabic for each English country name given (matched as `countryByName` does); unknown names are left out. */
export function countryLabelsAr(names: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const name of names) {
    const arabic =
      COUNTRY_AR_BY_NAME.get(name) ?? COUNTRY_AR_BY_NAME.get(countryByName(name)?.name ?? '');
    if (arabic) labels[name] = arabic;
  }
  return labels;
}

/**
 * Nationalities in Arabic: the masculine singular adjective (نسبة), the form an
 * Arabic form uses for "Nationality: ___". Hand-written because no runtime
 * carries demonyms. A demonym with no settled Arabic adjective is phrased
 * "from <country>" (من …), as Arabic forms commonly do.
 *
 * Every entry of `KYC_NATIONALITY_OPTIONS` has one — `kyc-country-options.spec.ts`
 * refuses a nationality added without its Arabic.
 */
export const NATIONALITY_AR: Readonly<Record<string, string>> = {
  Afghan: 'أفغاني',
  Albanian: 'ألباني',
  Algerian: 'جزائري',
  American: 'أمريكي',
  Andorran: 'أندوري',
  Angolan: 'أنغولي',
  Antiguan: 'من أنتيغوا وباربودا',
  Argentine: 'أرجنتيني',
  Armenian: 'أرميني',
  Australian: 'أسترالي',
  Austrian: 'نمساوي',
  Azerbaijani: 'أذربيجاني',
  Bahamian: 'باهامي',
  Bahraini: 'بحريني',
  Bangladeshi: 'بنغلاديشي',
  Barbadian: 'بربادوسي',
  Belarusian: 'بيلاروسي',
  Belgian: 'بلجيكي',
  Belizean: 'بليزي',
  Beninese: 'بنيني',
  Bhutanese: 'بوتاني',
  Bolivian: 'بوليفي',
  Bosnian: 'بوسني',
  Brazilian: 'برازيلي',
  British: 'بريطاني',
  Bruneian: 'بروني',
  Bulgarian: 'بلغاري',
  Burkinabe: 'بوركيني',
  Burmese: 'ميانماري',
  Burundian: 'بوروندي',
  Cambodian: 'كمبودي',
  Cameroonian: 'كاميروني',
  Canadian: 'كندي',
  'Cape Verdean': 'من الرأس الأخضر',
  'Central African': 'من أفريقيا الوسطى',
  Chadian: 'تشادي',
  Chilean: 'تشيلي',
  Chinese: 'صيني',
  Colombian: 'كولومبي',
  Comoran: 'قمري',
  Congolese: 'كونغولي',
  'Costa Rican': 'كوستاريكي',
  Croatian: 'كرواتي',
  Cuban: 'كوبي',
  Cypriot: 'قبرصي',
  Czech: 'تشيكي',
  Danish: 'دنماركي',
  Djiboutian: 'جيبوتي',
  Dominican: 'دومينيكاني',
  Dutch: 'هولندي',
  'East Timorese': 'تيموري',
  Ecuadorean: 'إكوادوري',
  Egyptian: 'مصري',
  Emirati: 'إماراتي',
  'Equatorial Guinean': 'من غينيا الاستوائية',
  Eritrean: 'إريتري',
  Estonian: 'إستوني',
  Ethiopian: 'إثيوبي',
  Fijian: 'فيجي',
  Filipino: 'فلبيني',
  Finnish: 'فنلندي',
  French: 'فرنسي',
  Gabonese: 'غابوني',
  Gambian: 'غامبي',
  Georgian: 'جورجي',
  German: 'ألماني',
  Ghanaian: 'غاني',
  Greek: 'يوناني',
  Grenadian: 'غرينادي',
  Guatemalan: 'غواتيمالي',
  Guinean: 'غيني',
  Guyanese: 'غياني',
  Haitian: 'هايتي',
  Honduran: 'هندوراسي',
  Hungarian: 'مجري',
  Icelander: 'آيسلندي',
  Indian: 'هندي',
  Indonesian: 'إندونيسي',
  Iranian: 'إيراني',
  Iraqi: 'عراقي',
  Irish: 'أيرلندي',
  Italian: 'إيطالي',
  Ivorian: 'إيفواري',
  Jamaican: 'جامايكي',
  Japanese: 'ياباني',
  Jordanian: 'أردني',
  Kazakhstani: 'كازاخستاني',
  Kenyan: 'كيني',
  Kittitian: 'من سانت كيتس ونيفيس',
  Kuwaiti: 'كويتي',
  Kyrgyz: 'قيرغيزي',
  Laotian: 'لاوسي',
  Latvian: 'لاتفي',
  Lebanese: 'لبناني',
  Liberian: 'ليبيري',
  Libyan: 'ليبي',
  Liechtensteiner: 'ليختنشتايني',
  Lithuanian: 'ليتواني',
  Luxembourger: 'لوكسمبورغي',
  Macedonian: 'مقدوني',
  Malagasy: 'مدغشقري',
  Malawian: 'مالاوي',
  Malaysian: 'ماليزي',
  Maldivian: 'مالديفي',
  Malian: 'مالي',
  Maltese: 'مالطي',
  Marshallese: 'من جزر مارشال',
  Mauritanian: 'موريتاني',
  Mauritian: 'موريشيوسي',
  Mexican: 'مكسيكي',
  Micronesian: 'ميكرونيزي',
  Moldovan: 'مولدوفي',
  Monacan: 'موناكي',
  Mongolian: 'منغولي',
  Montenegrin: 'مونتينيغري',
  Moroccan: 'مغربي',
  Mozambican: 'موزمبيقي',
  Namibian: 'ناميبي',
  Nauruan: 'ناوروي',
  Nepalese: 'نيبالي',
  'New Zealander': 'نيوزيلندي',
  Nicaraguan: 'نيكاراغوي',
  Nigerian: 'نيجيري',
  Nigerien: 'نيجري',
  'North Korean': 'كوري شمالي',
  Norwegian: 'نرويجي',
  Omani: 'عماني',
  Pakistani: 'باكستاني',
  Palauans: 'بالاوي',
  Palestinian: 'فلسطيني',
  Panamanian: 'بنمي',
  'Papua New Guinean': 'من بابوا غينيا الجديدة',
  Paraguayan: 'باراغواياني',
  Peruvian: 'بيروفي',
  Polish: 'بولندي',
  Portuguese: 'برتغالي',
  Qatari: 'قطري',
  Romanian: 'روماني',
  Russian: 'روسي',
  Rwandan: 'رواندي',
  'Saint Lucian': 'من سانت لوسيا',
  Salvadoran: 'سلفادوري',
  Samoan: 'ساموي',
  'San Marinese': 'سان ماريني',
  'Sao Tomean': 'من ساو تومي وبرينسيب',
  Saudi: 'سعودي',
  Senegalese: 'سنغالي',
  Serbian: 'صربي',
  Seychellois: 'سيشيلي',
  'Sierra Leonean': 'سيراليوني',
  Singaporean: 'سنغافوري',
  Slovak: 'سلوفاكي',
  Slovenian: 'سلوفيني',
  'Solomon Islander': 'من جزر سليمان',
  Somali: 'صومالي',
  'South African': 'جنوب أفريقي',
  'South Korean': 'كوري جنوبي',
  'South Sudanese': 'جنوب سوداني',
  Spanish: 'إسباني',
  'Sri Lankan': 'سريلانكي',
  Sudanese: 'سوداني',
  Surinamer: 'سورينامي',
  Swazi: 'إسواتيني',
  Swedish: 'سويدي',
  Swiss: 'سويسري',
  Syrian: 'سوري',
  Taiwanese: 'تايواني',
  Tajik: 'طاجيكي',
  Tanzanian: 'تنزاني',
  Thai: 'تايلاندي',
  Togolese: 'توغولي',
  Tongan: 'تونغي',
  Trinidadian: 'ترينيدادي',
  Tunisian: 'تونسي',
  Turkish: 'تركي',
  Turkmen: 'تركماني',
  Tuvaluan: 'توفالي',
  Ugandan: 'أوغندي',
  Ukrainian: 'أوكراني',
  Uruguayan: 'أوروغواياني',
  Uzbek: 'أوزبكي',
  Vanuatuans: 'فانواتي',
  Venezuelan: 'فنزويلي',
  Vietnamese: 'فيتنامي',
  Yemeni: 'يمني',
  Zambian: 'زامبي',
  Zimbabwean: 'زيمبابوي',
};

/** Arabic for each English nationality given; one without an entry is left out. */
export function nationalityLabelsAr(names: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const name of names) {
    const arabic = Object.prototype.hasOwnProperty.call(NATIONALITY_AR, name)
      ? NATIONALITY_AR[name]
      : undefined;
    if (arabic) labels[name] = arabic;
  }
  return labels;
}
