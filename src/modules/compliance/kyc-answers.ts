/**
 * What a client may write into their own KYC submission — a pure seam.
 *
 * No Nest, no Drizzle: the caller passes the configured fields and the posted
 * values in, so every rule here is one assertion in `kyc-answers.spec.ts`.
 *
 * ## The bug this closes
 *
 * `saveStep` merged whatever `data` held into the stored step. The portal's
 * review screen then re-posted its WHOLE form as the personal step on submit —
 * the document-choice keys (`__docChoice__document`), every custom step's
 * answers under their builder keys (`customField_1790263652846`), and each
 * uploaded file's record stringified to `"[object Object]"`. All of it landed
 * in `personal_info`, and the reviewer read "Doc Choice Document" and
 * "Custom Field 1790263652846: [object Object]" beside the client's name.
 * Reported from production.
 *
 * It was also a hole, not only a mess. `document`, `selfie` and `address_proof`
 * are columns holding FILE PATHS, and `saveStep` merged into those too — so a
 * client could post `{ frontFilePath: '<another client's upload>' }` and point
 * their own submission at somebody else's passport. A custom step's answers
 * could be forged into stored-file objects the same way.
 *
 * ## The rule
 *
 * A step stores the fields ITS CONFIGURATION names, as STRINGS, and nothing
 * else. Files arrive through `POST /kyc/upload` only, which is the one route
 * that knows a file was actually received.
 *
 * Unknown keys are DROPPED rather than refused, deliberately: the portal that
 * is live today posts that whole form, and refusing it would stop every client
 * submitting until the new portal ships. Dropping is also what the rule means —
 * a key the form never asked for is not an answer.
 *
 * A value that IS for a configured field but is not acceptable — a phone number
 * cut short, a date that does not parse — is refused, because storing it would
 * be storing a wrong answer the client believes is right.
 *
 * A `select` is NOT checked against its options. The portal offers only the
 * served list, so a mismatch means a tab holding a list the broker has since
 * edited — and refusing that client's whole profile over it would move a
 * configuration change onto somebody filling in a form.
 */
import { isValidPhoneNumber } from 'libphonenumber-js/min';
import { catalogueDocument } from '../../common/kyc/document-catalogue';
import { isFileField } from './step-slugs';

/** The part of a configured field these rules read — structural, so fixtures stay small. */
export interface AnswerField {
  name: string;
  label: string;
  type: string;
  required?: boolean;
}

/**
 * The longest typed answer a KYC field accepts.
 *
 * Generous — an address is the longest thing anybody types here — and there to
 * bound a client-facing write into a `jsonb` column, not to police prose.
 */
export const MAX_ANSWER_LENGTH = 1000;

export interface AnswerProblem {
  field: string;
  message: string;
}

export interface TypedAnswers {
  /** Accepted answers, keyed by field name. A cleared field is `''`. */
  answers: Record<string, string>;
  /** Values for configured fields that cannot be stored as given. */
  problems: AnswerProblem[];
}

/**
 * A phone value holding a calling code and nothing after it.
 *
 * The portal's picker emits `"+961"` the moment a country is chosen, before any
 * digit is typed — which is how a required phone number came to be "answered"
 * with a country code alone. It is not a phone number, so it is read as
 * nothing: an optional phone left like this is simply unanswered, and a
 * required one is missing.
 *
 * The picker writes the code, then a SPACE, then whatever was typed — so a code
 * is bare only with nothing after it. `"+961 7"` is somebody who started typing
 * and stopped, and is told the number is incomplete rather than that it is
 * missing. Four digits at most: the longest code the picker offers is `+1684`.
 */
export function isBarePhonePrefix(value: string): boolean {
  return /^\+?\d{0,4}$/.test(value.trim());
}

/**
 * Is this a dialable international number?
 *
 * libphonenumber's `min` metadata: it checks the length and the leading digits
 * for the number's country, which is exactly the class of mistake reported —
 * `+961` alone, or `+961 70 12` — without the stricter number-range patterns of
 * the `max` set, which reject real numbers the metadata is not yet aware of.
 * The portal validates with the SAME metadata at the SAME version, so a number
 * the form accepts is one the server accepts.
 */
export function isCompletePhone(value: string): boolean {
  return isValidPhoneNumber(value);
}

/**
 * The answers a step may store from what was posted, and what is wrong with them.
 *
 * `fields` are the step's CONFIGURED fields. File fields are skipped: their
 * answer is a stored file written by the upload route, and accepting one here
 * is how a forged `{ filePath }` would get in.
 */
export function typedAnswersFor(
  fields: readonly AnswerField[],
  data: Record<string, unknown>,
): TypedAnswers {
  const answers: Record<string, string> = {};
  const problems: AnswerProblem[] = [];

  for (const field of fields) {
    if (isFileField(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(data, field.name)) continue;

    const raw = data[field.name];
    // Not a string is not an answer — `String({...})` is how "[object Object]"
    // was stored as somebody's reply. Dropped, like an unknown key.
    if (typeof raw !== 'string') continue;

    let value = raw.trim();
    if (value.length > MAX_ANSWER_LENGTH) {
      problems.push({
        field: field.name,
        message: `${field.label} is too long (${MAX_ANSWER_LENGTH} characters at most).`,
      });
      continue;
    }

    if (field.type === 'phone' && isBarePhonePrefix(value)) value = '';

    const problem = value === '' ? undefined : valueProblem(field, value);
    if (problem) {
      problems.push({ field: field.name, message: problem });
      continue;
    }
    answers[field.name] = value;
  }

  return { answers, problems };
}

/** What is wrong with a non-empty value for this field's type, if anything. */
function valueProblem(field: AnswerField, value: string): string | undefined {
  switch (field.type) {
    case 'phone':
      return isCompletePhone(value)
        ? undefined
        : `${field.label} is incomplete. Enter the full number after the country code.`;
    case 'date':
      return Number.isNaN(new Date(value).getTime())
        ? `${field.label} is not a valid date.`
        : undefined;
    case 'checkbox':
      return value === 'true' || value === 'false'
        ? undefined
        : `${field.label} must be yes or no.`;
    default:
      return undefined;
  }
}

/**
 * The document type a canonical document step may record, or `undefined`.
 *
 * Only a catalogue value of the step's own CATEGORY: the identity step records
 * an identity document and the address step an address one. Anything else —
 * absent, blank, a label instead of a value, the other category — records
 * nothing, and the stored type is left as it was. Overwriting it with `''` is
 * how a step with no choice made used to erase the one that had been.
 */
export function documentTypeFor(
  category: 'identity' | 'address',
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const entry = catalogueDocument(value.trim());
  return entry?.category === category ? entry.value : undefined;
}
