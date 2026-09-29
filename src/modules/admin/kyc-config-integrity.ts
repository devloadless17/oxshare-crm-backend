import { FieldValidationError } from '../../common/errors/domain-errors';
import { documentForFieldType } from '../../common/kyc/document-catalogue';
import {
  CORE_STEPS,
  coreStepOf,
  customSlugProblem,
  identityField,
  IDENTITY_FIELDS,
  isDocumentField,
  isPlatformField,
  normaliseLabel,
  platformMeaningOf,
  reservedFieldName,
} from '../../common/kyc/identity-core';
import type { KycStepConfig } from '../../store/kyc-config.store';

/**
 * What a saved KYC configuration must satisfy — judged BEFORE anything is written.
 *
 * ## Two kinds of rule
 *
 * The IDENTITY CORE (`common/kyc/identity-core.ts`, the owner's ruling of
 * 26 Sep 2026): the client's identity fields, the four built-in steps and the
 * documents that prove identity and address are the platform's, fixed. A save
 * that tries to change one is refused here, in words, rather than quietly
 * normalised by the store — an operator who dragged Personal Information to
 * third place deserves to be told why it went back.
 *
 * The MECHANICAL rules that were here before: a configuration whose answers
 * would have nowhere to go, or would overwrite each other, or would switch a
 * server-side check off without anybody noticing. Every one of them was once
 * accepted, and failed later somewhere else — in the client's browser, in a
 * reviewer's card, or not at all. A configuration screen that accepts a broken
 * form and lets the client discover it is the worst place to find out, because
 * the person who typed it is not the person who hits it.
 *
 * ## Where a refusal lands
 *
 * Each one is a `FieldValidationError` keyed by where the problem is in the
 * posted configuration — `steps.2` or `steps.2.fields.0` — so the builder can
 * put the sentence under the step or field it is about. The sentences name
 * what the operator SEES (labels, titles), never a key.
 */

/** A refusal about the whole form, one step, or one field of a step. */
function refuse(message: string, step?: number, field?: number): FieldValidationError {
  const at =
    step === undefined
      ? 'steps'
      : field === undefined
        ? `steps.${step}`
        : `steps.${step}.fields.${field}`;
  return new FieldValidationError(message, { [at]: message });
}

const titleOf = (step: KycStepConfig) => step.title || step.slug;
const labelOf = (field: { label: string; name: string }) => field.label || field.name;

/**
 * Each built-in step exists exactly once — Personal Information, Identity
 * Document, Selfie and Proof of Address are where the platform files a client's
 * identity and evidence, so a second copy would be a second place for one
 * answer. Since Phase 2 (29 Sep 2026) the broker decides everything else about
 * them: the title, the order, whether it is on.
 */
export function assertCoreSteps(next: readonly KycStepConfig[]): void {
  for (const core of CORE_STEPS) {
    const found = next
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.slug === core.slug);
    if (found.length === 0) {
      throw refuse(
        `${core.title} is a built-in step and cannot be deleted. Switch it off to stop asking for it.`,
      );
    }
    if (found.length > 1) {
      throw refuse(
        `${core.title} appears ${found.length} times. Each built-in step exists once, so a client's ` +
          'answers always have one place to go.',
        found[1].index,
      );
    }
  }
}

/** Every step has a title, and no two steps share one — a client tells them apart by it. */
export function assertStepTitles(next: readonly KycStepConfig[]): void {
  const seen = new Map<string, number>();
  next.forEach((step, index) => {
    const title = step.title?.trim() ?? '';
    if (!title) throw refuse('Give this step a title.', index);
    const key = normaliseLabel(title);
    if (seen.has(key)) {
      throw refuse(
        `Two steps are called "${title}". Give each its own title, so a client can tell them apart.`,
        index,
      );
    }
    seen.set(key, index);
  });
}

/**
 * EVERY STEP HAS ITS OWN ADDRESS, AND KEEPS IT.
 *
 * A step's slug is where its answers are filed (`step_data[slug]`) and the
 * address the client's browser opens. Two steps on one address would merge
 * their answers; a step moved to a new address would orphan every answer
 * already given under the old one. So a new step of the broker's takes a fresh,
 * well-formed address (the service generates one from its title), and an
 * existing step — matched by id — keeps the one it has.
 *
 * Existing addresses are not re-judged for their SHAPE: builds before this let
 * an operator type "custom slug 1", clients have answered under it, and it
 * works. Refusing it on the next save would lock the operator out of the form.
 */
export function assertStepAddresses(
  previous: readonly KycStepConfig[],
  next: readonly KycStepConfig[],
): void {
  const seen = new Map<string, string>();
  next.forEach((step, index) => {
    const clash = seen.get(step.slug);
    if (clash !== undefined) {
      throw refuse(
        `"${titleOf(step)}" and "${clash}" would share one address, and their answers one ` +
          'place. Give each step its own.',
        index,
      );
    }
    seen.set(step.slug, titleOf(step));
    if (coreStepOf(step.slug)) return;

    const before = previous.find((candidate) => candidate.id === step.id);
    if (before && before.slug !== step.slug) {
      throw refuse(
        `"${titleOf(step)}" cannot move to a new address — the answers clients already gave ` +
          'are filed under the one it has.',
        index,
      );
    }
    if (!before) {
      const problem = customSlugProblem(step.slug);
      if (problem) {
        throw refuse(
          `"${titleOf(step)}" cannot use the address "${step.slug}": ${problem}.`,
          index,
        );
      }
    }
  });
}

/**
 * The client's identity details are asked on Personal Information only, and each
 * at most once there. Where they sit and whether each is required is the
 * broker's; their names and meaning are the platform's (restored on every save).
 */
export function assertIdentityPlacements(next: readonly KycStepConfig[]): void {
  next.forEach((step, stepIndex) => {
    const placed = new Set<string>();
    step.fields.forEach((field, fieldIndex) => {
      const byName = identityField(field.name);
      const byId = IDENTITY_FIELDS.find((candidate) => candidate.id === field.id);
      const core = byName ?? byId;
      if (!core) return;
      if (step.slug !== 'personal') {
        throw refuse(
          `${core.label} is part of the client's identity, which is asked for once — on Personal ` +
            `Information. It cannot be added to "${titleOf(step)}".`,
          stepIndex,
          fieldIndex,
        );
      }
      if (field.name !== core.name) {
        throw refuse(
          `${core.label} is part of the client's identity: its name is fixed by the platform.`,
          stepIndex,
          fieldIndex,
        );
      }
      if (placed.has(core.name)) {
        throw refuse(
          `${core.label} is already on this step. Each identity detail is asked for once.`,
          stepIndex,
          fieldIndex,
        );
      }
      placed.add(core.name);
    });
  });
}

/**
 * Documents are collected where the platform files them: an identity document on
 * Identity Document, a proof of address on Proof of Address — once each, so there
 * is never a second one to tell apart from the first. Any other question, uploads
 * included, may go on any step (Phase 2). A document step that is on offers at
 * least one document.
 */
export function assertStepsHoldWhatTheyAreFor(next: readonly KycStepConfig[]): void {
  next.forEach((step, stepIndex) => {
    const core = coreStepOf(step.slug);
    step.fields.forEach((field, fieldIndex) => {
      if (!isDocumentField(field)) return;
      const document = documentForFieldType(field.type);
      if (!core?.documents) {
        throw refuse(
          `"${labelOf(field)}" is an identity or address document, and those are collected on ` +
            'the Identity Document and Proof of Address steps only. To collect another file ' +
            'here, add an Upload field.',
          stepIndex,
          fieldIndex,
        );
      }
      if (document && document.category !== core.documents) {
        throw refuse(
          `"${titleOf(step)}" cannot accept a ${document.label}: it collects ` +
            `${core.documents === 'identity' ? 'identity documents' : 'proof of address'}, and ` +
            'the file would be filed as the wrong document.',
          stepIndex,
          fieldIndex,
        );
      }
    });
    if (core?.documents) {
      const types = step.fields.filter(isDocumentField).map((field) => field.type);
      if (types.length === 0 && step.enabled !== false) {
        throw refuse(
          `"${titleOf(step)}" must accept at least one document. Switch the step off to stop asking.`,
          stepIndex,
        );
      }
      const twice = types.find((type, index) => types.indexOf(type) !== index);
      if (twice) {
        throw refuse(
          `"${titleOf(step)}" lists the ${documentForFieldType(twice)?.label ?? 'same document'} ` +
            'twice. Each document is accepted once.',
          stepIndex,
        );
      }
    }
  });
}

/**
 * THE BROKER'S OWN FIELDS: a usable key, never one the system reads by name,
 * never one another field already has — anywhere in the form.
 *
 * Across the whole form, not per step: a reviewer's flag names a field by its
 * key alone, so two fields sharing one on different steps would make "please
 * redo X" ambiguous — the reviewer returns one and the client is shown both.
 */
export function assertFieldKeys(next: readonly KycStepConfig[]): void {
  const seen = new Map<string, string>();
  next.forEach((step, stepIndex) => {
    step.fields.forEach((field, fieldIndex) => {
      if (isPlatformField(step.slug, field)) return;
      const reserved = reservedFieldName(field.name);
      if (reserved) {
        throw refuse(
          `"${labelOf(field)}" cannot be stored under "${field.name}": that is ${reserved}.`,
          stepIndex,
          fieldIndex,
        );
      }
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(field.name)) {
        throw refuse(
          `"${labelOf(field)}" has a key the form cannot store answers under. Remove the field ` +
            'and add it again.',
          stepIndex,
          fieldIndex,
        );
      }
      const clash = seen.get(field.name);
      if (clash !== undefined) {
        throw refuse(
          `"${labelOf(field)}" and "${clash}" share one key, so one answer would overwrite the ` +
            'other and a reviewer could not tell them apart. Remove one and add it again.',
          stepIndex,
          fieldIndex,
        );
      }
      seen.set(field.name, labelOf(field));
    });
  });
}

/**
 * A BROKER'S QUESTION MAY NOT ASK FOR WHAT THE PLATFORM ALREADY COLLECTS.
 *
 * The reported defect by its other door: with First Name fixed, a question
 * labelled "First name" is still a second box for the same fact — a second
 * answer that can disagree with the real one, beside it on the reviewer's
 * screen. Matched on the whole label once normalised (`platformMeaningOf`), so
 * "Employer name" and "Previous address" stay the broker's to ask.
 */
export function assertNoSecondCopies(next: readonly KycStepConfig[]): void {
  next.forEach((step, stepIndex) => {
    step.fields.forEach((field, fieldIndex) => {
      if (isPlatformField(step.slug, field)) return;
      const meaning = platformMeaningOf(field.label);
      if (meaning) {
        throw refuse(
          `"${field.label}" is already collected by the platform (${meaning}), in its fixed ` +
            'place. A second box would be a second answer that can disagree with the first.',
          stepIndex,
          fieldIndex,
        );
      }
    });
  });
}

/** Every rule, in the order whose message is most useful first. */
export function assertKycConfigIntegrity(
  previous: readonly KycStepConfig[],
  next: readonly KycStepConfig[],
): void {
  assertCoreSteps(next);
  assertStepTitles(next);
  assertStepAddresses(previous, next);
  assertIdentityPlacements(next);
  assertStepsHoldWhatTheyAreFor(next);
  assertFieldKeys(next);
  assertNoSecondCopies(next);
}
