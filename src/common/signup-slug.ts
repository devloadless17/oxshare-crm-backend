import { randomBytes } from 'node:crypto';

/**
 * An administrator's sign-up link word — `/join/<slug>` (0198).
 *
 * Readable on purpose (the owner: "a slug word for each admin"): a sales
 * administrator says it on the phone, prints it on a card, puts it in a bio.
 * It is not a secret — whoever it is sent to sees it, and using somebody's link
 * only puts you in their book — so being guessable costs nothing.
 *
 * The SAME rule as the database CHECK `admins_signup_slug_ck`: lowercase
 * letters, digits, `-` and `_`; 3–32 characters; starting and ending with a
 * letter or digit. Kept here so a refusal is a sentence, not a 500.
 */
export const SIGNUP_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/;

/**
 * A link word as a person or a URL delivered it: lower-cased, with transport
 * debris (a trailing slash, quotes, spaces, `#`) removed. Undefined when nothing
 * usable is left. Used where a link ARRIVES — never to invent a slug.
 */
export function normaliseSignupSlug(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[-_]+|[-_]+$/g, '');
  return SIGNUP_SLUG_PATTERN.test(cleaned) ? cleaned : undefined;
}

/**
 * A random link word (`k7xm9q2e`), for an administrator who wants an opaque link
 * rather than their name. Generated HERE, never in a browser, so the platform
 * owns the format — the owner may later make links random-only, and only a word
 * the server made can be told apart from a typed one.
 *
 * No look-alikes (`0`/`o`, `1`/`l`): a link word is read aloud and retyped. The
 * alphabet is 32 characters exactly, so a random byte maps onto it without bias;
 * 8 characters is 32^8 ≈ 10^12 words, so a clash is a retry, not a design issue.
 */
const RANDOM_SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const RANDOM_SLUG_LENGTH = 8;

export function randomSignupSlug(): string {
  return Array.from(
    randomBytes(RANDOM_SLUG_LENGTH),
    (byte) => RANDOM_SLUG_ALPHABET[byte % RANDOM_SLUG_ALPHABET.length],
  ).join('');
}

/** Why a chosen link word is refused, or undefined when it is fine. */
export function signupSlugProblem(slug: string): string | undefined {
  if (slug.length < 3) return 'Use at least 3 characters.';
  if (slug.length > 32) return 'Use at most 32 characters.';
  if (!SIGNUP_SLUG_PATTERN.test(slug)) {
    return 'Use lowercase letters, digits, - and _, starting and ending with a letter or digit.';
  }
  return undefined;
}
