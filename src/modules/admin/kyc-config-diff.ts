import { documentForFieldType } from '../../common/kyc/document-catalogue';
import { identityField, isDocumentField } from '../../common/kyc/identity-core';
import { isProfileKey } from '../../common/profile/client-profile';
import type { KycFieldConfig, KycStepConfig } from '../../store/kyc-config.store';

/**
 * WHAT A SAVE CHANGED, in the words the builder shows — for the audit row.
 *
 * `kyc_config.replace` recorded the slug list and the enabled subset, which
 * answers "was proof of address switched off on the 12th" and nothing finer:
 * a question added, a document no longer accepted, a field made optional —
 * each changes what every client must hand over to be verified, and each left
 * the same two lists behind it. The KYC form is a compliance control; the trail
 * of who changed it has to say WHAT changed, or it only proves that somebody
 * pressed Save.
 *
 * One sentence per change, naming steps by title and fields by label. Since
 * Phase 2 the broker places the client's identity details and decides whether
 * each piece of evidence is required, so those changes are described too — an
 * identity detail by the platform's name, never a label a save could send.
 * Until 29 Sep 2026 they were skipped, and a save that stopped asking for the
 * client's nationality left `changes: []` behind it. The selfie camera never
 * appears. Pure: the two configurations in, the sentences out.
 */
export function describeKycConfigChanges(
  before: readonly KycStepConfig[],
  after: readonly KycStepConfig[],
): string[] {
  const changes: string[] = [];
  const beforeById = new Map(before.map((step) => [step.id, step]));
  const afterIds = new Set(after.map((step) => step.id));

  for (const step of before) {
    if (!afterIds.has(step.id)) changes.push(`Removed step "${step.title}"`);
  }
  for (const step of after) {
    const previous = beforeById.get(step.id);
    if (!previous) {
      changes.push(`Added step "${step.title}"${step.enabled ? '' : ' (switched off)'}`);
      for (const field of ownFields(step)) changes.push(`"${step.title}": ${describeField(field)}`);
      continue;
    }
    changes.push(...describeStepChanges(previous, step));
  }

  const kept = (steps: readonly KycStepConfig[]) =>
    steps.filter((step) => beforeById.has(step.id) && afterIds.has(step.id)).map((s) => s.id);
  const [was, now] = [kept(before), kept(after)];
  if (was.some((id, index) => now[index] !== id)) {
    changes.push(`Reordered steps: ${after.map((step) => step.title).join(' → ')}`);
  }
  return changes;
}

function describeStepChanges(before: KycStepConfig, after: KycStepConfig): string[] {
  const changes: string[] = [];
  const name = `"${after.title}"`;
  if (before.title !== after.title) changes.push(`Renamed step "${before.title}" to ${name}`);
  if (before.enabled !== after.enabled) {
    changes.push(`${after.enabled ? 'Switched on' : 'Switched off'} ${name}`);
  }
  if ((before.description ?? '') !== (after.description ?? '')) {
    changes.push(`${name}: description changed`);
  }
  if ((before.titleAr ?? '') !== (after.titleAr ?? '')) {
    changes.push(
      `${name}: Arabic title ${after.titleAr ? `set to "${after.titleAr}"` : 'removed'}`,
    );
  }
  if ((before.descriptionAr ?? '') !== (after.descriptionAr ?? '')) {
    changes.push(`${name}: Arabic description changed`);
  }
  if (
    after.slug !== 'personal' &&
    (before.evidenceRequired !== false) !== (after.evidenceRequired !== false)
  ) {
    changes.push(
      `${name}: ${after.evidenceRequired === false ? 'now optional — the client may skip it' : 'now required'}`,
    );
  }

  const asked = (step: KycStepConfig) =>
    new Map(
      step.slug === 'personal'
        ? step.fields
            .filter((field) => isProfileKey(field.name))
            .map((field) => [field.name, field])
        : [],
    );
  const [askedBefore, askedNow] = [asked(before), asked(after)];
  const detail = (key: string) => `"${identityField(key)?.label ?? key}"`;
  for (const key of askedBefore.keys()) {
    if (!askedNow.has(key)) changes.push(`${name}: no longer asks for ${detail(key)}`);
  }
  for (const [key, field] of askedNow) {
    const was = askedBefore.get(key);
    if (!was) {
      changes.push(
        `${name}: now asks for ${detail(key)} (${field.required ? 'required' : 'optional'})`,
      );
    } else if (Boolean(was.required) !== Boolean(field.required)) {
      changes.push(`${name}: ${detail(key)} is now ${field.required ? 'required' : 'optional'}`);
    }
  }

  const accepted = (step: KycStepConfig) =>
    new Set(step.fields.filter(isDocumentField).map((field) => field.type));
  const [had, has] = [accepted(before), accepted(after)];
  for (const type of has) {
    if (!had.has(type)) changes.push(`${name}: now accepts ${documentName(type)}`);
  }
  for (const type of had) {
    if (!has.has(type)) changes.push(`${name}: no longer accepts ${documentName(type)}`);
  }

  const previous = new Map(ownFields(before).map((field) => [field.id, field]));
  const current = ownFields(after);
  const currentIds = new Set(current.map((field) => field.id));
  for (const field of ownFields(before)) {
    if (!currentIds.has(field.id)) changes.push(`${name}: removed "${field.label}"`);
  }
  for (const field of current) {
    const was = previous.get(field.id);
    if (!was) {
      changes.push(`${name}: ${describeField(field)}`);
      continue;
    }
    if (was.label !== field.label) {
      changes.push(`${name}: "${was.label}" renamed to "${field.label}"`);
    }
    if (was.type !== field.type) {
      changes.push(`${name}: "${field.label}" changed from ${was.type} to ${field.type}`);
    }
    if (was.required !== field.required) {
      changes.push(`${name}: "${field.label}" is now ${field.required ? 'required' : 'optional'}`);
    }
    if (joined(was.options) !== joined(field.options)) {
      changes.push(
        `${name}: "${field.label}" choices changed to ${joined(field.options) || 'none'}`,
      );
    }
    if ((was.labelAr ?? '') !== (field.labelAr ?? '')) {
      changes.push(
        `${name}: "${field.label}" Arabic label ${field.labelAr ? `set to "${field.labelAr}"` : 'removed'}`,
      );
    }
    if ((was.hintAr ?? '') !== (field.hintAr ?? '')) {
      changes.push(`${name}: "${field.label}" Arabic hint changed`);
    }
    if (arabicChoices(was.optionsAr) !== arabicChoices(field.optionsAr)) {
      changes.push(`${name}: "${field.label}" Arabic choices changed`);
    }
  }
  return changes;
}

/** The broker's own fields — never the platform's identity, camera or documents. */
function ownFields(step: KycStepConfig): KycFieldConfig[] {
  return step.fields.filter(
    (field) =>
      !field.system &&
      !isDocumentField(field) &&
      !(step.slug === 'personal' && isProfileKey(field.name)),
  );
}

function describeField(field: KycFieldConfig): string {
  return `added "${field.label}" (${field.type}, ${field.required ? 'required' : 'optional'})`;
}

function documentName(type: string): string {
  return documentForFieldType(type)?.label ?? type;
}

/** A field's Arabic choices, comparably — order-free, since they are keyed. */
function arabicChoices(optionsAr: Readonly<Record<string, string>> | undefined): string {
  return JSON.stringify(Object.entries(optionsAr ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

function joined(options: readonly string[] | undefined): string {
  return (options ?? []).join(', ');
}
