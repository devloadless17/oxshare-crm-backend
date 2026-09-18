import { ValidationError } from '../../common/errors/domain-errors';
import { KNOWN_STEP_SLUGS, isKnownStepSlug } from '../compliance/step-slugs';
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
 * A step whose slug has no storage column.
 *
 * The builder saved these happily and `KycService.saveStep` threw
 * `Unknown step: …` at the client — so the console showed a valid form and
 * every client who reached that step was stopped by an error nobody configuring
 * it could see.
 */
export function assertStepSlugsStorable(steps: readonly KycStepConfig[]): void {
  const unknown = steps.map((s) => s.slug).filter((slug) => !isKnownStepSlug(slug));
  if (unknown.length === 0) return;

  throw new ValidationError(
    `A step's URL slug decides where its answers are stored, and ` +
      `${unknown.map((s) => `"${s}"`).join(', ')} ${unknown.length === 1 ? 'is not' : 'are not'} ` +
      `one this system can store: clients would reach the step and be refused when they ` +
      `press Continue. Use one of ${KNOWN_STEP_SLUGS.join(', ')}.`,
  );
}

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

/** Every rule, in the order whose message is most useful first. */
export function assertKycConfigIntegrity(
  previous: readonly KycStepConfig[],
  next: readonly KycStepConfig[],
): void {
  assertStepSlugsStorable(next);
  assertFieldKeysUniquePerStep(next);
  assertReservedKeysNotRenamed(previous, next);
}
