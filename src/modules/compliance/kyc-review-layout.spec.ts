import { describe, expect, it } from 'vitest';
import { platformStep } from '../../common/kyc/identity-core';
import { DEFAULT_KYC_STEPS, type KycStepConfig } from '../../store/kyc-config.store';
import {
  answerKeysOf,
  flagLabel,
  returnableItems,
  returnedFlags,
  reviewLayout,
} from './kyc-review-layout';

/**
 * The reviewer's layout of a submission — structure and labels, never a value.
 */

const FUNDS: KycStepConfig = {
  id: 'step-funds',
  stepNumber: 5,
  slug: 'source-of-funds',
  title: 'Source of funds',
  description: '',
  icon: 'FileText',
  enabled: true,
  fields: [
    { id: 'f-e', name: 'customField_e', label: 'Employer', type: 'text', required: true },
    { id: 'f-p', name: 'customField_p', label: 'Payslip', type: 'file', required: true },
  ],
};
const FORM: KycStepConfig[] = [...DEFAULT_KYC_STEPS.map((step) => platformStep(step)), FUNDS];

describe('the identity and the documents', () => {
  it('lists the identity in the platform’s order, and names the document ON FILE', () => {
    const layout = reviewLayout(FORM, {
      document: { docType: 'national_id' },
      addressProof: { docType: 'bank_statement' },
      stepData: {},
    });
    expect(layout.identity.map((field) => field.key)).toEqual([
      'firstName',
      'lastName',
      'dateOfBirth',
      'nationality',
      'phone',
      'country',
      'address',
      'city',
      'stateProvince',
      'postalCode',
    ]);
    expect(layout.identityDocument).toEqual({
      type: 'national_id',
      label: 'National ID',
      pages: [
        { slot: 'doc_front', label: 'Front Side', required: true },
        { slot: 'doc_back', label: 'Back Side', required: true },
      ],
    });
    expect(layout.proofOfAddress).toMatchObject({ asked: true, label: 'Bank Statement' });
  });

  it('never GUESSES a document — an untyped one is named as what it is', () => {
    const layout = reviewLayout(FORM, { stepData: {} });
    expect(layout.identityDocument.label).toBe('Identity document');
    expect(layout.identityDocument.type).toBeNull();
  });

  it('says when the broker does not ask for a selfie or a proof of address', () => {
    const off = FORM.map((step) =>
      step.slug === 'selfie' || step.slug === 'address' ? { ...step, enabled: false } : step,
    );
    const layout = reviewLayout(off, { stepData: {} });
    expect(layout.selfie.asked).toBe(false);
    expect(layout.proofOfAddress.asked).toBe(false);
  });
});

describe('the broker’s own questions', () => {
  it('are grouped by the step they were asked on, and nothing of the platform’s is among them', () => {
    const layout = reviewLayout(FORM, { stepData: {} });
    expect(layout.additional).toEqual([
      {
        slug: 'source-of-funds',
        title: 'Source of funds',
        fields: [
          { name: 'customField_e', label: 'Employer', type: 'text', step: 'source-of-funds' },
          { name: 'customField_p', label: 'Payslip', type: 'file', step: 'source-of-funds' },
        ],
      },
    ]);
  });

  it('read as they were ASKED — a question relabelled after submission keeps its old label', () => {
    const relabelled = FORM.map((step) =>
      step.id === FUNDS.id
        ? { ...step, fields: step.fields.map((f) => ({ ...f, label: `${f.label} (new)` })) }
        : step,
    );
    const layout = reviewLayout(relabelled, {
      stepData: {},
      formSnapshot: [
        {
          slug: 'source-of-funds',
          title: 'Source of funds',
          fields: [{ name: 'customField_e', label: 'Employer', type: 'text' }],
        },
      ],
    });
    expect(layout.additional[0].fields.map((f) => f.label)).toEqual(['Employer']);
  });

  it('names an answer to a question no longer on the form by the name it was last given', () => {
    // Reported on production (26 Sep 2026): "Custom Field 1790263641710" under
    // this heading. The question was deleted, and the answer kept only its key.
    // The name is recorded now (0148), and its type with it — a checkbox still
    // reads as one.
    const layout = reviewLayout(
      FORM,
      {
        personalInfo: { customField_1790402959161: 'Layla', firstName: 'Layla' },
        stepData: { 'old-step': { oldQuestion: 'true', neverNamed: 'b' } },
      },
      new Map([
        ['customField_1790402959161', { label: 'firstname', type: 'text' }],
        ['oldQuestion', { label: 'I live here', type: 'checkbox' }],
      ]),
    );
    expect(layout.additional.at(-1)).toEqual({
      slug: 'unlisted',
      title: 'Answers to questions no longer on the form',
      fields: [
        { name: 'customField_1790402959161', label: 'firstname', type: 'text', step: 'personal' },
        { name: 'oldQuestion', label: 'I live here', type: 'checkbox', step: 'old-step' },
        // Deleted before any record kept its name: said so, never its key.
        {
          name: 'neverNamed',
          label: 'Question name not on record',
          type: 'text',
          step: 'old-step',
        },
      ],
    });
  });

  it('looks names up for every answer of the broker’s — never for the identity', () => {
    expect(
      answerKeysOf({
        personalInfo: { firstName: 'Layla', customField_a: 'x' },
        stepData: { 'source-of-funds': { customField_b: 'y' }, extra: { customField_a: 'z' } },
      }),
    ).toEqual(['customField_a', 'customField_b']);
  });
});

describe('a returned item is named ONE way — screens and email alike', () => {
  it('names identity fields, document pages and the broker’s own fields by what the client sees', () => {
    const layout = reviewLayout(FORM, {
      document: { docType: 'national_id' },
      stepData: {},
      rejectedFields: ['dateOfBirth', 'doc_back', 'customField_p'],
    });
    expect(layout.flags).toEqual([
      { id: 'dateOfBirth', label: 'Date of Birth' },
      { id: 'doc_back', label: 'National ID (Back Side)' },
      { id: 'customField_p', label: 'Payslip' },
    ]);
  });

  it('never prints a raw key', () => {
    expect(flagLabel('someRemovedField', FORM, {})).toBe('Some Removed Field');
  });
});

describe('what a reviewer may return — what the client can answer, and nothing else', () => {
  const IDENTITY = [
    'firstName',
    'lastName',
    'dateOfBirth',
    'nationality',
    'phone',
    'country',
    'address',
    'city',
    'stateProvince',
    'postalCode',
  ];
  const PRESENTED = {
    document: { docType: 'passport', frontFilePath: 'uploads/kyc/f.png' },
    addressProof: { docType: 'utility_bill', filePath: 'uploads/kyc/b.png' },
    selfie: { filePath: 'uploads/kyc/s.png' },
    stepData: { 'source-of-funds': { customField_e: 'ACME', customField_gone: 'old' } },
  };
  const returnable = (form = FORM, presented = PRESENTED) =>
    returnableItems(form, reviewLayout(form, presented), presented);

  it('offers the identity, the pages on file, the selfie and the broker’s questions', () => {
    expect([...returnable()].sort()).toEqual(
      [
        ...IDENTITY,
        'doc_front',
        'passport', // the whole document on file, by its field
        'address_proof',
        'utilityBill',
        'selfie',
        'customField_e',
        'customField_p',
      ].sort(),
    );
  });

  it('never a page the document on file does not have — a passport has no back', () => {
    expect(returnable().has('doc_back')).toBe(false);
    expect(returnable().has('address_proof_2')).toBe(false);
  });

  it('never a page not ON FILE — an untyped document offers both slots, and only one is there', () => {
    // A submission from before types were recorded: the layout names two pages.
    const legacy = { document: { frontFilePath: 'uploads/kyc/f.png' }, stepData: {} };
    const items = returnableItems(FORM, reviewLayout(FORM, legacy), legacy);
    expect(items.has('doc_front')).toBe(true);
    expect(items.has('doc_back')).toBe(false);
  });

  it('never another document than the one on file', () => {
    expect(returnable().has('nationalId')).toBe(false);
  });

  it('never what the broker does not ask for', () => {
    const off = FORM.map((step) =>
      step.slug === 'selfie' || step.slug === 'address' ? { ...step, enabled: false } : step,
    );
    const items = returnable(off);
    expect(items.has('selfie')).toBe(false);
    expect(items.has('address_proof')).toBe(false);
    expect(items.has('utilityBill')).toBe(false);
  });

  it('never an answer to a question the form no longer asks', () => {
    expect(returnable().has('customField_gone')).toBe(false);
  });

  it('stores a whole document as its pages on file, and names every id it cannot store', () => {
    expect(
      returnedFlags(
        ['doc_front', 'passport', 'firstName', 'bogus', 'doc_back', 'nationalId', 'firstName'],
        FORM,
        returnable(),
      ),
    ).toEqual({ flags: ['doc_front', 'firstName'], unknown: ['bogus', 'doc_back', 'nationalId'] });
  });
});
