/**
 * What a KYC profile must contain before it can be submitted — a pure seam.
 *
 * No Nest, no Drizzle, no fs: the caller passes the values and the field
 * configuration in, so this is unit-testable without a container.
 *
 * ## Why it exists
 *
 * FR-IND-03 requires an individual to "maintain a personal profile (including
 * date of birth and address)" before reaching level 1, and the seeded profile
 * step asks for a date of birth with the hint `Must be 18+`.
 *
 * None of that was enforced anywhere on the server. The chain, as it stood:
 *
 *   1. `SaveKycStepDto` declares `data: Record<string, unknown>` with `@IsObject()`
 *      and nothing else — deliberately, because the step set is admin-configurable
 *      and a hardcoded enum would reject a valid custom step. So the global
 *      ValidationPipe validated no field of any step.
 *   2. `saveStep()` merged the payload into the stored blob without consulting the
 *      step's configured `fields` at all, so `required: true` was decoration.
 *   3. `submit()` tested `!finalSub.personalInfo` — the truthiness of an OBJECT.
 *      `{}` is truthy.
 *
 * Which meant this sequence returned 200 at every step:
 *
 *     POST /kyc/step   { "step": "personal", "data": {} }
 *     POST /kyc/upload × 3
 *     POST /kyc/submit
 *
 * — a submission reaching the review queue with no name, no date of birth and no
 * address, behind three genuine document images. The only remaining control was
 * the reviewer noticing an empty personal-information card.
 *
 * The age rule was weaker still. `Must be 18+` is a hint string rendered as
 * placeholder text (`kyc-config.store.ts`), and the actual check lived in the
 * client portal (`app/kyc/step/[step]/page.tsx`), in the browser, bypassed by any
 * direct API call. A broker onboarding a minor is a licensing matter, not a bug
 * report, and the rule was enforced by a form.
 *
 * ## Why the rules come from the configuration
 *
 * The required set is read from the step's own `fields` rather than hardcoded
 * here, because the admin KYC builder owns that configuration (D-29). Hardcoding
 * it would mean the API enforced one thing while the portal rendered another —
 * which is the class of defect this file exists to close, reintroduced from the
 * other side.
 */

import { isBarePhonePrefix, isCompletePhone } from './kyc-answers';
import { isFileField } from './step-slugs';

/**
 * The minimum age to hold an account.
 *
 * An ASSUMPTION, not a specification: no authoritative document states a minimum
 * age, and none states whether it varies by country of residence. 18 is what the
 * seeded profile step's hint has always claimed and what the client portal has
 * always enforced, so this makes the server agree with both rather than inventing
 * a third answer. It is deliberately a constant and not configuration — a rule
 * nobody has written down should not acquire an environment variable before it
 * acquires a decision.
 */
export const MINIMUM_AGE_YEARS = 18;

/** A field as the KYC configuration describes it — the subset this module needs. */
export interface ProfileFieldRule {
  name: string;
  label: string;
  type: string;
  required: boolean;
  /** A checkbox with choices is "tick all that apply" — see `tickedChoices`. */
  options?: readonly string[];
}

/** What a caller must fix, or `undefined` when the profile is acceptable. */
export interface ProfileProblem {
  /** Stable, for the error envelope's details. */
  kind: 'missing_fields' | 'underage' | 'invalid_date_of_birth' | 'invalid_phone';
  message: string;
  /** Field names the client must fill, for `missing_fields`. */
  fields?: string[];
}

/**
 * The value as a trimmed string, or `undefined` if it is not a scalar.
 *
 * The blob is `jsonb`, so a value can be an object or an array. `String(value)`
 * on those yields `'[object Object]'` and `'a,b'` — both non-empty, so a naive
 * blank check would accept `{"firstName": {}}` as a name. Narrowing to the three
 * scalar types first means a structured value is treated as absent, which is the
 * only safe reading: nothing downstream can render it as a name or parse it as a
 * date either.
 */
function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Blank, whitespace, absent and non-scalar all mean "not provided". */
function isBlank(value: unknown): boolean {
  return scalar(value) === undefined;
}

/** A phone field holding a country code and nothing after it — see `isBarePhonePrefix`. */
function isBarePhone(field: ProfileFieldRule, value: unknown): boolean {
  const text = scalar(value);
  return field.type === 'phone' && text !== undefined && isBarePhonePrefix(text);
}

/**
 * Whole years between `dateOfBirth` and `asOf`.
 *
 * Calendar arithmetic rather than `(now - dob) / MS_PER_YEAR`: the division form
 * is wrong across leap years, and it is wrong in the direction that admits
 * someone a day early. Someone born on 29 February turns 18 on 1 March in a
 * common year, which is what subtracting the calendar parts gives.
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
 * Is this profile submittable?
 *
 * Returns the first problem found, or `undefined`. Deliberately not a thrower:
 * this is the pure half, and mapping a problem onto a `DomainError` belongs to
 * the service, which is the layer allowed to know about them.
 *
 * `values` is the stored `personalInfo` blob, which is why everything is
 * `unknown` — it is `jsonb` and its shape is whatever the configuration asked
 * for.
 */
export function findProfileProblem(
  values: Record<string, unknown> | undefined,
  rules: readonly ProfileFieldRule[],
  asOf: Date,
): ProfileProblem | undefined {
  const provided = values ?? {};

  // File, camera and document fields are satisfied by an uploaded path, not by
  // a value in this blob — `submit()` checks those separately, and demanding
  // them here would reject every complete submission.
  const missing = rules
    .filter((f) => f.required && !isFileField(f))
    .filter((f) => !isAnswered(f, provided[f.name]))
    .map((f) => f.name);

  if (missing.length > 0) {
    return {
      kind: 'missing_fields',
      message: `These profile fields are required before submitting: ${missing.join(', ')}.`,
      fields: missing,
    };
  }
  return profileValueProblem(provided, rules, asOf);
}

/**
 * Is a REQUIRED typed field answered? One definition, shared by the profile
 * rules above and every other step (`kyc-step-state.ts`).
 *
 *  - blank is not an answer;
 *  - a phone holding only its country code is not a number (see `isBarePhone`);
 *  - a CHECKBOX is answered only when TICKED. Unticked is stored as `'false'`,
 *    which is a perfectly non-empty string — so "required" on a consent box
 *    used to be satisfied by leaving it unticked. One with CHOICES ("tick all
 *    that apply") is answered when at least one is ticked.
 */
export function isAnswered(field: ProfileFieldRule, value: unknown): boolean {
  if (field.type === 'checkbox') {
    return field.options?.length ? !isBlank(value) : scalar(value) === 'true';
  }
  return !isBlank(value) && !isBarePhone(field, value);
}

/**
 * What is wrong with the answers GIVEN — a phone number cut short, a date of
 * birth that is not a date, in the future, or under the minimum age. Missing
 * answers are `isAnswered`'s business; this judges only what is there.
 */
export function profileValueProblem(
  values: Record<string, unknown> | undefined,
  rules: readonly ProfileFieldRule[],
  asOf: Date,
): ProfileProblem | undefined {
  const provided = values ?? {};

  /*
   * A phone number must be one somebody can dial.
   *
   * Reported from production: the picker emits the country code the moment a
   * country is chosen, so "+961" alone satisfied a required field and reached
   * the reviewer as the client's phone number. A code alone counts as MISSING
   * above; anything longer must be a complete number for its country.
   */
  const badPhone = rules.find(
    (f) =>
      f.type === 'phone' &&
      !isBlank(provided[f.name]) &&
      !isBarePhone(f, provided[f.name]) &&
      !isCompletePhone(scalar(provided[f.name])!),
  );
  if (badPhone) {
    return {
      kind: 'invalid_phone',
      message: `${badPhone.label} is incomplete. Enter the full number after the country code.`,
      fields: [badPhone.name],
    };
  }

  // Only when one was supplied. Whether a date of birth is REQUIRED is the
  // configuration's call, handled above; whether a supplied one is acceptable is
  // this rule, and it applies either way — an optional date of birth that says
  // the client is fourteen is still disqualifying.
  const rawDob = scalar(provided['dateOfBirth']);
  if (rawDob === undefined) return undefined;

  const dob = new Date(rawDob);
  if (Number.isNaN(dob.getTime())) {
    return { kind: 'invalid_date_of_birth', message: 'Date of birth is not a valid date.' };
  }
  if (dob.getTime() > asOf.getTime()) {
    return { kind: 'invalid_date_of_birth', message: 'Date of birth cannot be in the future.' };
  }
  if (ageInYears(dob, asOf) < MINIMUM_AGE_YEARS) {
    return {
      kind: 'underage',
      message: `You must be at least ${MINIMUM_AGE_YEARS} years old to open an account.`,
    };
  }

  return undefined;
}
