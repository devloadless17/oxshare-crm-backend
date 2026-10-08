import { describe, expect, it } from 'vitest';
import { assistLayout } from './kyc-assist-view';
import { stepStates } from './kyc-step-state';
import type { KycStepConfig } from '../../store/kyc-config.store';
import type { KycSubmission } from '../../store/kyc.store';

/**
 * The "Complete KYC" page is laid out HERE so the console derives nothing: which
 * pages a document has, which slot each goes to, what is owed. These pin the
 * parts a mistake would turn into a wrong upload or a leaked answer.
 */

const field = (
  name: string,
  type: string,
  extra: Partial<KycStepConfig['fields'][number]> = {},
) => ({
  id: name,
  name,
  label: name,
  type,
  required: true,
  ...extra,
});

const step = (
  slug: string,
  fields: KycStepConfig['fields'],
  extra: Partial<KycStepConfig> = {},
) => ({
  id: slug,
  stepNumber: 1,
  slug,
  title: slug,
  description: '',
  icon: 'User',
  enabled: true,
  fields,
  ...extra,
});

const STEPS: KycStepConfig[] = [
  step('personal', [
    field('firstName', 'text', { system: true }),
    field('phone', 'phone', { system: true }),
  ]),
  step('document', [field('passport', 'doc:passport'), field('national_id', 'doc:national_id')]),
  step('selfie', [field('selfie', 'camera', { system: true, required: false })], {
    evidenceRequired: false,
  }),
  step('extra', [field('bankLetter', 'file')]),
  step('address', [field('utility_bill', 'doc:utility_bill')], { enabled: false }),
];

function submission(patch: Partial<KycSubmission> = {}): KycSubmission {
  return {
    userId: 1000001,
    status: 'rejected',
    personalInfo: { firstName: 'Samir', phone: '+96170555123' },
    document: {
      docType: 'national_id',
      frontFilePath: 'uploads/kyc/front.png',
      backFilePath: 'uploads/kyc/back.png',
    },
    stepData: { extra: { bankLetter: { filePath: 'uploads/kyc/letter.pdf' } } },
    rejectedFields: ['doc_back', 'bankLetter'],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...patch,
  };
}

function layout(view: KycSubmission, hidden = (_slug: string, _name: string) => false) {
  return assistLayout(STEPS, view, stepStates(STEPS, view, new Date()), hidden);
}

describe('assistLayout', () => {
  it('lays out only the steps the client is asked, in the form order', () => {
    expect(layout(submission()).steps.map((s) => s.slug)).toEqual([
      'personal',
      'document',
      'selfie',
      'extra',
    ]);
  });

  it('gives every page the slot it uploads to, and files only for the document on file', () => {
    const document = layout(submission()).steps.find((s) => s.slug === 'document')!.document!;
    expect(document.docType).toBe('national_id');

    const passport = document.types.find((t) => t.value === 'passport')!;
    expect(passport.pages.map((p) => p.target)).toEqual([
      { field: 'doc_front', docType: 'passport' },
    ]);
    // The national ID's pages are on file; the passport is not, whatever its slot.
    expect(passport.pages[0].filePath).toBeUndefined();

    const nationalId = document.types.find((t) => t.value === 'national_id')!;
    expect(nationalId.pages.map((p) => [p.target.field, p.filePath, p.returned])).toEqual([
      ['doc_front', 'uploads/kyc/front.png', false],
      ['doc_back', 'uploads/kyc/back.png', true],
    ]);
  });

  it('names the selfie and a broker upload by their own slots, with what was returned', () => {
    const view = layout(submission());
    expect(view.steps.find((s) => s.slug === 'selfie')!.selfie).toMatchObject({
      target: { field: 'selfie' },
      optional: true,
    });
    const letter = view.steps.find((s) => s.slug === 'extra')!.fields[0];
    expect(letter.upload).toEqual({
      target: { field: 'bankLetter' },
      filePath: 'uploads/kyc/letter.pdf',
      returned: true,
    });
  });

  it('a hidden answer is hidden with its file, and never carries a value', () => {
    const view = layout(submission(), (slug, name) => name === 'phone' || slug === 'extra');
    const personal = view.steps.find((s) => s.slug === 'personal')!;
    expect(personal.fields.find((f) => f.name === 'phone')!.hidden).toBe(true);
    expect(personal.fields.find((f) => f.name === 'firstName')!.hidden).toBe(false);
    const letter = view.steps.find((s) => s.slug === 'extra')!.fields[0];
    expect(letter.hidden).toBe(true);
    expect(letter.upload?.filePath).toBeUndefined();
    // Structure only: no field carries the answer it asks for.
    expect(JSON.stringify(view)).not.toContain('+96170555123');
  });

  it('is editable only while open, and complete only when the judge says so', () => {
    expect(layout(submission()).editable).toBe(true);
    expect(layout(submission({ status: 'submitted' })).editable).toBe(false);
    expect(layout(submission({ status: 'approved' })).editable).toBe(false);
    // A returned back page is still owed.
    expect(layout(submission()).complete).toBe(false);
  });
});
