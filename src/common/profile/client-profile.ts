import {
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} from 'libphonenumber-js/min';
import { KYC_COUNTRY_OPTIONS, KYC_NATIONALITY_OPTIONS } from '../kyc/country-options';

/**
 * THE CLIENT PROFILE — one record per person, and the rules every writer obeys.
 * A pure seam: no Nest, no Drizzle, no fs, so each rule is one assertion.
 *
 * ## Why this exists (25 Sep 2026)
 *
 * A client's identity used to live in TWO places that nothing kept equal: the
 * `users` columns (name, phone, country — written at registration and by the
 * support desk) and `kyc_submissions.personal_info` (the same name again, plus
 * date of birth, nationality and address — written by the KYC form). Approval
 * copied phone and country one way, submit copied the name the other way when
 * the KYC blob was empty, and every screen picked one of the two. A client who
 * registered as "t1" and typed "test1" into KYC held BOTH names, for ever, and
 * the admin review page showed them side by side.
 *
 * Copying harder was the wrong fix — a copy is a second answer waiting to
 * disagree. So every identity field has exactly ONE home now: its `users`
 * column. Registration writes it, the KYC personal step reads and writes it
 * (`personal_info` keeps only answers to fields a broker invented), and the
 * support desk edits it. There is nothing to keep in step.
 *
 * ## What is normalised, and what is only checked
 *
 * Normalised (the stored form is canonical, so two ways of typing the same
 * thing are the same value): whitespace trimmed and collapsed everywhere, text
 * NFC-composed so "é" typed two ways is one string, phone numbers to E.164
 * (`+96170123456` — the display format is the screen's business), postal codes
 * upper-cased.
 *
 * Only checked, never rewritten: the SPELLING of a name. "McDonald", "de la
 * Cruz" and "ALI" are each somebody's legal name as their ID prints it, and a
 * system that re-cases names gets some of them wrong in a way the client then
 * has to argue about with a reviewer.
 */

/** Every field of the profile, in the order a form presents them. */
export const PROFILE_FIELD_KEYS = [
  'firstName',
  'lastName',
  'dateOfBirth',
  'nationality',
  'phone',
  'country',
  'address',
  'city',
  'stateProvince',
  'postalCode',
] as const;

export type ProfileKey = (typeof PROFILE_FIELD_KEYS)[number];

/** A profile as the API speaks it: strings, dates as `YYYY-MM-DD`. */
export type ClientProfile = Partial<Record<ProfileKey, string>>;

/** The part of the profile the person IS, verified against their ID document. */
export const IDENTITY_KEYS: readonly ProfileKey[] = [
  'firstName',
  'lastName',
  'dateOfBirth',
  'nationality',
];

/**
 * The KYC field TYPE each profile field must keep in the builder.
 *
 * A broker may relabel, reorder, require or remove these fields — the KYC
 * configuration is theirs — but not change what KIND of value they hold,
 * because the value lands in a typed column: a "date of birth" re-typed as free
 * text would hand the date column "next spring".
 */
export const PROFILE_FIELD_TYPE: Readonly<Record<ProfileKey, string>> = {
  firstName: 'text',
  lastName: 'text',
  dateOfBirth: 'date',
  nationality: 'select',
  phone: 'phone',
  country: 'select',
  address: 'text',
  city: 'text',
  stateProvince: 'text',
  postalCode: 'text',
};

/**
 * The ONLY answers a profile drop-down can hold — the platform's lists, served
 * to every form that asks for these fields (registration, the KYC personal
 * step, the support desk's edit). A broker cannot edit them in the builder:
 * a choice the profile then refuses is a step no client can complete.
 */
export const PROFILE_CHOICES: Readonly<Partial<Record<ProfileKey, readonly string[]>>> = {
  nationality: KYC_NATIONALITY_OPTIONS,
  country: KYC_COUNTRY_OPTIONS,
};

/** The longest value each column holds — the schema's lengths, stated once. */
export const PROFILE_MAX_LENGTH: Readonly<Record<ProfileKey, number>> = {
  firstName: 100,
  lastName: 100,
  dateOfBirth: 10,
  nationality: 100,
  phone: 32,
  country: 100,
  address: 200,
  city: 100,
  stateProvince: 100,
  postalCode: 12,
};

/** Human names for the fields, for error sentences only — screens label their own. */
const LABEL: Readonly<Record<ProfileKey, string>> = {
  firstName: 'First name',
  lastName: 'Last name',
  dateOfBirth: 'Date of birth',
  nationality: 'Nationality',
  phone: 'Phone number',
  country: 'Country of residence',
  address: 'Address',
  city: 'City',
  stateProvince: 'State / Province',
  postalCode: 'Postal code',
};

/**
 * What a reviewer's correction may change on an APPROVED verification
 * (`PATCH /admin/kyc/:userId/personal-info`): EVERY identity field but the
 * phone, which the desk edits directly because no document proves it.
 *
 * It was the date of birth and the address only, and a misspelt surname on an
 * approved client had no remedy but a rejection — which takes the money gate
 * away for a typo. The owner's ruling (26 Sep 2026): a reviewer holding
 * `kyc.identity.correct` corrects any field, with a REASON, re-checked by the
 * profile's rules, recorded on the verification, and the client told. A
 * material change — a new passport, a move abroad — is a re-verification
 * instead (`KycReviewService.requestReverification`), which the reviewer chooses.
 *
 * `KycClientService.resetKyc` names this remedy to the client, in words that must
 * stay true to this list.
 */
export const KYC_CORRECTABLE_KEYS: readonly ProfileKey[] = PROFILE_FIELD_KEYS.filter(
  (key) => key !== 'phone',
);

/**
 * HOW AN ADMIN MAY CHANGE ONE DETAIL, by where the client's verification is.
 *
 *  - `free`: edited like any record — the client's own until they submit,
 *    and always the phone, which is contact rather than identity (no document
 *    proves it).
 *  - `held`: a reviewer is checking it against the documents right now, or it
 *    was verified and this admin may not correct verified details. The
 *    sentence says which, in place.
 *  - `correction`: it was VERIFIED and this admin may correct it
 *    (`kyc.identity.correct`). It changes only with a reason, is re-checked by
 *    the profile's rules, is recorded on the verification, the client is told,
 *    and the client STAYS verified.
 *
 * ⚠️ No sentence here sends anybody to another screen. Until 28 Sep 2026 a
 * verified detail answered "Use Correct details on the client's KYC review",
 * and the client page turned that into a link away from the record the admin
 * was editing. The owner reported it: editing a client is done ON the client.
 */
export type AdminEditRule =
  { kind: 'free' } | { kind: 'correction' } | { kind: 'held'; sentence: string };

export function adminEditRule(
  key: ProfileKey,
  verification: string | undefined,
  mayCorrect: boolean,
): AdminEditRule {
  if (key === 'phone') return { kind: 'free' };
  if (verification === 'submitted' || verification === 'under_review') {
    return {
      kind: 'held',
      sentence:
        `${LABEL[key]} is being checked against the client's documents right now. ` +
        'It can change once the reviewer decides.',
    };
  }
  if (verification === 'approved') {
    return mayCorrect
      ? { kind: 'correction' }
      : {
          kind: 'held',
          sentence:
            `${LABEL[key]} was verified by KYC. Only an admin who may correct verified ` +
            'details can change it.',
        };
  }
  return { kind: 'free' };
}

/** The `held` fields among `keys`, each with its sentence — empty when none is. */
export function heldFields(
  keys: readonly ProfileKey[],
  verification: string | undefined,
  mayCorrect: boolean,
): Partial<Record<ProfileKey, string>> {
  const held: Partial<Record<ProfileKey, string>> = {};
  for (const key of keys) {
    const rule = adminEditRule(key, verification, mayCorrect);
    if (rule.kind === 'held') held[key] = rule.sentence;
  }
  return held;
}

/** The fields among `keys` that change only as a correction, with a reason. */
export function correctionFields(
  keys: readonly ProfileKey[],
  verification: string | undefined,
  mayCorrect: boolean,
): ProfileKey[] {
  return keys.filter((key) => adminEditRule(key, verification, mayCorrect).kind === 'correction');
}

export function isProfileKey(key: string): key is ProfileKey {
  return (PROFILE_FIELD_KEYS as readonly string[]).includes(key);
}

/**
 * The minimum age to hold an account.
 *
 * An ASSUMPTION carried over unchanged from `kyc-profile.ts`, which records why
 * it is a constant rather than configuration: no authoritative document states
 * a minimum age, and 18 is what the product has always told clients.
 */
export const MINIMUM_AGE_YEARS = 18;

/** Nobody alive was born before this; an older date is a typo. */
const MAXIMUM_AGE_YEARS = 120;

const COUNTRIES: ReadonlySet<string> = new Set(KYC_COUNTRY_OPTIONS);
const NATIONALITIES: ReadonlySet<string> = new Set(KYC_NATIONALITY_OPTIONS);

/*
 * A NAME is letters, and the marks, spaces, apostrophes, hyphens and full stops
 * that join them: "O'Brien", "Jean-Luc", "St. John", "Nuñez", "محمد". It must
 * start with a letter and may not contain a digit or a symbol — "t1" is a test
 * value, not a legal name, and a reviewer comparing it to a passport has nothing
 * to compare.
 */
const NAME = /^\p{L}[\p{L}\p{M}'’. -]*$/u;
/** A city may carry a number — "6th of October City" — but must name something. */
const CITY = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}'’.() -]*$/u;
const HAS_LETTER = /\p{L}/u;
/**
 * A state, province or region, typed by the client (free text, the owner's
 * call): "California", "Île-de-France", "Mount Lebanon", "Washington, D.C.".
 * Starts with a letter; a comma is allowed, which a city's rule does not need.
 */
const STATE_PROVINCE = /^\p{L}[\p{L}\p{M}\p{N}'’.,() -]*$/u;
/** No control characters anywhere: they hide text from the person reading it. */
const CONTROL = /\p{Cc}/u;
/** Letters and digits first, then spaces or hyphens — "10001", "SW1A 1AA", "1100-2080". */
const POSTAL_CODE = /^[A-Z0-9][A-Z0-9 -]{0,10}[A-Z0-9]$|^[A-Z0-9]$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Trimmed, internal whitespace collapsed to one space, NFC-composed. */
function tidy(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** A `YYYY-MM-DD` string as a UTC date, or undefined when it is not a real day. */
export function parseCalendarDate(value: string): Date | undefined {
  const match = ISO_DATE.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 31 February into March; a real day survives the round trip.
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : undefined;
}

/**
 * Whole years between two dates — calendar arithmetic, never a division, so a
 * leap-day birthday turns 18 on 1 March in a common year and not a day early.
 */
export function ageInYears(dateOfBirth: Date, asOf: Date): number {
  let age = asOf.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = asOf.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && asOf.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * Why a phone number cannot be stored, in the terms of the forms that send it —
 * or undefined when it is dialable.
 *
 * Every form picks the country code from a list beside the digits. The single
 * sentence this replaced — "Enter a complete phone number, including the
 * country code" — blamed the one part the client had already given, when the
 * digits after it were what was wrong (reported 29 Sep 2026: +961 and "7150").
 * libphonenumber tells too short from too long from a code that does not exist,
 * at the same version the portal validates with, so each gets its own sentence.
 */
export function phoneProblem(value: string): string | undefined {
  const text = value.trim();
  if (!text.startsWith('+')) return 'Choose the country code, then enter the number after it.';
  if (isValidPhoneNumber(text)) return undefined;

  const bare = /^\+(\d{1,4})$/.exec(text.replace(/\s/g, ''));
  if (bare) return `Enter the phone number after +${bare[1]}.`;

  const code = parsePhoneNumberFromString(text)?.countryCallingCode;
  const after = code ? `after +${code}` : 'after the country code';
  switch (validatePhoneNumberLength(text)) {
    case 'TOO_SHORT':
      return `This phone number is too short. Enter all the digits ${after}.`;
    case 'TOO_LONG':
      return `This phone number is too long. Check the digits ${after}.`;
    case 'INVALID_COUNTRY':
      return 'That country code does not exist. Choose the country from the list.';
    default:
      return `This is not a valid phone number. Check the digits ${after}.`;
  }
}

/** A phone number in E.164 (`+96170123456`), or undefined when it is not dialable. */
export function toE164(value: string): string | undefined {
  const text = value.trim();
  if (!text.startsWith('+') || !isValidPhoneNumber(text)) return undefined;
  return parsePhoneNumberFromString(text)?.number;
}

/**
 * What is wrong with one field's value, or the value as it must be stored.
 * `code` names the rules a caller branches on — an underage date of birth is a
 * compliance event, not a typo — and is absent for the ordinary "not valid".
 */
export type FieldOutcome =
  | { ok: true; value: string }
  | { ok: false; message: string; code?: 'underage' | 'invalid_date_of_birth' | 'invalid_phone' };

/**
 * Check and normalise ONE non-empty value. Emptiness is the caller's question
 * (`checkProfile`), because whether a blank is allowed depends on who is asking.
 */
export function normaliseProfileValue(key: ProfileKey, raw: string, asOf: Date): FieldOutcome {
  const value = tidy(raw);
  const label = LABEL[key];
  if (CONTROL.test(raw))
    return { ok: false, message: `${label} contains characters we cannot store.` };

  switch (key) {
    case 'firstName':
    case 'lastName': {
      if (value.length > PROFILE_MAX_LENGTH[key]) {
        return {
          ok: false,
          message: `${label} must be at most ${PROFILE_MAX_LENGTH[key]} characters.`,
        };
      }
      if (!NAME.test(value)) {
        return {
          ok: false,
          message: `${label} may contain only letters, spaces, hyphens and apostrophes — exactly as on your ID.`,
        };
      }
      return { ok: true, value };
    }

    case 'dateOfBirth': {
      const date = parseCalendarDate(value);
      if (!date) {
        return {
          ok: false,
          message: 'Enter your date of birth as a real date (YYYY-MM-DD).',
          code: 'invalid_date_of_birth',
        };
      }
      if (date.getTime() > asOf.getTime()) {
        return {
          ok: false,
          message: 'Date of birth cannot be in the future.',
          code: 'invalid_date_of_birth',
        };
      }
      const age = ageInYears(date, asOf);
      if (age < MINIMUM_AGE_YEARS) {
        return {
          ok: false,
          message: `You must be at least ${MINIMUM_AGE_YEARS} years old to open an account.`,
          code: 'underage',
        };
      }
      if (age > MAXIMUM_AGE_YEARS) {
        return {
          ok: false,
          message: 'Check the year of your date of birth.',
          code: 'invalid_date_of_birth',
        };
      }
      return { ok: true, value };
    }

    case 'phone': {
      const e164 = toE164(value);
      if (!e164) {
        return {
          ok: false,
          message: phoneProblem(value) ?? 'Enter a valid phone number.',
          code: 'invalid_phone',
        };
      }
      return { ok: true, value: e164 };
    }

    case 'country':
      return COUNTRIES.has(value)
        ? { ok: true, value }
        : { ok: false, message: 'Choose your country of residence from the list.' };

    case 'nationality':
      return NATIONALITIES.has(value)
        ? { ok: true, value }
        : { ok: false, message: 'Choose your nationality from the list.' };

    case 'address': {
      if (value.length < 3 || !(HAS_LETTER.test(value) || /\p{N}/u.test(value))) {
        return { ok: false, message: 'Enter your street address — building, street and area.' };
      }
      if (value.length > PROFILE_MAX_LENGTH.address) {
        return {
          ok: false,
          message: `Address must be at most ${PROFILE_MAX_LENGTH.address} characters.`,
        };
      }
      return { ok: true, value };
    }

    case 'city': {
      if (value.length > PROFILE_MAX_LENGTH.city || !CITY.test(value) || !HAS_LETTER.test(value)) {
        return { ok: false, message: 'Enter the name of your city or town.' };
      }
      return { ok: true, value };
    }

    case 'stateProvince': {
      if (value.length > PROFILE_MAX_LENGTH.stateProvince || !STATE_PROVINCE.test(value)) {
        return { ok: false, message: 'Enter your state, province or region.' };
      }
      return { ok: true, value };
    }

    case 'postalCode': {
      const upper = value.toUpperCase();
      if (!POSTAL_CODE.test(upper)) {
        return {
          ok: false,
          message:
            'Enter a postal code using letters, numbers, spaces or hyphens (for example 1103 or SW1A 1AA).',
        };
      }
      return { ok: true, value: upper };
    }
  }
}

/**
 * The result of checking a set of profile values: what to store, and what is
 * wrong, per field. `values` carries a NULL for a field that was deliberately
 * cleared, so a writer can tell "clear it" from "not mentioned".
 */
export interface ProfileCheck {
  values: Partial<Record<ProfileKey, string | null>>;
  errors: Partial<Record<ProfileKey, string>>;
}

/**
 * Check a set of profile values — a registration, a KYC step, a desk edit.
 *
 * `input` holds only the fields the caller is WRITING; a key that is absent is
 * left alone, a key that is blank means "clear it". `required` names the fields
 * that may not be blank. First and last name are never clearable, whoever asks:
 * the columns are NOT NULL and every screen and audit row names the person by
 * them. Nor is the country (0193): it is NOT NULL too, and it is the client's
 * country TAG — clearing it would take them out of every country desk.
 */
export function checkProfile(
  input: Partial<Record<ProfileKey, unknown>>,
  options: { required?: readonly ProfileKey[]; asOf?: Date } = {},
): ProfileCheck {
  const asOf = options.asOf ?? new Date();
  const required = new Set<ProfileKey>([
    ...(options.required ?? []),
    'firstName',
    'lastName',
    'country',
  ]);
  const values: ProfileCheck['values'] = {};
  const errors: ProfileCheck['errors'] = {};

  for (const key of PROFILE_FIELD_KEYS) {
    if (!(key in input)) continue;
    const raw = input[key];
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      errors[key] = `${LABEL[key]} must be text.`;
      continue;
    }
    const text = typeof raw === 'string' ? tidy(raw) : '';
    if (text === '') {
      if (required.has(key)) errors[key] = `${LABEL[key]} is required.`;
      else values[key] = null;
      continue;
    }
    const outcome = normaliseProfileValue(key, text, asOf);
    if (outcome.ok) values[key] = outcome.value;
    else errors[key] = outcome.message;
  }

  // A required field the caller did not send at all is as missing as a blank one.
  for (const key of options.required ?? []) {
    if (!(key in input)) errors[key] ??= `${LABEL[key]} is required.`;
  }

  return { values, errors };
}

/** The first problem, as one sentence — for a response's top-level `message`. */
export function firstProfileError(errors: ProfileCheck['errors']): string | undefined {
  for (const key of PROFILE_FIELD_KEYS) {
    const message = errors[key];
    if (message) return message;
  }
  return undefined;
}

/**
 * A NEW country or nationality must be one the broker OFFERS (0178). Only
 * values that change are asked — a client keeps whatever they already hold,
 * however the list changes. Returns the refusals, keyed like `checkProfile`.
 */
export function offeredProblems(
  changes: Partial<Record<ProfileKey, string | null>>,
  offered: { countries: readonly string[]; nationalities: readonly string[] },
): Partial<Record<ProfileKey, string>> {
  const problems: Partial<Record<ProfileKey, string>> = {};
  const country = changes.country;
  if (country && !offered.countries.includes(country)) {
    problems.country = `${country} is not one of the countries we accept. Choose one from the list.`;
  }
  const nationality = changes.nationality;
  if (nationality && !offered.nationalities.includes(nationality)) {
    problems.nationality = `${nationality} is not one of the nationalities we accept. Choose one from the list.`;
  }
  return problems;
}
