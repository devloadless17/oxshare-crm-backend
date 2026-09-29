import { describe, expect, it } from 'vitest';
import { IDENTITY_FIELDS } from '../../common/kyc/identity-core';
import {
  approvalBlockers,
  stepStates,
  type StateStep,
  type StateSubmission,
} from './kyc-step-state';

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
    // As served: the platform's identity fields, then a question of the broker's.
    fields: [...IDENTITY_FIELDS, f('occupation', 'text', false, 'Occupation')],
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
    fields: [f('utilityBill', 'doc:utility_bill', false)],
  },
  {
    // The report: an extra upload and a checkbox. They live on a step of the
    // broker's own now (the identity core), and are judged the same way.
    slug: 'additional-documents',
    title: 'Additional documents',
    enabled: true,
    fields: [f('prooof3', 'file', true, 'Lease'), f('confirm', 'checkbox', true, 'I live here')],
  },
];

const PNG = (name: string) => ({ filePath: `uploads/kyc/${name}.png`, fileName: `${name}.png` });

const COMPLETE: StateSubmission = {
  personalInfo: {
    firstName: 'Jane',
    lastName: 'Haddad',
    dateOfBirth: '1990-01-01',
    nationality: 'Lebanese',
    phone: '+96170123456',
    country: 'Lebanon',
    address: 'Hamra Street 12',
    city: 'Beirut',
  },
  document: { docType: 'passport', frontFilePath: 'uploads/kyc/pp.png' },
  selfie: { filePath: 'uploads/kyc/selfie.png' },
  addressProof: { docType: 'utility_bill', filePath: 'uploads/kyc/bill.png' },
  stepData: { 'additional-documents': { prooof3: PNG('lease'), confirm: 'true' } },
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
      [
        'personal',
        [
          'answer:firstName',
          'answer:lastName',
          'answer:dateOfBirth',
          'answer:nationality',
          'answer:phone',
          'answer:country',
          'answer:address',
          'answer:city',
        ],
      ],
      ['document', ['choice:docType']],
      ['selfie', ['upload:selfie']],
      ['address', ['choice:docType']],
      ['additional-documents', ['upload:prooof3', 'answer:confirm']],
    ]);
  });

  it('judges the identity details the form ASKS for, required as the broker set them (Phase 2)', () => {
    const noIdentity = { ...COMPLETE, personalInfo: {} };
    // All asked, all optional: nothing is owed.
    const optional = STEPS.map((step) =>
      step.slug === 'personal'
        ? { ...step, fields: step.fields.map((field) => ({ ...field, required: false })) }
        : step,
    );
    expect(stateOf('personal', noIdentity, optional).missing).toEqual([]);
    // None asked (sign-up has them): nothing is owed either.
    const noFields = STEPS.map((step) =>
      step.slug === 'personal' ? { ...step, fields: [] } : step,
    );
    expect(stateOf('personal', noIdentity, noFields).missing).toEqual([]);
    // As placed by default: the eight required details are owed.
    expect(stateOf('personal', noIdentity).missing).toHaveLength(8);
  });

  it('lets a client skip OPTIONAL evidence, and still owes a document they started', () => {
    const optional = STEPS.map((step) => ({ ...step, evidenceRequired: false }));
    const none = { ...COMPLETE, document: null, selfie: null };
    expect(stateOf('document', none, optional).missing).toEqual([]);
    expect(stateOf('selfie', none, optional).missing).toEqual([]);
    const started = { ...COMPLETE, document: { docType: 'national_id', frontFilePath: 'f.png' } };
    expect(stateOf('document', started, optional).missing.map((item) => item.id)).toEqual([
      'doc_back',
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

describe('the broker’s own fields (reported: a required upload blocked nothing)', () => {
  it('owes a required extra upload and a required extra answer until they are there', () => {
    const without = { ...COMPLETE, stepData: {} };
    expect(stateOf('additional-documents', without).missing).toEqual([
      { id: 'prooof3', label: 'Lease', kind: 'upload' },
      { id: 'confirm', label: 'I live here', kind: 'answer' },
    ]);
  });

  it('a required checkbox is answered only when TICKED — unticked is stored as "false"', () => {
    const unticked = {
      ...COMPLETE,
      stepData: { 'additional-documents': { prooof3: PNG('l'), confirm: 'false' } },
    };
    expect(stateOf('additional-documents', unticked).missing.map((m) => m.id)).toEqual(['confirm']);
  });

  it('a required "tick all that apply" is answered by any one ticked choice', () => {
    const steps = STEPS.map((step) =>
      step.slug === 'additional-documents'
        ? {
            ...step,
            fields: [
              ...step.fields,
              { ...f('funds', 'checkbox', true, 'Source of funds'), options: ['Salary', 'Gift'] },
            ],
          }
        : step,
    );
    const extras = COMPLETE.stepData!['additional-documents'];
    const none = { ...COMPLETE, stepData: { 'additional-documents': { ...extras, funds: '' } } };
    expect(stateOf('additional-documents', none, steps).missing.map((m) => m.id)).toEqual([
      'funds',
    ]);
    const one = { ...COMPLETE, stepData: { 'additional-documents': { ...extras, funds: 'Gift' } } };
    expect(stateOf('additional-documents', one, steps).complete).toBe(true);
  });

  it('still judges an upload an OLDER form left on a built-in step, under its own slug', () => {
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

describe('what approval re-asks (the evidence a verification rests on)', () => {
  it('holds approval for a missing identity field and a missing document page', () => {
    const lost = {
      ...COMPLETE,
      personalInfo: { ...COMPLETE.personalInfo, city: '' },
      document: { docType: 'passport' },
    };
    expect(approvalBlockers(STEPS, lost, NOW).map((item) => item.id)).toEqual([
      'city',
      'doc_front',
    ]);
  });

  it('does NOT hold it for the broker’s own questions — a question added later strands no review', () => {
    // Required, unanswered: on a step of the broker's own, and on Personal Information.
    const steps = STEPS.map((step) =>
      step.slug === 'personal'
        ? { ...step, fields: [...step.fields, f('employer', 'text', true, 'Employer')] }
        : step,
    );
    const unanswered = { ...COMPLETE, stepData: {} };
    expect(stepStates(steps, unanswered, NOW).some((state) => !state.complete)).toBe(true);
    expect(approvalBlockers(steps, unanswered, NOW)).toEqual([]);
  });

  it('holds it for the selfie and the proof of address only while they are asked for', () => {
    const bare = { ...COMPLETE, selfie: null, addressProof: null };
    expect(approvalBlockers(STEPS, bare, NOW).map((item) => item.id)).toEqual([
      'selfie',
      'docType',
    ]);
    const off = STEPS.map((step) =>
      step.slug === 'selfie' || step.slug === 'address' ? { ...step, enabled: false } : step,
    );
    expect(approvalBlockers(off, bare, NOW)).toEqual([]);
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

  it('a returned upload of the broker’s own blocks like any document', () => {
    const state = stateOf('additional-documents', { ...COMPLETE, rejectedFields: ['prooof3'] });
    expect(state.complete).toBe(false);
    expect(state.returned).toEqual([
      { id: 'prooof3', label: 'Lease', kind: 'returned', blocking: true },
    ]);
  });

  /*
   * Reported 28 Sep 2026. The reviewer returned the BACK of a national ID; the
   * client switched to a passport. The flag outlived the card it was about and
   * read "Please upload a new Passport — the reviewer returned the one on
   * file", and Continue stayed shut until the national ID was sent again.
   */
  it('a returned national-ID back is answered by the passport the client switched to', () => {
    // On file: the passport (COMPLETE). Left over: the national ID's back.
    const switched = stateOf('document', { ...COMPLETE, rejectedFields: ['doc_back'] });
    expect(switched).toMatchObject({ complete: true, missing: [], returned: [] });

    // While the national ID is still on file, its returned back still blocks.
    const kept = stateOf('document', {
      ...COMPLETE,
      document: {
        docType: 'national_id',
        frontFilePath: 'uploads/kyc/id-front.png',
        backFilePath: 'uploads/kyc/id-back.png',
      },
      rejectedFields: ['doc_back'],
    });
    expect(kept.complete).toBe(false);
    expect(kept.returned).toEqual([
      { id: 'doc_back', label: 'National ID (Back Side)', kind: 'returned', blocking: true },
    ]);
  });

  it('a returned tenancy-agreement page is answered by the utility bill the client switched to', () => {
    // On file: the utility bill (COMPLETE). Left over: the agreement's additional page.
    const switched = stateOf('address', { ...COMPLETE, rejectedFields: ['address_proof_2'] });
    expect(switched).toMatchObject({ complete: true, missing: [], returned: [] });
  });
});
