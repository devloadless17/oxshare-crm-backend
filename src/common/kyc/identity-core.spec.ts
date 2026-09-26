import { describe, expect, it } from 'vitest';
import { PROFILE_FIELD_KEYS } from '../profile/client-profile';
import { DOCUMENT_CATALOGUE } from './document-catalogue';
import {
  CORE_STEPS,
  documentField,
  IDENTITY_FIELDS,
  inFormOrder,
  newCustomSlug,
  normaliseLabel,
  platformMeaningOf,
  platformStep,
  REGISTRATION_REQUIRED,
  reservedFieldName,
  storedStep,
  VERIFICATION_REQUIRED,
  type FormStep,
} from './identity-core';

/**
 * The identity core: what the platform owns in the KYC form, and the two
 * functions every read and write of it goes through.
 */

function step(slug: string, over: Partial<FormStep> = {}): FormStep {
  return {
    id: `step-${slug}`,
    stepNumber: 1,
    slug,
    title: slug,
    description: '',
    icon: 'X',
    enabled: true,
    fields: [],
    ...over,
  };
}

describe('the identity fields', () => {
  it('are exactly the profile, in the profile’s own order', () => {
    expect(IDENTITY_FIELDS.map((field) => field.name)).toEqual([...PROFILE_FIELD_KEYS]);
    expect(new Set(IDENTITY_FIELDS.map((field) => field.id)).size).toBe(IDENTITY_FIELDS.length);
  });

  it('require everything to verify but the postal code', () => {
    expect(VERIFICATION_REQUIRED).toEqual(PROFILE_FIELD_KEYS.filter((key) => key !== 'postalCode'));
  });

  it('require at sign-up who the person is and how to reach them — a subset of verification', () => {
    expect(REGISTRATION_REQUIRED).toEqual([
      'firstName',
      'lastName',
      'dateOfBirth',
      'nationality',
      'phone',
      'country',
    ]);
    for (const key of REGISTRATION_REQUIRED) expect(VERIFICATION_REQUIRED).toContain(key);
  });
});

describe('the form as it is SERVED', () => {
  it('THE REPORTED CONFIGURATION: the identity comes back whatever the row holds', () => {
    // The dev database, as found: an operator had deleted every identity field
    // and re-added "firstname" as a custom box.
    const stored = step('personal', {
      fields: [
        {
          id: 'field-1790402959161',
          name: 'customField_1790402959161',
          label: 'firstname',
          type: 'text',
          required: true,
        },
      ],
    });
    const served = platformStep(stored);
    expect(served.fields.map((field) => field.name)).toEqual([
      ...PROFILE_FIELD_KEYS,
      'customField_1790402959161',
    ]);
    expect(served.fields.slice(0, 9).every((field) => field.system)).toBe(true);
  });

  it('serves the platform’s version of an identity field, never a stored copy of it', () => {
    const stored = step('personal', {
      fields: [
        { id: 'f-1', name: 'firstName', label: 'Given', type: 'date', required: false },
        { id: 'f-q', name: 'customField_q', label: 'Occupation', type: 'text', required: false },
      ],
    });
    const served = platformStep(stored);
    expect(served.fields.filter((field) => field.name === 'firstName')).toEqual([
      expect.objectContaining({ label: 'First Name', type: 'text', required: true, system: true }),
    ]);
    expect(served.fields.at(-1)?.name).toBe('customField_q');
  });

  it('fixes a built-in step’s name and icon, and keeps an always-on step on', () => {
    const served = platformStep(
      step('document', { title: 'IDs', icon: 'Star', enabled: false, description: 'Mine.' }),
    );
    expect(served).toMatchObject({
      title: 'Identity Document',
      icon: 'FileText',
      enabled: true,
      core: true,
      alwaysOn: true,
      description: 'Mine.',
    });
    expect(platformStep(step('selfie', { enabled: false }))).toMatchObject({
      enabled: false,
      alwaysOn: false,
    });
  });

  it('gives the selfie step its camera, once', () => {
    expect(platformStep(step('selfie')).fields).toEqual([
      expect.objectContaining({ name: 'selfie', type: 'camera', system: true }),
    ]);
    const echoed = platformStep(
      step('selfie', {
        fields: [{ id: 'f-11', name: 'selfie', label: 'Me', type: 'camera', required: true }],
      }),
    );
    expect(echoed.fields.filter((field) => field.name === 'selfie')).toHaveLength(1);
  });

  it('rebuilds a document step’s documents from their types — once each, in catalogue order', () => {
    const served = platformStep(
      step('document', {
        fields: [
          {
            id: 'x',
            name: 'x',
            label: 'National ID card',
            type: 'doc:national_id',
            required: true,
          },
          { id: 'p', name: 'p', label: 'Passport', type: 'doc:passport', required: false },
          { id: 'y', name: 'y', label: 'Again', type: 'doc:national_id', required: false },
          { id: 'b', name: 'b', label: 'Bill', type: 'doc:utility_bill', required: false },
        ],
      }),
    );
    expect(
      served.fields.map(({ id, name, label, required }) => ({ id, name, label, required })),
    ).toEqual([
      { id: 'f-doc-passport', name: 'passport', label: 'Passport', required: false },
      { id: 'f-doc-national-id', name: 'nationalId', label: 'National ID', required: false },
    ]);
  });

  it('marks a step of the broker’s own as theirs and leaves it as stored', () => {
    const own = step('source-of-funds', {
      fields: [{ id: 'f', name: 'customField_f', label: 'Payslip', type: 'file', required: true }],
    });
    expect(platformStep(own)).toEqual({ ...own, core: false, alwaysOn: false });
  });
});

describe('the form as it is STORED', () => {
  it('keeps none of the platform’s parts', () => {
    const served = platformStep(
      step('personal', {
        fields: [
          { id: 'f-q', name: 'customField_q', label: 'Occupation', type: 'text', required: false },
        ],
      }),
    );
    const stored = storedStep(served);
    expect(stored.fields).toEqual([
      { id: 'f-q', name: 'customField_q', label: 'Occupation', type: 'text', required: false },
    ]);
    expect(stored).not.toHaveProperty('core');
    expect(stored).not.toHaveProperty('alwaysOn');
    expect(storedStep(platformStep(step('selfie'))).fields).toEqual([]);
  });

  it('round-trips: serving what was stored and storing it again changes nothing', () => {
    for (const core of CORE_STEPS) {
      const stored = storedStep(step(core.slug, { fields: [] }));
      expect(storedStep(platformStep(stored))).toEqual(stored);
      const served = platformStep(stored);
      expect(platformStep(storedStep(served))).toEqual(served);
    }
  });
});

describe('the order a client meets the steps in', () => {
  it('puts Personal Information first and numbers from one', () => {
    const ordered = inFormOrder([step('address'), step('document'), step('personal')]);
    expect(ordered.map((s) => [s.slug, s.stepNumber])).toEqual([
      ['personal', 1],
      ['address', 2],
      ['document', 3],
    ]);
  });
});

describe('documents', () => {
  it('each keep the id and name the default form has always used', () => {
    expect(DOCUMENT_CATALOGUE.map((doc) => documentField(doc).id)).toEqual([
      'f-doc-passport',
      'f-doc-national-id',
      'f-doc-driving-license',
      'f-doc-residence-permit',
      'f-addr-utility',
      'f-addr-bank',
      'f-addr-tenancy',
    ]);
  });
});

describe('names a broker’s own field may not take', () => {
  it.each([
    ['firstName', /First Name/],
    ['doc_back', /identity document or the selfie/],
    ['nationalId', /document the platform collects/],
    ['docType', /choice of document/],
    ['__proto__', /internally/],
    ['toString', /internally/],
  ])('refuses %s', (name, why) => {
    expect(reservedFieldName(name)).toMatch(why);
  });

  it('leaves the builder’s own keys alone', () => {
    expect(reservedFieldName('customField_1790402959161')).toBeUndefined();
  });
});

describe('a new step’s address', () => {
  it('comes from its title', () => {
    expect(newCustomSlug('Source of Funds', new Set())).toBe('source-of-funds');
    expect(newCustomSlug('  Déclaration — PEP  ', new Set())).toBe('declaration-pep');
  });

  it('is never taken, reserved or empty', () => {
    expect(newCustomSlug('Funds', new Set(['funds']))).toBe('funds-2');
    expect(newCustomSlug('Review', new Set())).toBe('review-2');
    expect(newCustomSlug('معلومات إضافية', new Set())).toBe('step');
  });
});

describe('labels that name something the platform collects', () => {
  it('match whatever the spelling, spacing or case', () => {
    expect(normaliseLabel(' First-Name ')).toBe('firstname');
    expect(platformMeaningOf('first name')).toBe('First Name');
    expect(platformMeaningOf('Date of birth')).toBe('Date of Birth');
    expect(platformMeaningOf('Driver’s licence')).toBe('Driving License');
  });

  it('catch a document page, the way migration 0137 labelled the ones it moved', () => {
    expect(platformMeaningOf('National ID — Back Side')).toBe('National ID');
    expect(platformMeaningOf('Passport - Photo Page')).toBe('Passport');
    expect(platformMeaningOf('Utility Bill — The Bill')).toBe('Proof of Address');
  });

  it('match the WHOLE label only', () => {
    expect(platformMeaningOf('Employer name')).toBeUndefined();
    expect(platformMeaningOf('Previous address')).toBeUndefined();
  });
});
