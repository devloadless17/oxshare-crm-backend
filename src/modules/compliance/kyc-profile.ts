/**
 * Whether a verification's answers are complete — a pure seam, beside
 * `kyc-step-state.ts` (the one judge that uses it) and `kyc-answers.ts`.
 *
 * No Nest, no Drizzle, no fs: the caller passes the values in, so every rule is
 * one assertion in `kyc-profile.spec.ts`.
 *
 * ## Two kinds of answer, judged two ways (26 Sep 2026)
 *
 * The client's IDENTITY — the nine profile fields — is judged by the
 * PLATFORM's rules and nothing else: `VERIFICATION_REQUIRED` says what must be
 * there, and `normaliseProfileValue` — the very function every profile WRITE
 * goes through — says whether a value is acceptable. So:
 *
 *  - nothing the writer would refuse can pass as answered. A country typed as
 *    "Lebanon " or picked from a list the broker once edited, a phone cut
 *    short, a date of birth that makes the client fourteen — each used to have
 *    one verdict at the door and another at submission;
 *  - nothing the builder configures can switch a rule off. The required set
 *    and the minimum age used to be read from the personal step's fields, so
 *    deleting the date-of-birth field took the age check with it, and disabling
 *    the step made submission answer 500.
 *
 * The broker's OWN questions are judged by their configuration, because they
 * are the broker's: required or not, a checkbox ticked or not (`isAnswered`).
 *
 * ## History worth keeping
 *
 * FR-IND-03 requires an individual to "maintain a personal profile (including
 * date of birth and address)" before reaching level 1, and for a long time
 * nothing on the server enforced it: `submit()` tested `!personalInfo`, and `{}`
 * is truthy, so a submission with no name, no date of birth and no address
 * reached the review queue behind three genuine document images. The age rule
 * was a hint string and a check in the browser, bypassed by any direct API call
 * — and a broker onboarding a minor is a licensing matter, not a bug report.
 */
import { IDENTITY_FIELDS } from '../../common/kyc/identity-core';
import { normaliseProfileValue, type ProfileKey } from '../../common/profile/client-profile';
import { isBarePhonePrefix } from './kyc-answers';

/** A field as the KYC configuration describes it — the subset this module needs. */
export interface ProfileFieldRule {
  name: string;
  label: string;
  type: string;
  required: boolean;
  /** A checkbox with choices is "tick all that apply" — see `tickedChoices`. */
  options?: readonly string[];
}

/** What is wrong with one identity field. */
export interface IdentityProblem {
  key: ProfileKey;
  /** The platform's label for it: "Date of Birth". */
  label: string;
  kind: 'missing' | 'invalid';
  /** Ready to print. */
  message: string;
  /** For `invalid`: the rule, when a caller branches on it (`underage`, …). */
  code?: string;
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

/**
 * Every problem with the client's identity, in the order the form shows it —
 * all of them, not the first, so the client is told once rather than one
 * refusal at a time.
 */
export function identityProblems(
  profile: Readonly<Partial<Record<string, unknown>>> | undefined,
  asOf: Date,
): IdentityProblem[] {
  const problems: IdentityProblem[] = [];
  for (const field of IDENTITY_FIELDS) {
    const raw = scalar(profile?.[field.name]);
    // A phone holding only its dial code is a number nobody typed — missing, not wrong.
    const text =
      field.name === 'phone' && raw !== undefined && isBarePhonePrefix(raw) ? undefined : raw;
    if (text === undefined) {
      if (field.required) {
        problems.push({
          key: field.name,
          label: field.label,
          kind: 'missing',
          message: `${field.label} is required.`,
        });
      }
      continue;
    }
    const outcome = normaliseProfileValue(field.name, text, asOf);
    if (!outcome.ok) {
      problems.push({
        key: field.name,
        label: field.label,
        kind: 'invalid',
        message: outcome.message,
        code: outcome.code ?? 'invalid_answer',
      });
    }
  }
  return problems;
}

/**
 * Is a REQUIRED answer to one of the broker's own fields given?
 *
 *  - blank is not an answer;
 *  - a phone holding only its country code is not a number;
 *  - a CHECKBOX is answered only when TICKED. Unticked is stored as `'false'`,
 *    which is a perfectly non-empty string — so "required" on a consent box
 *    used to be satisfied by leaving it unticked. One with CHOICES ("tick all
 *    that apply") is answered when at least one is ticked;
 *  - a DROP-DOWN is answered only by one of its choices: a value the list no
 *    longer offers renders as an empty box, and must not pass as answered
 *    behind it.
 */
export function isAnswered(field: ProfileFieldRule, value: unknown): boolean {
  const text = scalar(value);
  if (field.type === 'checkbox') {
    return field.options?.length ? text !== undefined : text === 'true';
  }
  if (text === undefined) return false;
  if (field.type === 'phone' && isBarePhonePrefix(text)) return false;
  if (field.type === 'select' && field.options?.length) return field.options.includes(text);
  return true;
}
