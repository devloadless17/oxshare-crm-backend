import { FieldValidationError } from '../../common/errors/domain-errors';
import { documentForFieldType } from '../../common/kyc/document-catalogue';
import {
  CORE_STEPS,
  coreStepOf,
  coreTitleMatching,
  customSlugProblem,
  identityField,
  IDENTITY_FIELDS,
  isDocumentField,
  isPlatformField,
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
 * THE FOUR BUILT-IN STEPS: each exactly once, never renamed, Personal
 * Information first, and the two that ARE a verification never switched off.
 *
 * Missing, duplicated or retitled, a built-in step breaks what the rest of the
 * system reads by slug — the portal's uploader and camera, the reviewer's
 * document tiles, the columns the answers are stored in. Deleted, it took the
 * client's identity with it: the reported defect.
 */
export function assertCoreSteps(next: readonly KycStepConfig[]): void {
  for (const core of CORE_STEPS) {
    const found = next
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.slug === core.slug);
    if (found.length === 0) {
      throw refuse(
        core.alwaysOn
          ? `${core.title} is part of every verification and cannot be removed.`
          : `${core.title} is a built-in step and cannot be removed. Switch it off to stop asking for it.`,
      );
    }
    if (found.length > 1) {
      throw refuse(
        `${core.title} appears ${found.length} times. Each built-in step exists once, so a client's ` +
          'answers always have one place to go.',
        found[1].index,
      );
    }
    const { step, index } = found[0];
    if (core.alwaysOn && step.enabled === false) {
      throw refuse(`${core.title} is always on: a verification without it verifies nobody.`, index);
    }
    if (step.title.trim() !== core.title) {
      throw refuse(
        `${core.title} is a built-in step and keeps its name. You can reword its description.`,
        index,
      );
    }
  }
  if (next[0]?.slug !== 'personal') {
    throw refuse(
      'Personal Information comes first: every later step is checked against the identity it ' +
        'collects.',
      Math.max(
        0,
        next.findIndex((step) => step.slug === 'personal'),
      ),
    );
  }
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
    const core = coreTitleMatching(step.title);
    if (core) {
      throw refuse(
        `"${titleOf(step)}" is the name of a built-in step. Name your step for what it asks, so ` +
          'nobody confuses the two.',
        index,
      );
    }
  });
}

/**
 * THE CLIENT'S IDENTITY IS NOT EDITABLE, WHEREVER IT IS SENT.
 *
 * The store never stores the identity fields and serves them on every read, so
 * a save may leave them out entirely — the builder's round trip echoes them back
 * unchanged, which is also fine. What is refused is anything that would make a
 * second copy or a different field of them: moving one to another step, or the
 * same field (by key or by id) with another label, type or required flag, or a
 * new key on an identity field's id — each of which is a server-side check
 * switched off with the form still looking right.
 */
export function assertIdentityUnchanged(next: readonly KycStepConfig[]): void {
  next.forEach((step, stepIndex) => {
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
      if (field.name !== core.name || field.label !== core.label || field.type !== core.type) {
        throw refuse(
          `${core.label} is part of the client's identity and is fixed by the platform: its ` +
            'name and kind cannot be changed.',
          stepIndex,
          fieldIndex,
        );
      }
      if (field.required !== core.required) {
        throw refuse(
          core.required
            ? `${core.label} is always required: a verification cannot be completed without it.`
            : `${core.label} is always optional: many addresses have none.`,
          stepIndex,
          fieldIndex,
        );
      }
    });
  });
}

/**
 * EACH BUILT-IN STEP HOLDS WHAT IT IS FOR, AND NOTHING ELSE (the owner's ruling).
 *
 *  - Identity Document holds identity documents; Proof of Address holds address
 *    documents — each document once, at least one. A client has ONE passport:
 *    asking for it twice, or on a step of the broker's own, leaves two files
 *    nobody can tell apart and a second upload that silently replaces the first.
 *  - Selfie holds its camera.
 *  - Personal Information holds the identity and the broker's own QUESTIONS —
 *    never an upload, so a document a client sends is never mixed in with who
 *    they are.
 *
 * Anything else a broker wants — a bank letter, a source-of-funds form, a
 * second photo — goes on a step of their own, where it is reviewed as what it
 * is: additional information, in its own section.
 */
export function assertStepsHoldWhatTheyAreFor(next: readonly KycStepConfig[]): void {
  next.forEach((step, stepIndex) => {
    const core = coreStepOf(step.slug);
    step.fields.forEach((field, fieldIndex) => {
      if (isDocumentField(field)) {
        const document = documentForFieldType(field.type);
        if (!core?.documents) {
          throw refuse(
            `"${labelOf(field)}" is an identity or address document, and those are collected on ` +
              'the Identity Document and Proof of Address steps only — once each, so there is ' +
              'never a second one to tell apart from the first. To collect another file here, ' +
              'add an Upload field.',
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
        return;
      }
      if (!core || isPlatformField(core.slug, field)) return;
      if (core.slug !== 'personal') {
        throw refuse(
          `"${titleOf(step)}" holds only ${
            core.slug === 'selfie' ? 'the selfie' : 'its documents'
          }. Put "${labelOf(field)}" on a step of your own.`,
          stepIndex,
          fieldIndex,
        );
      }
      if (field.type === 'file' || field.type === 'camera') {
        throw refuse(
          `"${labelOf(field)}" is an upload. Uploads go on a step of your own, so a document ` +
            'a client sends is never mixed in with their identity.',
          stepIndex,
          fieldIndex,
        );
      }
    });

    if (core?.documents) {
      const types = step.fields.filter(isDocumentField).map((field) => field.type);
      if (types.length === 0) {
        throw refuse(
          core.alwaysOn
            ? `${core.title} must accept at least one document.`
            : `${core.title} must accept at least one document. Switch the step off to stop asking.`,
          stepIndex,
        );
      }
      const twice = types.find((type, index) => types.indexOf(type) !== index);
      if (twice) {
        throw refuse(
          `${core.title} lists the ${documentForFieldType(twice)?.label ?? 'same document'} ` +
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
  assertStepAddresses(previous, next);
  assertIdentityUnchanged(next);
  assertStepsHoldWhatTheyAreFor(next);
  assertFieldKeys(next);
  assertNoSecondCopies(next);
}
