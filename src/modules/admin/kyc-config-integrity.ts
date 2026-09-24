import { ValidationError } from '../../common/errors/domain-errors';
import { DOCUMENT_TYPE_PREFIX, documentForFieldType } from '../../common/kyc/document-catalogue';
import type { KycStepConfig } from '../../store/kyc-config.store';

/**
 * What a saved KYC configuration must satisfy to be a working form.
 *
 * ## These are MECHANICAL rules, not policy — and the difference is the point
 *
 * `admin-compliance.service.ts` records that the mandatory-step rule was
 * deliberately dropped: a flow that refuses to drop four of its steps is not
 * configurable, and the broker owns which jurisdiction needs what. Nothing here
 * reinstates that. A broker may delete any step, reorder the flow, drop the
 * address proof, or stop collecting a date of birth entirely.
 *
 * Each rule below refuses only a configuration that CANNOT WORK — one whose
 * answers have nowhere to go, or that silently discards an answer, or that
 * silently switches off a check. Every one of them was previously accepted, and
 * every one failed later and somewhere else: in the client's browser, in a
 * reviewer's card, or not at all.
 *
 * A configuration screen that accepts a broken form and lets the client
 * discover it is the worst place to find out, because the person who typed it
 * is not the person who hits it.
 */

/** Keys the SERVER reads by literal string. Renaming one silently disables it. */
const RESERVED_FIELD_KEYS: Readonly<Record<string, string>> = {
  /*
   * `kyc-profile.ts` reads `provided['dateOfBirth']` and returns early when it
   * is absent — so a rename does not fail, it SKIPS. The minimum-age rule stops
   * running and the form still looks right, which makes this the most expensive
   * key on the screen.
   */
  dateOfBirth: 'the minimum-age check (clients under 18 would no longer be refused)',
  /*
   * Both are promoted onto the client record on approval — `kyc.service.ts`
   * reads `personalInfo.phone` and `.country`. A rename leaves the verified
   * value in the submission and the client record showing whatever
   * registration guessed.
   */
  phone: 'promoting the verified phone number onto the client record',
  country: 'promoting the verified country onto the client record',
};

/**
 * ## NOT ENFORCED: a step slug with no storage column
 *
 * There was a rule here and it was withdrawn, because it decided a product
 * question that is not this file's to decide.
 *
 * The facts are real. Answers are written to a column per step —
 * `personal_info`, `document`, `selfie`, `address_proof` — and
 * `KycService.saveStep` refuses anything else with `Unknown step: …`. So a step
 * configured with a custom slug renders in the portal, accepts what the client
 * types, and fails when they press Continue.
 *
 * But the configuration layer advertises the opposite: `addKycStep` exists, the
 * builder offers Add Step, and `kyc-config-round-trip.spec.ts` deliberately
 * saves steps slugged `other` and `audit` to prove id assignment works for
 * steps nobody named. Refusing those made that spec fail, and made
 * `kyc-http.spec.ts`'s PERMISSION test fail for an unrelated reason — so the
 * boundary it was written to prove stopped being exercised, which is worse than
 * the gap it was papering over.
 *
 * Two honest resolutions exist and both are somebody's call, not a validator's:
 * give the submission a generic per-slug store so custom steps work, or stop
 * offering steps the storage cannot hold. Guessing in here would have shipped
 * the second one silently, under the name of a bug fix.
 *
 * The two rules below stay because neither has that problem: a duplicate key
 * and a renamed reserved key are wrong under every reading of what a step is.
 */

/**
 * Two fields sharing a key WITHIN a step.
 *
 * Answers are merged into one object per step (`{ ...existing, ...data }`), so
 * two fields with the same key are one column: the second silently overwrites
 * the first, and a reviewer sees one answer where the client gave two. Across
 * DIFFERENT steps the same key is fine — separate columns — so this is scoped
 * per step rather than globally, which is also the less disruptive rule.
 */
export function assertFieldKeysUniquePerStep(steps: readonly KycStepConfig[]): void {
  for (const step of steps) {
    const seen = new Set<string>();
    for (const field of step.fields ?? []) {
      if (seen.has(field.name)) {
        throw new ValidationError(
          `Two fields in "${step.title || step.slug}" share the key "${field.name}". ` +
            `Answers are stored under the key, so one would silently overwrite the other.`,
        );
      }
      seen.add(field.name);
    }
  }
}

/**
 * A reserved key renamed on a field that is being KEPT.
 *
 * The distinction is deliberate and it is the whole rule: DELETING the field is
 * allowed, because the broker owns whether a date of birth is collected at all.
 * What is refused is keeping the same field — same `id`, same position, same
 * label — and changing only the key, because that reads on screen as a cosmetic
 * edit and is in fact switching a server-side check off.
 *
 * Matched on `id` rather than on label or position: an id survives a rename, a
 * reorder and a relabel, which are exactly the edits that would otherwise
 * disguise this one.
 */
export function assertReservedKeysNotRenamed(
  previous: readonly KycStepConfig[],
  next: readonly KycStepConfig[],
): void {
  const nextById = new Map<string, string>();
  for (const step of next) {
    for (const field of step.fields ?? []) nextById.set(field.id, field.name);
  }

  for (const step of previous) {
    for (const field of step.fields ?? []) {
      const breaks = RESERVED_FIELD_KEYS[field.name];
      if (!breaks) continue;

      const renamedTo = nextById.get(field.id);
      // Absent from the new config = the field was removed. That is allowed.
      if (renamedTo === undefined || renamedTo === field.name) continue;

      throw new ValidationError(
        `"${field.name}" cannot be renamed to "${renamedTo}": the server reads that exact key ` +
          `for ${breaks}. Renaming it would switch that off silently — the form would still ` +
          `look correct. Remove the field instead if you no longer want to collect it.`,
      );
    }
  }
}

/** The kind of document each document step holds. Any other step holds none. */
const DOCUMENT_STEPS: Readonly<Record<string, 'identity' | 'address'>> = {
  document: 'identity',
  address: 'address',
};

function documentKindOf(slug: string): 'identity' | 'address' | undefined {
  // Own keys only: a slug is typed by an operator, and `constructor` is a step
  // they added, not an entry on the prototype chain.
  return Object.prototype.hasOwnProperty.call(DOCUMENT_STEPS, slug)
    ? DOCUMENT_STEPS[slug]
    : undefined;
}

const kindName = (kind: 'identity' | 'address') =>
  kind === 'address' ? 'proof of address' : 'an identity document';

/**
 * A catalogue document where it cannot be held — and a built-in step without
 * the one thing it exists to collect.
 *
 * ## Documents have ONE home each (reported from local testing, 25 Sep 2026)
 *
 * A passport, a national ID, a utility bill live on the identity step and the
 * proof-of-address step, where a document is stored with its type and every
 * page in typed columns — read by the review screen, the reviewer's page flags
 * and the approval. The builder also offered them on steps a broker ADDS, and
 * each attempt to give them a home there built a second, weaker copy of the
 * same machinery: the two sides of a national ID sharing one upload slot,
 * "required" on several cards meaning all of them to the server and one of them
 * to the client. So elsewhere, a File field per photo does the job — migration
 * 0137 converted the ones already configured exactly that way.
 *
 * A document of the other KIND is refused on a document step too: its pages are
 * filed by category, so a utility bill offered on the identity step would be
 * filed as the client's proof of address, over the real one. A `doc:` value the
 * catalogue no longer knows is tolerated there, as `resolveAcceptedDocuments`
 * tolerates it.
 *
 * ## Every other field goes anywhere
 *
 * Text, date, phone, dropdown, checkbox, File and Camera fields are welcome on
 * EVERY step, built-in or added: the answers of a built-in step's extra fields
 * are kept in `step_data` under its slug, checked by the one judgement that
 * gates submission (`kyc-step-state.ts`) and shown to the reviewer.
 *
 * ## What a built-in step cannot lose
 *
 * An enabled identity or address step is a promise that the client uploads one
 * of its documents, and the selfie step that they take the selfie. Offering no
 * document, or no selfie camera, leaves a step nobody can complete and a flow
 * nobody can submit — so those are refused, and disabling the step is the way
 * to stop asking.
 */
export function assertFieldsFitTheirStep(steps: readonly KycStepConfig[]): void {
  for (const step of steps) {
    const title = step.title || step.slug;
    const holds = documentKindOf(step.slug);
    const fields = step.fields ?? [];
    for (const field of fields) {
      if (!field.type?.startsWith(DOCUMENT_TYPE_PREFIX)) continue;
      const where = `"${field.label || field.name}" in "${title}"`;
      if (!holds) {
        throw new ValidationError(
          `${where} is a document type. Documents are collected on the Identity Document and ` +
            `Proof of Address steps — here, add a File field for each photo you need.`,
        );
      }
      const document = documentForFieldType(field.type);
      if (document && document.category !== holds) {
        throw new ValidationError(
          `${where} cannot collect a ${document.label}: it is ${kindName(document.category)}, ` +
            `and this step collects ${kindName(holds)} — its pages would be filed as the wrong document.`,
        );
      }
    }
    if (holds && !fields.some((field) => documentForFieldType(field.type))) {
      throw new ValidationError(
        `"${title}" offers no document to upload, so no client could complete it. ` +
          `Add one, or disable the step to stop asking.`,
      );
    }
    if (step.slug === 'selfie') {
      const selfie = fields.find((field) => field.name === 'selfie');
      if (!selfie || selfie.type !== 'camera') {
        throw new ValidationError(
          `"${title}" needs its selfie camera — without it no client could complete the step. ` +
            `Disable the step to stop asking for a selfie.`,
        );
      }
    }
  }
}

/** Every rule, in the order whose message is most useful first. */
export function assertKycConfigIntegrity(
  previous: readonly KycStepConfig[],
  next: readonly KycStepConfig[],
): void {
  assertFieldKeysUniquePerStep(next);
  assertFieldsFitTheirStep(next);
  assertReservedKeysNotRenamed(previous, next);
}
