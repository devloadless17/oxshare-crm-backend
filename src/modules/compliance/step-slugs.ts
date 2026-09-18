/**
 * Which step slugs this system can actually STORE an answer for.
 *
 * ## Not a policy list — a mechanical one
 *
 * `admin-compliance.service.ts` records that the mandatory-step rule was
 * deliberately dropped: "a configurable flow that refuses to drop four of its
 * steps is not configurable, and the broker — not this service — owns which
 * jurisdiction needs what." That decision stands and nothing here reinstates it.
 * A broker may delete the address step, reorder the flow, or run two steps.
 *
 * This is the different question underneath it: a submission's answers are
 * stored in a COLUMN PER STEP (`personal_info`, `document`, `selfie`,
 * `address_proof`), so a step whose slug is not one of these has nowhere to put
 * what the client types. `KycService.saveStep` ends in
 * `throw new ValidationError('Unknown step: …')`, and until now the builder
 * would happily save such a step: the console showed a valid-looking form and
 * every client who reached it got an error the moment they pressed Continue.
 *
 * So the rule is not "you must have these steps". It is "a step you keep must
 * be one whose answers can be written down".
 *
 * ## Why the mapping lives here and not in `saveStep`
 *
 * It was an if/else chain inside `saveStep`, which meant the set of storable
 * slugs was implicit in a dispatch nobody else could read. Two lists that agree
 * today is the drift this file exists to prevent — the validator and the writer
 * now read the same one, so a new step column cannot be added to one and missed
 * by the other.
 */

/** Slug → the submission column its answers are written to. */
export const STEP_STORAGE_COLUMN = {
  personal: 'personalInfo',
  document: 'document',
  selfie: 'selfie',
  address: 'addressProof',
} as const satisfies Record<string, string>;

export type DataBearingStepSlug = keyof typeof STEP_STORAGE_COLUMN;

export function isDataBearingStep(slug: string): slug is DataBearingStepSlug {
  return Object.prototype.hasOwnProperty.call(STEP_STORAGE_COLUMN, slug);
}

/**
 * The summary screen. It has a slug and a position in the flow, and it collects
 * NOTHING — the portal renders it from answers already given — so it is storable
 * in the only sense that matters: keeping it breaks nothing.
 */
export const REVIEW_STEP_SLUG = 'review';

/** Every slug a saved configuration may legitimately contain. */
export function isKnownStepSlug(slug: string): boolean {
  return isDataBearingStep(slug) || slug === REVIEW_STEP_SLUG;
}

/** The storable slugs, for a message that tells an operator what to use. */
export const KNOWN_STEP_SLUGS: readonly string[] = [
  ...Object.keys(STEP_STORAGE_COLUMN),
  REVIEW_STEP_SLUG,
];
