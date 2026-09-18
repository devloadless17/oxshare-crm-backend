/**
 * Where a step's answers are stored.
 *
 * ## Four columns, and a map for everything else
 *
 * `personal_info`, `document`, `selfie` and `address_proof` are read BY NAME
 * across the system — `personalInfo.phone` and `.country` are promoted onto the
 * client record on approval, `document.frontFilePath` gates submission, and the
 * reviewer's card is built from all four. They keep their own columns because
 * rewriting every one of those read paths would buy nothing: those slugs are
 * not going anywhere.
 *
 * Anything else a broker configures goes into `step_data`, keyed by slug. That
 * is the whole of what migration 0130 added, and it is what makes a fifth step
 * work: the builder could always ADD one, and `saveStep` had nowhere to put the
 * answers, so a custom step rendered, accepted what the client typed, and failed
 * the moment they pressed Continue with `Unknown step`.
 *
 * ## This is not the mandatory-step rule
 *
 * `admin-compliance.service.ts` records that the rule was dropped on purpose —
 * "a configurable flow that refuses to drop four of its steps is not
 * configurable, and the broker owns which jurisdiction needs what." Nothing here
 * requires any step to exist. This says only where an answer LANDS once a step
 * does exist, which is why there is no longer a slug the API refuses.
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
 * NOTHING — the portal renders it from answers already given — so it stores
 * nothing and needs no entry above.
 */
export const REVIEW_STEP_SLUG = 'review';

/**
 * Does this step collect answers at all?
 *
 * Only `review` does not. Every other slug stores something: the four canonical
 * ones in their own column, the rest under their slug in `step_data`.
 */
export function collectsAnswers(slug: string): boolean {
  return slug !== REVIEW_STEP_SLUG;
}
