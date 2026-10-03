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

/**
 * The four built-in steps. Personal answers live on the profile (`users`); the
 * identity document, selfie and proof of address live in the client's identity
 * record (0151/0171), never in submission columns.
 */
export const BUILT_IN_STEP_SLUGS = ['personal', 'document', 'selfie', 'address'] as const;

export type DataBearingStepSlug = (typeof BUILT_IN_STEP_SLUGS)[number];

export function isDataBearingStep(slug: string): slug is DataBearingStepSlug {
  return (BUILT_IN_STEP_SLUGS as readonly string[]).includes(slug);
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
 * Only `review` does not. Every other slug stores something: the four built-in
 * ones on the profile or the identity record, the rest under their slug in
 * `step_data`.
 */
export function collectsAnswers(slug: string): boolean {
  return slug !== REVIEW_STEP_SLUG;
}

/**
 * A field that holds an UPLOADED FILE rather than a typed answer.
 *
 * `file` and `camera` are the two base types that produce one, and every
 * `doc:<value>` type is a document by construction (`documentFieldType`). The
 * check is on the TYPE rather than a name allowlist because a custom step's
 * fields are named by the builder — `customField_<timestamp>` — so there is no
 * name to recognise, which is exactly how `POST /kyc/upload` came to refuse
 * every custom document with `Unknown file field`.
 */
export function isFileField(field: { type?: string }): boolean {
  const type = field.type ?? '';
  return type === 'file' || type === 'camera' || type.startsWith('doc:');
}

/**
 * One answer inside a custom step.
 *
 * A typed answer is a string. A File or Camera field stores what the serving
 * route needs instead: `filePath`, which `GET /uploads/kyc/:file` resolves (and
 * the ownership check scans). What the client called the file is not kept
 * (0160, D-84) — it carried names and document numbers, and a reviewer reads
 * the question it answers instead.
 *
 * The union is deliberately narrow. `stepData` is written from a client-facing
 * route, so widening it to `unknown` would make every reader guess.
 */
export type KycStoredFile = { filePath: string };
export type KycStepAnswer = string | KycStoredFile;
export type KycStepData = Record<string, Record<string, KycStepAnswer>>;

/** Narrows a stored answer to an uploaded file. */
export function isStoredFile(value: unknown): value is KycStoredFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as KycStoredFile).filePath === 'string'
  );
}
