import { documentForFieldType } from '../../common/kyc/document-catalogue';
import { isDocumentField } from '../../common/kyc/identity-core';
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
 * One sentence per change, naming steps by title and fields by label. The
 * identity fields and the selfie camera never appear: they are the platform's
 * and cannot change. Pure: the two configurations in, the sentences out.
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
  }
  return changes;
}

/** The broker's own fields — never the platform's identity, camera or documents. */
function ownFields(step: KycStepConfig): KycFieldConfig[] {
  return step.fields.filter((field) => !field.system && !isDocumentField(field));
}

function describeField(field: KycFieldConfig): string {
  return `added "${field.label}" (${field.type}, ${field.required ? 'required' : 'optional'})`;
}

function documentName(type: string): string {
  return documentForFieldType(type)?.label ?? type;
}

function joined(options: readonly string[] | undefined): string {
  return (options ?? []).join(', ');
}
