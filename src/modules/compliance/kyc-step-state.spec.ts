import { describe, expect, it } from 'vitest';
import { stepStates, type StateStep, type StateSubmission } from './kyc-step-state';

/**
 * The one judgement of every KYC step — what `submit` refuses, what
 * `GET /kyc/status` serves, what the portal renders. Each case below is a rule
 * the portal and the server used to decide separately, and disagreed on.
 */

const f = (name: string, type = 'text', required = true, label = name) => ({
  name,
  label,
  type,
  required,
});

const STEPS: StateStep[] = [
  {
    slug: 'personal',
    title: 'Personal Information',
    enabled: true,
    fields: [
      f('firstName', 'text', true, 'First Name'),
      f('dateOfBirth', 'date', true, 'Date of Birth'),
      f('phone', 'phone', true, 'Phone Number'),
    ],
  },
  {
    slug: 'document',
    title: 'Identity Document',
    enabled: true,
    fields: [f('passport', 'doc:passport', false), f('nationalId', 'doc:national_id', false)],
  },
  {
    slug: 'selfie',
    title: 'Selfie',
    enabled: true,
    fields: [f('selfie', 'camera', true, 'Selfie Photo')],
  },
  {
    slug: 'address',
    title: 'Proof of Address',
    enabled: true,
    // The report: an extra upload and a checkbox on a BUILT-IN step.
    fields: [
      f('utilityBill', 'doc:utility_bill', false),
      f('prooof3', 'file', true, 'Lease'),
      f('confirm', 'checkbox', true, 'I live here'),
    ],
  },
];

const PNG = (name: string) => ({ filePath: `uploads/kyc/${name}.png`, fileName: `${name}.png` });

const COMPLETE: StateSubmission = {
  personalInfo: { firstName: 'Jane', dateOfBirth: '1990-01-01', phone: '+961 70 123 456' },
  document: { docType: 'passport', frontFilePath: 'uploads/kyc/pp.png' },
  selfie: { filePath: 'uploads/kyc/selfie.png' },
  addressProof: { docType: 'utility_bill', filePath: 'uploads/kyc/bill.png' },
  stepData: { address: { prooof3: PNG('lease'), confirm: 'true' } },
};

const NOW = new Date('2026-09-25T12:00:00Z');
const stateOf = (slug: string, sub: StateSubmission, steps = STEPS, chosen?: never) =>
  stepStates(steps, sub, NOW, chosen).find((state) => state.slug === slug)!;

describe('every step, judged once', () => {
  it('a complete submission owes nothing, anywhere', () => {
    expect(stepStates(STEPS, COMPLETE, NOW).every((state) => state.complete)).toBe(true);
  });

  it('an empty one owes each step its own kind of thing, in the order the step shows it', () => {
    const states = stepStates(STEPS, {}, NOW);
    expect(states.map((s) => [s.slug, s.missing.map((m) => `${m.kind}:${m.id}`)])).toEqual([
      ['personal', ['answer:firstName', 'answer:dateOfBirth', 'answer:phone']],
      ['document', ['choice:docType']],
      ['selfie', ['upload:selfie']],
      ['address', ['choice:docType', 'upload:prooof3', 'answer:confirm']],
    ]);
  });

  it('leaves out disabled steps and the review screen', () => {
    const steps = [
      { ...STEPS[2], enabled: false },
      { slug: 'review', title: 'Review', enabled: true, fields: [] },
    ];
    expect(stepStates(steps, {}, NOW)).toEqual([]);
  });
});

describe('a document step', () => {
  it('owes every required page of the chosen document, named', () => {
    const half = { ...COMPLETE, document: { docType: 'national_id', frontFilePath: 'f.png' } };
    expect(stateOf('document', half).missing).toEqual([
      { id: 'doc_back', label: 'National ID: Back Side', kind: 'page' },
    ]);
  });

  it('judges ANOTHER card the client chose against its own pages — the stored ones are the passport’s', () => {
    const state = stepStates(STEPS, COMPLETE, NOW, {
      slug: 'document',
      docType: 'national_id',
    }).find((s) => s.slug === 'document')!;
    expect(state.complete).toBe(false);
    expect(state.missing.map((m) => m.label)).toEqual([
      'National ID: Front Side',
      'National ID: Back Side',
    ]);
  });

  it('reads a submission from before types were recorded by its first page, as it always has', () => {
    const legacy = { ...COMPLETE, document: { frontFilePath: 'f.png' } };
    expect(stateOf('document', legacy).complete).toBe(true);
  });
});

describe('extra fields on a built-in step (reported: a required upload blocked nothing)', () => {
  it('owes a required extra upload and a required extra answer until they are there', () => {
    const without = { ...COMPLETE, stepData: {} };
    expect(stateOf('address', without).missing).toEqual([
      { id: 'prooof3', label: 'Lease', kind: 'upload' },
      { id: 'confirm', label: 'I live here', kind: 'answer' },
    ]);
  });

  it('a required checkbox is answered only when TICKED — unticked is stored as "false"', () => {
    const unticked = {
      ...COMPLETE,
      stepData: { address: { prooof3: PNG('l'), confirm: 'false' } },
    };
    expect(stateOf('address', unticked).missing.map((m) => m.id)).toEqual(['confirm']);
  });

  it('a required "tick all that apply" is answered by any one ticked choice', () => {
    const steps = STEPS.map((step) =>
      step.slug === 'address'
        ? {
            ...step,
            fields: [
              ...step.fields,
              { ...f('funds', 'checkbox', true, 'Source of funds'), options: ['Salary', 'Gift'] },
            ],
          }
        : step,
    );
    const none = {
      ...COMPLETE,
      stepData: { address: { ...COMPLETE.stepData!.address, funds: '' } },
    };
    expect(stateOf('address', none, steps).missing.map((m) => m.id)).toEqual(['funds']);
    const one = {
      ...COMPLETE,
      stepData: { address: { ...COMPLETE.stepData!.address, funds: 'Gift' } },
    };
    expect(stateOf('address', one, steps).complete).toBe(true);
  });

  it('keeps uploads on the personal and selfie steps under their own slugs', () => {
    const steps = STEPS.map((step) =>
      step.slug === 'personal' || step.slug === 'selfie'
        ? { ...step, fields: [...step.fields, f(`${step.slug}Scan`, 'file')] }
        : step,
    );
    expect(
      stepStates(steps, COMPLETE, NOW)
        .filter((s) => !s.complete)
        .map((s) => s.slug),
    ).toEqual(['personal', 'selfie']);
    const filed = {
      ...COMPLETE,
      stepData: {
        ...COMPLETE.stepData,
        personal: { personalScan: PNG('p') },
        selfie: { selfieScan: PNG('s') },
      },
    };
    expect(stepStates(steps, filed, NOW).every((s) => s.complete)).toBe(true);
  });
});

describe('the selfie and the profile', () => {
  it('owes the selfie whenever the step is enabled — even with no fields configured', () => {
    const bare = STEPS.map((step) => (step.slug === 'selfie' ? { ...step, fields: [] } : step));
    expect(stateOf('selfie', { ...COMPLETE, selfie: undefined }, bare).missing).toEqual([
      { id: 'selfie', label: 'Selfie', kind: 'upload' },
    ]);
  });

  it('names an unacceptable answer with the reason submit has always given', () => {
    const young = {
      ...COMPLETE,
      personalInfo: { ...COMPLETE.personalInfo, dateOfBirth: '2015-01-01' },
    };
    expect(stateOf('personal', young).missing).toEqual([
      expect.objectContaining({
        id: 'dateOfBirth',
        kind: 'invalid',
        code: 'underage',
        message: expect.stringMatching(/at least 18/),
      }),
    ]);
  });

  it('reads a phone holding only its country code as NOT answered', () => {
    const bare = { ...COMPLETE, personalInfo: { ...COMPLETE.personalInfo, phone: '+961' } };
    expect(stateOf('personal', bare).missing.map((m) => `${m.kind}:${m.id}`)).toEqual([
      'answer:phone',
    ]);
  });
});

describe('what the reviewer returned', () => {
  it('a returned DOCUMENT blocks its step until replaced; a returned answer only asks', () => {
    const returned = { ...COMPLETE, rejectedFields: ['doc_front', 'firstName'] };
    const document = stateOf('document', returned);
    expect(document.complete).toBe(false);
    expect(document.returned).toEqual([
      { id: 'doc_front', label: 'Passport', kind: 'returned', blocking: true },
    ]);
    const personal = stateOf('personal', returned);
    expect(personal.complete).toBe(true);
    expect(personal.returned).toEqual([
      { id: 'firstName', label: 'First Name', kind: 'returned', blocking: false },
    ]);
  });

  it('a returned extra upload on a built-in step blocks like any document', () => {
    const state = stateOf('address', { ...COMPLETE, rejectedFields: ['prooof3'] });
    expect(state.complete).toBe(false);
    expect(state.returned).toEqual([
      { id: 'prooof3', label: 'Lease', kind: 'returned', blocking: true },
    ]);
  });
});
