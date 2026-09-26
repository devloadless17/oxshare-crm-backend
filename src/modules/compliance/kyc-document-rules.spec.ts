import { describe, expect, it } from 'vitest';
import {
  asPageFlags,
  documentFlagLabel,
  flagsSettledByUpload,
  missingRequiredPage,
  outstandingDocumentFlags,
  type RuleStep,
} from './kyc-document-rules';

/**
 * A document the reviewer returned must be replaced, and the pages a document
 * needs are the catalogue's, not the first one alone.
 *
 * Reported from production: rejecting a passport told the client nothing and
 * the same file could be resubmitted; and a national ID with no back side was
 * accepted as complete.
 */

const STEPS: RuleStep[] = [
  {
    slug: 'personal',
    enabled: true,
    fields: [
      { name: 'firstName', label: 'First Name', type: 'text' },
      { name: 'dateOfBirth', label: 'Date of Birth', type: 'date' },
    ],
  },
  {
    slug: 'document',
    enabled: true,
    fields: [
      {
        name: 'passport',
        label: 'Passport',
        type: 'doc:passport',
        document: { value: 'passport' },
      },
      {
        name: 'nationalId',
        label: 'National ID',
        type: 'doc:national_id',
        document: { value: 'national_id' },
      },
      { name: 'documentNumber', label: 'Document number', type: 'text' },
    ],
  },
  {
    slug: 'selfie',
    enabled: true,
    fields: [{ name: 'selfie', label: 'Selfie Photo', type: 'camera' }],
  },
  {
    slug: 'address',
    enabled: true,
    fields: [
      {
        name: 'utilityBill',
        label: 'Utility Bill',
        type: 'doc:utility_bill',
        document: { value: 'utility_bill' },
      },
    ],
  },
  {
    slug: 'source-of-funds',
    enabled: true,
    fields: [
      { name: 'customField_1790263652846', label: 'Payslip', type: 'file' },
      { name: 'customField_1790263641710', label: 'Employer', type: 'text' },
    ],
  },
];

describe('an upload settles the flags it answers', () => {
  it('a page settles itself and a whole-document flag on its step — never a typed field', () => {
    expect(flagsSettledByUpload('doc_back', STEPS)).toEqual(['doc_back', 'passport', 'nationalId']);
  });

  it('a selfie settles the selfie step’s own field name', () => {
    expect(flagsSettledByUpload('selfie', STEPS)).toEqual(['selfie', 'selfie']);
  });

  it('a custom step’s file field is its own flag', () => {
    expect(flagsSettledByUpload('customField_1790263652846', STEPS)).toEqual([
      'customField_1790263652846',
    ]);
  });

  it('does not treat an inherited property as a canonical slot', () => {
    expect(flagsSettledByUpload('constructor', STEPS)).toEqual(['constructor']);
  });
});

describe('which returned documents are still owed', () => {
  it('keeps document flags and drops typed ones', () => {
    expect(
      outstandingDocumentFlags(
        [
          'dateOfBirth',
          'doc_front',
          'selfie',
          'customField_1790263652846',
          'customField_1790263641710',
        ],
        STEPS,
      ),
    ).toEqual(['doc_front', 'selfie', 'customField_1790263652846']);
  });

  it('counts a whole-document flag as owed', () => {
    expect(outstandingDocumentFlags(['nationalId'], STEPS)).toEqual(['nationalId']);
  });

  it('forgives a flag on a step the broker has since DISABLED — it could never be settled', () => {
    const steps = STEPS.map((s) => (s.slug === 'selfie' ? { ...s, enabled: false } : s));
    expect(outstandingDocumentFlags(['selfie', 'doc_front'], steps)).toEqual(['doc_front']);
  });

  it('owes nothing when nothing was returned', () => {
    expect(outstandingDocumentFlags(undefined, STEPS)).toEqual([]);
    expect(outstandingDocumentFlags([], STEPS)).toEqual([]);
  });
});

describe('a returned document is named the way the client knows it', () => {
  it.each([
    ['doc_front', { document: { docType: 'passport' } }, 'Passport'],
    ['doc_front', { document: { docType: 'national_id' } }, 'National ID (Front Side)'],
    ['doc_back', { document: { docType: 'national_id' } }, 'National ID (Back Side)'],
    ['doc_front', {}, 'Identity document'],
    ['address_proof', { addressProof: { docType: 'utility_bill' } }, 'Utility Bill'],
    ['selfie', {}, 'Selfie Photo'],
    ['customField_1790263652846', {}, 'Payslip'],
    ['nationalId', {}, 'National ID'],
  ] as const)('%s → %s', (id, stored, expected) => {
    expect(documentFlagLabel(id, STEPS, stored)).toBe(expected);
  });
});

describe('every required page of the chosen document', () => {
  it('asks for a national ID’s back', () => {
    expect(
      missingRequiredPage({ docType: 'national_id', files: ['front.jpg', undefined] }, 'identity'),
    ).toEqual({ index: 1, label: 'National ID: Back Side' });
  });

  it('asks for the first page first', () => {
    expect(missingRequiredPage({ docType: 'national_id', files: [] }, 'identity')).toEqual({
      index: 0,
      label: 'National ID: Front Side',
    });
  });

  it('is satisfied by a passport’s single page', () => {
    expect(
      missingRequiredPage({ docType: 'passport', files: ['p.jpg'] }, 'identity'),
    ).toBeUndefined();
  });

  it('does not ask for an OPTIONAL page', () => {
    expect(
      missingRequiredPage({ docType: 'tenancy_agreement', files: ['sig.jpg'] }, 'address'),
    ).toBeUndefined();
  });

  it('falls back to the first page for a type the catalogue does not know', () => {
    expect(
      missingRequiredPage({ docType: 'library_card', files: ['x.jpg'] }, 'identity'),
    ).toBeUndefined();
    expect(missingRequiredPage({ files: [] }, 'identity')).toEqual({ index: 0 });
  });

  it('does not read an address document as an identity one', () => {
    expect(missingRequiredPage({ docType: 'utility_bill', files: [] }, 'identity')).toEqual({
      index: 0,
    });
  });
});

describe('a whole document returned is every page of it returned', () => {
  it('names a two-sided card by both its pages, and a passport by its one', () => {
    expect(asPageFlags(['nationalId'], STEPS)).toEqual(['doc_front', 'doc_back']);
    expect(asPageFlags(['passport'], STEPS)).toEqual(['doc_front']);
  });

  it('leaves page flags, answers and a broker’s own uploads as they are, once each', () => {
    expect(asPageFlags(['doc_back', 'firstName', 'nationalId'], STEPS)).toEqual([
      'doc_back',
      'firstName',
      'doc_front',
    ]);
  });
});
