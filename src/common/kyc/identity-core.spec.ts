import { describe, expect, it } from 'vitest';
import { PROFILE_FIELD_KEYS } from '../profile/client-profile';
import { DOCUMENT_CATALOGUE } from './document-catalogue';
import {
  CORE_STEPS,
  coreTitleMatching,
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

  it('require everything to verify but the postal code and the state — many addresses have neither', () => {
    expect(VERIFICATION_REQUIRED).toEqual(
      PROFILE_FIELD_KEYS.filter((key) => key !== 'postalCode' && key !== 'stateProvince'),
    );
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
  it('serves the identity details the broker PLACED — where and whether required — and no others', () => {
    // Phase 2: an operator may take a detail out of KYC (sign-up has it) and
    // decide which of the rest are required.
    const stored = step('personal', {
      fields: [
        { id: 'f-q', name: 'customField_q', label: 'Occupation', type: 'text', required: false },
        {
          id: 'f-6',
          name: 'country',
          label: 'Country of Residence',
          type: 'select',
          required: false,
        },
        { id: 'f-1', name: 'firstName', label: 'First Name', type: 'text', required: true },
      ],
    });
    const served = platformStep(stored);
    expect(served.fields.map((field) => [field.name, field.required])).toEqual([
      ['customField_q', false],
      ['country', false],
      ['firstName', true],
    ]);
  });

  it('serves the platform’s NAME and kind of an identity field, whatever a row says', () => {
    const stored = step('personal', {
      fields: [
        { id: 'f-1', name: 'firstName', label: 'Given', type: 'date', required: false },
        { id: 'f-1b', name: 'firstName', label: 'Again', type: 'text', required: true },
      ],
    });
    // Once, with the platform's label and type, and the broker's `required`.
    expect(platformStep(stored).fields).toEqual([
      expect.objectContaining({
        name: 'firstName',
        label: 'First Name',
        type: 'text',
        required: false,
        system: true,
      }),
    ]);
  });

  it('keeps a built-in step’s title and switch as the broker set them; the icon is the platform’s', () => {
    const served = platformStep(
      step('document', { title: 'IDs', icon: 'Star', enabled: false, description: 'Mine.' }),
    );
    expect(served).toMatchObject({
      title: 'IDs',
      icon: 'FileText',
      enabled: false,
      core: true,
      alwaysOn: false,
      evidenceRequired: true,
      description: 'Mine.',
    });
    expect(platformStep(step('selfie', { evidenceRequired: false })).fields[0]).toMatchObject({
      name: 'selfie',
      required: false,
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
  it('keeps the broker’s order and numbers from one', () => {
    const ordered = inFormOrder([step('address'), step('document'), step('personal')]);
    expect(ordered.map((s) => [s.slug, s.stepNumber])).toEqual([
      ['address', 1],
      ['document', 2],
      ['personal', 3],
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

describe('the platform’s Arabic (0179)', () => {
  const personal = (fields: FormStep['fields'], over: Partial<FormStep> = {}) =>
    platformStep(step('personal', { title: 'Personal Information', fields, ...over }));

  it('serves each identity field with its fixed Arabic label and hint, never stored', () => {
    const served = personal([
      {
        id: 'x',
        name: 'firstName',
        label: 'Hacked',
        labelAr: 'مخترق',
        type: 'text',
        required: true,
      },
    ]);
    expect(served.fields[0]).toMatchObject({
      label: 'First Name',
      labelAr: 'الاسم الأول',
      hintAr: 'كما يظهر في وثيقة هويتك',
      system: true,
    });
    expect(storedStep(served).fields[0]).not.toHaveProperty('labelAr');
  });

  it('drops the Arabic “leave blank” hint with the English one where the detail is required', () => {
    const served = personal([
      { id: 'p', name: 'postalCode', label: 'Postal / ZIP code', type: 'text', required: true },
    ]);
    expect(served.fields[0].hint).toBeUndefined();
    expect(served.fields[0].hintAr).toBeUndefined();
  });

  it('gives a built-in step on its default English the platform’s Arabic, and keeps the broker’s own', () => {
    expect(personal([])).toMatchObject({ titleAr: 'المعلومات الشخصية' });
    expect(personal([], { title: 'About you' }).titleAr).toBeUndefined();
    expect(personal([], { titleAr: 'عنك' }).titleAr).toBe('عنك');
    expect(CORE_STEPS.every((core) => core.titleAr && core.descriptionAr)).toBe(true);
  });

  it('names documents and the selfie in Arabic, and does not store a document’s Arabic', () => {
    const served = platformStep(
      step('document', { fields: [documentField(DOCUMENT_CATALOGUE[0])] }),
    );
    expect(served.fields[0].labelAr).toBe('جواز السفر');
    expect(storedStep(served).fields[0]).not.toHaveProperty('labelAr');
    expect(platformStep(step('selfie')).fields[0].labelAr).toBe('صورة سيلفي');
    expect(
      DOCUMENT_CATALOGUE.every((doc) => doc.labelAr && doc.parts.every((part) => part.labelAr)),
    ).toBe(true);
  });

  it('recognises the platform’s own names in Arabic, and leaves others alone', () => {
    expect(platformMeaningOf('الاسم الأول')).toBe('First Name');
    expect(platformMeaningOf('جواز  السفر')).toBe('Passport');
    expect(platformMeaningOf('بطاقة الهوية الوطنية - الوجه الخلفي')).toBe('National ID');
    expect(platformMeaningOf('اسم صاحب العمل')).toBeUndefined();
    expect(coreTitleMatching('إثبات العنوان')).toBe('Proof of Address');
  });
});
