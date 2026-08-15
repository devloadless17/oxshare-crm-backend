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
