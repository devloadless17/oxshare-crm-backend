import { describe, expect, it } from 'vitest';
import { FieldValidationError } from '../../common/errors/domain-errors';
import { platformStep } from '../../common/kyc/identity-core';
import { DEFAULT_KYC_STEPS, type KycStepConfig } from '../../store/kyc-config.store';
import {
  assertCoreSteps,
  assertFieldKeys,
  assertIdentityUnchanged,
  assertKycConfigIntegrity,
  assertNoSecondCopies,
  assertStepAddresses,
  assertStepsHoldWhatTheyAreFor,
} from './kyc-config-integrity';

/**
 * The KYC form's rules, one at a time (the owner's ruling, 26 Sep 2026).
 *
 * The fixture is the default form AS THE BUILDER RECEIVES IT — identity fields,
 * selfie camera and documents included (`platformStep`) — because that is what
 * a save sends back, and a rule that only held for a hand-trimmed fixture would
 * refuse the builder's own round trip.
 */
const FORM: KycStepConfig[] = DEFAULT_KYC_STEPS.map((step) => platformStep(step));

const at = (slug: string, steps: readonly KycStepConfig[] = FORM) =>
  steps.findIndex((step) => step.slug === slug);

function edit(
  slug: string,
  change: (step: KycStepConfig) => KycStepConfig,
  steps: readonly KycStepConfig[] = FORM,
): KycStepConfig[] {
  return steps.map((step) => (step.slug === slug ? change(step) : step));
}

function custom(over: Partial<KycStepConfig> = {}): KycStepConfig {
  return {
    id: 'step-funds',
    stepNumber: FORM.length + 1,
    slug: 'source-of-funds',
    title: 'Source of funds',
    description: '',
    icon: 'FileText',
    enabled: true,
    fields: [
      { id: 'field-1', name: 'customField_1', label: 'Employer', type: 'text', required: true },
    ],
    ...over,
  };
}

/** What a refusal says, and where it lands in the posted form. */
function refusal(run: () => void): { message: string; fields: Record<string, string> } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(FieldValidationError);
    const refused = error as FieldValidationError;
    return { message: refused.message, fields: refused.fields };
  }
  throw new Error('expected a refusal, and the form was accepted');
}

describe('the default form', () => {
  it('is accepted as the builder receives it, and as the table stores it', () => {
    expect(() => assertKycConfigIntegrity(FORM, FORM)).not.toThrow();
    expect(() => assertKycConfigIntegrity(DEFAULT_KYC_STEPS, DEFAULT_KYC_STEPS)).not.toThrow();
  });
});

describe('the four built-in steps', () => {
  it.each(['personal', 'document', 'selfie', 'address'])(
    'refuses a form without %s, as a refusal about the whole form',
    (slug) => {
      const { message, fields } = refusal(() =>
        assertCoreSteps(FORM.filter((step) => step.slug !== slug)),
      );
      expect(message).toMatch(/cannot be removed/);
      expect(Object.keys(fields)).toEqual(['steps']);
    },
  );

  it('points the two that may be switched off at the switch', () => {
    expect(
      refusal(() => assertCoreSteps(FORM.filter((step) => step.slug !== 'address'))).message,
    ).toMatch(/Switch it off/);
    expect(
      refusal(() => assertCoreSteps(FORM.filter((step) => step.slug !== 'personal'))).message,
    ).not.toMatch(/Switch it off/);
  });

  it('refuses a built-in step twice, at the second one', () => {
    const twice = [...FORM, { ...FORM[at('document')], id: 'step-copy' }];
    const { message, fields } = refusal(() => assertCoreSteps(twice));
    expect(message).toMatch(/Identity Document appears 2 times/);
    expect(Object.keys(fields)).toEqual([`steps.${twice.length - 1}`]);
  });

  it.each(['personal', 'document'])('refuses switching %s off', (slug) => {
    const off = edit(slug, (step) => ({ ...step, enabled: false }));
    expect(refusal(() => assertCoreSteps(off)).message).toMatch(/always on/);
  });

  it.each(['selfie', 'address'])('ALLOWS switching %s off', (slug) => {
    const off = edit(slug, (step) => ({ ...step, enabled: false }));
    expect(() => assertKycConfigIntegrity(FORM, off)).not.toThrow();
  });

  it('refuses renaming a built-in step, and allows rewording its description', () => {
    const renamed = edit('address', (step) => ({ ...step, title: 'Address check' }));
    expect(refusal(() => assertCoreSteps(renamed)).message).toMatch(/keeps its name/);

    const reworded = edit('address', (step) => ({
      ...step,
      description: 'Dated within the last 6 months.',
    }));
    expect(() => assertKycConfigIntegrity(FORM, reworded)).not.toThrow();
  });

  it('keeps Personal Information first, and says so at its own position', () => {
    const moved = [...FORM.slice(1), FORM[0]];
    const { message, fields } = refusal(() => assertCoreSteps(moved));
    expect(message).toMatch(/Personal Information comes first/);
    expect(Object.keys(fields)).toEqual([`steps.${moved.length - 1}`]);
  });
});

describe("the client's identity is the platform's", () => {
  const personal = at('personal');
  const firstName = FORM[personal].fields.findIndex((field) => field.name === 'firstName');

  it('THE REPORTED CASE: leaving First Name out of a save removes nothing', () => {
    /*
     * The builder used to let an operator delete First Name; re-adding it made
     * a custom box. The identity fields are not stored now, so a save without
     * them is simply a save — the store serves them on the next read
     * (`identity-core.spec.ts` pins that half).
     */
    const without = edit('personal', (step) => ({
      ...step,
      fields: step.fields.filter((field) => field.name !== 'firstName'),
    }));
    expect(() => assertKycConfigIntegrity(FORM, without)).not.toThrow();
  });

  it('THE REPORTED CASE, second half: a custom question called "firstname" is refused', () => {
    const shadow = edit('personal', (step) => ({
      ...step,
      fields: [
        ...step.fields.filter((field) => field.name !== 'firstName'),
        {
          id: 'field-1790402959161',
          name: 'customField_1790402959161',
          label: 'firstname',
          type: 'text',
          required: true,
        },
      ],
    }));
    const { message, fields } = refusal(() => assertKycConfigIntegrity(FORM, shadow));
    expect(message).toMatch(/already collected by the platform \(First Name\)/);
    expect(Object.keys(fields)[0]).toMatch(new RegExp(`^steps\\.${personal}\\.fields\\.\\d+$`));
  });

  it.each([
    ['a new label', { label: 'Given name' }],
    ['a new type', { type: 'date' }],
    ['a new key', { name: 'givenName' }],
  ])('refuses giving First Name %s', (_, change) => {
    const changed = edit('personal', (step) => ({
      ...step,
      fields: step.fields.map((field, index) =>
        index === firstName ? { ...field, ...change } : field,
      ),
    }));
    const { message, fields } = refusal(() => assertIdentityUnchanged(changed));
    expect(message).toMatch(/fixed by the platform/);
    expect(fields).toHaveProperty(`steps.${personal}.fields.${firstName}`);
  });

  it('refuses making a required identity field optional, and the postal code required', () => {
    const optional = edit('personal', (step) => ({
      ...step,
      fields: step.fields.map((field) =>
        field.name === 'address' ? { ...field, required: false } : field,
      ),
    }));
    expect(refusal(() => assertIdentityUnchanged(optional)).message).toMatch(/always required/);

    const required = edit('personal', (step) => ({
      ...step,
      fields: step.fields.map((field) =>
        field.name === 'postalCode' ? { ...field, required: true } : field,
      ),
    }));
    expect(refusal(() => assertIdentityUnchanged(required)).message).toMatch(/always optional/);
  });

  it('refuses asking for an identity field on any other step', () => {
    const phone = FORM[personal].fields.find((field) => field.name === 'phone')!;
    const moved = [...FORM, custom({ fields: [{ ...phone, system: undefined }] })];
    expect(refusal(() => assertIdentityUnchanged(moved)).message).toMatch(
      /asked for once — on Personal Information/,
    );
  });

  it.each(['First name', 'SURNAME', 'Date of birth', 'E-mail', 'Mobile', 'Passport', 'ZIP'])(
    'refuses a question labelled "%s" — a second copy of something the platform collects',
    (label) => {
      const shadow = [
        ...FORM,
        custom({
          fields: [{ id: 'f-x', name: 'customField_x', label, type: 'text', required: false }],
        }),
      ];
      expect(refusal(() => assertNoSecondCopies(shadow)).message).toMatch(
        /already collected by the platform/,
      );
    },
  );

  it('leaves the broker free to ask anything else', () => {
    const own = [
      ...FORM,
      custom({
        fields: ['Employer name', 'Previous address', 'Occupation', 'Source of funds'].map(
          (label, index) => ({
            id: `q-${index}`,
            name: `customField_${index}`,
            label,
            type: 'text',
            required: false,
          }),
        ),
      }),
    ];
    expect(() => assertKycConfigIntegrity(FORM, own)).not.toThrow();
  });
});

describe('each built-in step holds what it is for, and nothing else', () => {
  const passport = FORM[at('document')].fields.find((field) => field.type === 'doc:passport')!;

  it('refuses a passport on a step of the broker’s own — a client has one passport', () => {
    const second = [...FORM, custom({ fields: [{ ...passport, id: 'f-second', name: 'pp2' }] })];
    expect(refusal(() => assertStepsHoldWhatTheyAreFor(second)).message).toMatch(
      /once each, so there is never a second one/,
    );
  });

  it('refuses a document of the other kind — it would be filed as the wrong one', () => {
    const bill = FORM[at('address')].fields.find((field) => field.type === 'doc:utility_bill')!;
    const wrong = edit('document', (step) => ({ ...step, fields: [...step.fields, bill] }));
    expect(refusal(() => assertStepsHoldWhatTheyAreFor(wrong)).message).toMatch(
      /cannot accept a Utility Bill/,
    );
  });

  it('refuses the same document twice on its step', () => {
    const twice = edit('document', (step) => ({ ...step, fields: [...step.fields, passport] }));
    expect(refusal(() => assertStepsHoldWhatTheyAreFor(twice)).message).toMatch(
      /lists the Passport twice/,
    );
  });

  it.each(['document', 'address'])('refuses %s accepting no document at all', (slug) => {
    const none = edit(slug, (step) => ({ ...step, fields: [] }));
    expect(refusal(() => assertStepsHoldWhatTheyAreFor(none)).message).toMatch(
      /at least one document/,
    );
  });

  it.each(['document', 'address', 'selfie'])(
    'refuses any field of the broker’s own on %s',
    (slug) => {
      const extra = edit(slug, (step) => ({
        ...step,
        fields: [
          ...step.fields,
          { id: 'f-x', name: 'customField_x', label: 'Bank letter', type: 'file', required: true },
        ],
      }));
      expect(refusal(() => assertStepsHoldWhatTheyAreFor(extra)).message).toMatch(
        /on a step of your own/,
      );
    },
  );

  it.each(['file', 'camera'])('refuses a %s upload on Personal Information', (type) => {
    const upload = edit('personal', (step) => ({
      ...step,
      fields: [
        ...step.fields,
        { id: 'f-x', name: 'customField_x', label: 'Payslip', type, required: false },
      ],
    }));
    expect(refusal(() => assertStepsHoldWhatTheyAreFor(upload)).message).toMatch(
      /Uploads go on a step of your own/,
    );
  });

  it('ALLOWS questions on Personal Information, and uploads on a step of the broker’s own', () => {
    const questions = edit('personal', (step) => ({
      ...step,
      fields: [
        ...step.fields,
        { id: 'f-q1', name: 'customField_q1', label: 'Occupation', type: 'text', required: true },
        {
          id: 'f-q2',
          name: 'customField_q2',
          label: 'I am not a politically exposed person',
          type: 'checkbox',
          required: true,
        },
      ],
    }));
    const uploads = [
      ...questions,
      custom({
        fields: [
          {
            id: 'f-u1',
            name: 'customField_u1',
            label: 'Bank letter',
            type: 'file',
            required: true,
          },
          {
            id: 'f-u2',
            name: 'customField_u2',
            label: 'Holding card',
            type: 'camera',
            required: false,
          },
        ],
      }),
    ];
    expect(() => assertKycConfigIntegrity(FORM, uploads)).not.toThrow();
  });
});

describe('the keys a broker’s own field may take', () => {
  it.each(['doc_front', 'selfie', 'address_proof_2', 'passport', 'docType', 'firstName'])(
    'refuses "%s" — the system reads it by name',
    (name) => {
      const clash = [
        ...FORM,
        custom({
          fields: [{ id: 'f-x', name, label: 'Something', type: 'text', required: false }],
        }),
      ];
      expect(() => assertKycConfigIntegrity(FORM, clash)).toThrow(FieldValidationError);
    },
  );

  it.each(['__proto__', 'constructor', '__secret'])('refuses the internal name "%s"', (name) => {
    const clash = [
      ...FORM,
      custom({ fields: [{ id: 'f-x', name, label: 'Something', type: 'text', required: false }] }),
    ];
    expect(refusal(() => assertFieldKeys(clash)).message).toMatch(/internally/);
  });

  it('refuses one key on two steps — a reviewer’s flag names a field by its key alone', () => {
    const [first, second] = ['Employer', 'Employer (again)'].map((label) => ({
      id: `f-${label}`,
      name: 'customField_1',
      label,
      type: 'text',
      required: false,
    }));
    const twice = edit('personal', (step) => ({ ...step, fields: [...step.fields, first] }), [
      ...FORM,
      custom({ fields: [second] }),
    ]);
    expect(refusal(() => assertFieldKeys(twice)).message).toMatch(/share one key/);
  });
});

describe('every step has its own address, and keeps it', () => {
  it('refuses two steps on one address', () => {
    const twice = [...FORM, custom(), custom({ id: 'step-other', title: 'Other' })];
    expect(refusal(() => assertStepAddresses(FORM, twice)).message).toMatch(/share one address/);
  });

  it('refuses moving an existing step to a new address — its answers are filed there', () => {
    const before = [...FORM, custom()];
    const moved = [...FORM, custom({ slug: 'funds' })];
    expect(refusal(() => assertStepAddresses(before, moved)).message).toMatch(
      /cannot move to a new address/,
    );
  });

  it.each([
    ['review', /platform uses that address/],
    ['Source Of Funds', /lower-case letters/],
    ['funds!', /lower-case letters/],
  ])('refuses a new step at "%s"', (slug, why) => {
    expect(refusal(() => assertStepAddresses(FORM, [...FORM, custom({ slug })])).message).toMatch(
      why,
    );
  });

  it('leaves an address an older build accepted alone — clients have answered under it', () => {
    const old = custom({ slug: 'custom slug 1' });
    expect(() => assertKycConfigIntegrity([...FORM, old], [...FORM, old])).not.toThrow();
  });

  it('refuses a step of the broker’s own wearing a built-in step’s name', () => {
    const lookalike = [...FORM, custom({ title: 'Identity document' })];
    expect(refusal(() => assertStepAddresses(FORM, lookalike)).message).toMatch(
      /name of a built-in step/,
    );
  });
});
