import { describe, expect, it } from 'vitest';
import {
  assertFieldKeysUniquePerStep,
  assertFieldsFitTheirStep,
  assertKycConfigIntegrity,
  assertProfileFieldsKeepTheirPlace,
  assertReservedKeysNotRenamed,
} from './kyc-config-integrity';
import { DEFAULT_KYC_STEPS, type KycStepConfig } from '../../store/kyc-config.store';
import {
  PROFILE_CHOICES,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELD_TYPE,
} from '../../common/profile/client-profile';

/**
 * The rules that stop the builder saving a form that cannot work.
 *
 * Each case below was ACCEPTED before these existed, and each failed later and
 * somewhere else — in a client's browser, in a reviewer's card, or not at all.
 * The last of those is the reason this file is worth its run time: a renamed
 * `dateOfBirth` does not fail, it SKIPS, and the form still looks right.
 *
 * The "allowed" cases matter as much as the refusals. `admin-compliance.service`
 * records that the mandatory-step rule was dropped on purpose — a flow that
 * refuses to drop four of its steps is not configurable — so a guard that
 * quietly reinstates it by another route would be the worse bug.
 */

const field = (over: Partial<KycStepConfig['fields'][number]> = {}) => ({
  id: 'f1',
  name: 'firstName',
  label: 'First Name',
  type: 'text',
  required: true,
  ...over,
});

const step = (over: Partial<KycStepConfig> = {}) =>
  ({
    id: 's1',
    slug: 'personal',
    title: 'Personal',
    stepNumber: 1,
    enabled: true,
    fields: [field()],
    ...over,
  }) as KycStepConfig;

/*
 * The step-slug rule that used to be tested here was WITHDRAWN — see the long
 * note in `kyc-config-integrity.ts`. Its facts were right and its scope was not:
 * the configuration layer advertises arbitrary steps (`kyc-config-round-trip`
 * saves ones slugged `other` and `audit` on purpose), and refusing them also
 * broke a PERMISSION test in `kyc-http.spec.ts` for an unrelated reason, so the
 * boundary that test exists to prove stopped being exercised.
 *
 * The cases below are the two that hold under every reading of what a step is.
 */

describe('two fields in one step cannot share a key', () => {
  /*
   * Answers merge into one object per step, so the second field's value
   * overwrites the first's. The client answers twice and the reviewer sees one.
   */
  it('refuses a duplicate key, naming the step and the key', () => {
    const clash = step({
      fields: [field({ id: 'a', name: 'firstName' }), field({ id: 'b', name: 'firstName' })],
    });
    expect(() => assertFieldKeysUniquePerStep([clash])).toThrow(/firstName/);
    expect(() => assertFieldKeysUniquePerStep([clash])).toThrow(/Personal/);
  });

  /** Different steps are different columns, so the same key is fine. */
  it('allows the same key in two DIFFERENT steps', () => {
    expect(() =>
      assertFieldKeysUniquePerStep([
        step({ id: 's1', slug: 'personal', fields: [field({ name: 'notes' })] }),
        step({ id: 's2', slug: 'address', fields: [field({ id: 'f2', name: 'notes' })] }),
      ]),
    ).not.toThrow();
  });
});

describe('a reserved key cannot be renamed out from under the server', () => {
  const reserved = (name: string) => [step({ fields: [field({ id: 'f1', name })] })];

  /*
   * EVERY profile field since 0139: the key IS the profile column the answer
   * is stored in, so a renamed key stops reaching the profile — the answer
   * lands in `personal_info` as an anonymous custom answer, and the reviewer's
   * record of the client stops matching what the client typed.
   */
  it.each(PROFILE_FIELD_KEYS.filter((key) => key !== 'dateOfBirth'))(
    'refuses renaming %s, and names what would break',
    (key) => {
      const before = reserved(key);
      const after = [step({ fields: [field({ id: 'f1', name: 'renamed' })] })];
      expect(() => assertReservedKeysNotRenamed(before, after)).toThrow(/client's profile/);
    },
  );

  it('refuses renaming dateOfBirth, naming the age check it would switch off', () => {
    const after = [step({ fields: [field({ id: 'f1', name: 'dob' })] })];
    expect(() => assertReservedKeysNotRenamed(reserved('dateOfBirth'), after)).toThrow(
      /minimum-age/,
    );
  });

  /**
   * ⚠️ REMOVING the field is ALLOWED, and this is the case that keeps the rule
   * mechanical rather than political.
   *
   * A broker may decide not to collect a date of birth at all — that is their
   * jurisdiction's call, and the dropped mandatory-step rule says so. What is
   * refused is keeping the field and changing only its key, because that reads
   * on screen as a cosmetic edit while switching a server check off.
   */
  it('ALLOWS removing a reserved field entirely', () => {
    expect(() => assertReservedKeysNotRenamed(reserved('dateOfBirth'), [])).not.toThrow();
    expect(() =>
      assertReservedKeysNotRenamed(reserved('dateOfBirth'), [step({ fields: [] })]),
    ).not.toThrow();
  });

  /** Relabelling and reordering are cosmetic and must stay free. */
  it('allows changing the LABEL of a reserved field', () => {
    const after = [
      step({ fields: [field({ id: 'f1', name: 'dateOfBirth', label: 'Birth date' })] }),
    ];
    expect(() => assertReservedKeysNotRenamed(reserved('dateOfBirth'), after)).not.toThrow();
  });

  it('leaves ordinary keys freely renameable', () => {
    const before = [step({ fields: [field({ id: 'f1', name: 'middleName' })] })];
    const after = [step({ fields: [field({ id: 'f1', name: 'secondName' })] })];
    expect(() => assertReservedKeysNotRenamed(before, after)).not.toThrow();
  });

  /**
   * Matched on `id`, so a rename cannot hide behind a reorder or a relabel —
   * the two edits most likely to be made in the same save.
   */
  it('catches a rename even when the field has MOVED and been relabelled', () => {
    const after = [
      step({
        fields: [
          field({ id: 'other', name: 'nickname' }),
          field({ id: 'f1', name: 'dob', label: 'DOB' }),
        ],
      }),
    ];
    expect(() => assertReservedKeysNotRenamed(reserved('dateOfBirth'), after)).toThrow(
      /dateOfBirth/,
    );
  });
});

describe('documents at home, every other field anywhere, and no step left impossible', () => {
  /*
   * Reported from local testing: documents on a step the broker added, and the
   * week of bugs that came from giving them a second home there. And the other
   * half, asked for the same day: extra questions and uploads on the built-in
   * steps, which must WORK rather than be refused.
   */
  const passport = field({ id: 'p', name: 'passport', label: 'Passport', type: 'doc:passport' });
  const bill = field({ id: 'b', name: 'bill', label: 'Utility Bill', type: 'doc:utility_bill' });
  const camera = field({ id: 's', name: 'selfie', label: 'Selfie', type: 'camera' });
  /** The step's core, so what is asserted is only the field added beside it. */
  const coreOf = (slug: string) =>
    slug === 'document'
      ? [passport]
      : slug === 'address'
        ? [bill]
        : slug === 'selfie'
          ? [camera]
          : [];
  const check =
    (slug: string, ...extra: ReturnType<typeof field>[]) =>
    () =>
      assertFieldsFitTheirStep([step({ slug, title: slug, fields: [...coreOf(slug), ...extra] })]);

  it('keeps every document off a step the broker added, and says what to use instead', () => {
    expect(check('source-of-funds', passport)).toThrow(/document type.*File field/);
    expect(check('source-of-funds', bill)).toThrow(/document type/);
  });

  it('keeps every document off the personal and selfie steps', () => {
    expect(check('personal', field({ type: 'doc:national_id' }))).toThrow(/document type/);
    expect(check('selfie', field({ id: 'x', name: 'x', type: 'doc:passport' }))).toThrow(
      /document type/,
    );
  });

  it('refuses a document of the other KIND on a document step — its pages would be filed as the wrong one', () => {
    expect(check('document', bill)).toThrow(/Utility Bill.*proof of address.*wrong document/);
    expect(check('address', passport)).toThrow(/Passport.*identity document.*wrong document/);
  });

  it('ALLOWS every other field on EVERY step — the extra questions and uploads a broker adds', () => {
    for (const slug of ['personal', 'document', 'address', 'selfie', 'source-of-funds']) {
      for (const type of ['text', 'date', 'phone', 'select', 'checkbox', 'file', 'camera']) {
        expect(
          check(slug, field({ id: 'extra', name: 'extra', type })),
          `${type} on ${slug}`,
        ).not.toThrow();
      }
    }
  });

  it('refuses a document step that offers no document — nobody could complete it', () => {
    expect(() =>
      assertFieldsFitTheirStep([
        step({ slug: 'address', title: 'Proof of Address', fields: [field()] }),
      ]),
    ).toThrow(/"Proof of Address" offers no document.*disable the step/);
  });

  it('refuses a selfie step without its selfie camera', () => {
    expect(() =>
      assertFieldsFitTheirStep([step({ slug: 'selfie', title: 'Selfie', fields: [field()] })]),
    ).toThrow(/needs its selfie camera/);
    expect(() =>
      assertFieldsFitTheirStep([
        step({ slug: 'selfie', title: 'Selfie', fields: [{ ...camera, type: 'text' }] }),
      ]),
    ).toThrow(/needs its selfie camera/);
  });

  it('accepts the default configuration exactly as seeded', () => {
    expect(() => assertFieldsFitTheirStep(DEFAULT_KYC_STEPS)).not.toThrow();
  });

  it('tolerates a document the catalogue has withdrawn, beside one it knows', () => {
    expect(
      check('document', field({ id: 'old', name: 'old', type: 'doc:old_card' })),
    ).not.toThrow();
  });

  it('reads the step table by OWN key — a slug is typed by an operator', () => {
    // `constructor` is a step somebody added, not an entry on the prototype.
    expect(check('constructor', passport)).toThrow(/document type/);
    expect(check('constructor', field({ type: 'file' }))).not.toThrow();
  });
});

describe('a profile field keeps its kind, its list, and its step (0139)', () => {
  /*
   * The personal step is where the KYC form reads and writes the client's
   * PROFILE, and each profile field lands in a typed column. The broker still
   * owns the form — relabel, reorder, require, remove — but three edits would
   * break the client's record rather than the form, and each is refused here.
   */
  const personal = (fields: ReturnType<typeof field>[]) => [
    step({ slug: 'personal', title: 'Personal Information', fields }),
  ];
  const profileField = (name: string, over: Partial<ReturnType<typeof field>> = {}) =>
    field({
      id: `f-${name}`,
      name,
      label: name,
      type: PROFILE_FIELD_TYPE[name as keyof typeof PROFILE_FIELD_TYPE],
      ...over,
    });

  it('accepts the default configuration, and every profile field in it at its own type', () => {
    expect(() => assertProfileFieldsKeepTheirPlace(DEFAULT_KYC_STEPS)).not.toThrow();
    expect(() => assertKycConfigIntegrity(DEFAULT_KYC_STEPS, DEFAULT_KYC_STEPS)).not.toThrow();
    const onPersonal = DEFAULT_KYC_STEPS.find((s) => s.slug === 'personal')!.fields.map(
      (f) => f.name,
    );
    // The seeded form asks for the WHOLE profile, city and postal code included.
    expect([...onPersonal].sort()).toEqual([...PROFILE_FIELD_KEYS].sort());
  });

  it.each(
    PROFILE_FIELD_KEYS.flatMap((key) =>
      ['text', 'date', 'select', 'phone', 'checkbox', 'file']
        .filter((type) => type !== PROFILE_FIELD_TYPE[key])
        .map((type) => [key, type] as const),
    ),
  )('refuses %s re-typed as %s — its answer lands in a typed column', (key, type) => {
    expect(() =>
      assertProfileFieldsKeepTheirPlace(personal([profileField(key, { type })])),
    ).toThrow(/must stay a .* field/);
  });

  it.each(PROFILE_FIELD_KEYS)(
    'refuses %s on any other step — it would be a second copy beside the profile',
    (key) => {
      for (const slug of ['document', 'address', 'selfie', 'source-of-funds']) {
        expect(
          () =>
            assertProfileFieldsKeepTheirPlace([
              step({ slug, title: slug, fields: [profileField(key)] }),
            ]),
          `${key} on ${slug}`,
        ).toThrow(/Personal Information step only/);
      }
    },
  );

  it('ALLOWS relabelling, requiring, un-requiring and hinting a profile field', () => {
    expect(() =>
      assertProfileFieldsKeepTheirPlace(
        personal([
          profileField('dateOfBirth', { label: 'Birth date', required: false, hint: 'As on ID' }),
          profileField('city', { label: 'Town', required: true }),
        ]),
      ),
    ).not.toThrow();
  });

  it('ALLOWS removing profile fields — the broker decides what is collected', () => {
    expect(() => assertProfileFieldsKeepTheirPlace(personal([]))).not.toThrow();
    expect(() =>
      assertKycConfigIntegrity(DEFAULT_KYC_STEPS, [
        ...DEFAULT_KYC_STEPS.filter((s) => s.slug !== 'personal'),
        {
          ...DEFAULT_KYC_STEPS.find((s) => s.slug === 'personal')!,
          fields: DEFAULT_KYC_STEPS.find((s) => s.slug === 'personal')!.fields.filter(
            (f) => f.name !== 'postalCode' && f.name !== 'nationality',
          ),
        },
      ]),
    ).not.toThrow();
  });

  it('leaves a broker’s own fields alone — any type, any step', () => {
    for (const slug of ['personal', 'document', 'source-of-funds']) {
      for (const type of ['text', 'date', 'select', 'phone', 'checkbox', 'file']) {
        expect(() =>
          assertProfileFieldsKeepTheirPlace([
            step({ slug, fields: [field({ id: 'x', name: 'customField_1', type })] }),
          ]),
        ).not.toThrow();
      }
    }
  });

  it('reads the profile keys by OWN name — a key is typed by an operator', () => {
    // `constructor` and `toString` are a broker's words, not profile fields.
    for (const name of ['constructor', 'toString', '__proto__', 'Phone', 'first_name']) {
      expect(() =>
        assertProfileFieldsKeepTheirPlace([
          step({ slug: 'document', fields: [field({ id: 'x', name, type: 'text' })] }),
        ]),
      ).not.toThrow();
    }
  });

  describe('the drop-downs offer the platform’s list, and only that', () => {
    it.each(['country', 'nationality'] as const)(
      '%s: the list arriving back unchanged is an ordinary save',
      (key) => {
        const options = [...PROFILE_CHOICES[key]!];
        expect(() =>
          assertProfileFieldsKeepTheirPlace(personal([profileField(key, { options })])),
        ).not.toThrow();
        // …and so is no list at all — it is served on every read.
        expect(() =>
          assertProfileFieldsKeepTheirPlace(personal([profileField(key, { options: [] })])),
        ).not.toThrow();
      },
    );

    it.each(['country', 'nationality'] as const)(
      '%s: refuses an added choice — the profile could never store it',
      (key) => {
        const options = [...PROFILE_CHOICES[key]!, 'UAE'];
        expect(() =>
          assertProfileFieldsKeepTheirPlace(personal([profileField(key, { options })])),
        ).toThrow(/choices cannot be edited/);
      },
    );

    it.each(['country', 'nationality'] as const)(
      '%s: refuses a removed choice — registration would still accept it',
      (key) => {
        const options = PROFILE_CHOICES[key]!.slice(1);
        expect(() =>
          assertProfileFieldsKeepTheirPlace(personal([profileField(key, { options })])),
        ).toThrow(/choices cannot be edited/);
      },
    );

    it('refuses a reordered list too — it is not the list the profile is judged by', () => {
      const options = [...PROFILE_CHOICES.country!].reverse();
      expect(() =>
        assertProfileFieldsKeepTheirPlace(personal([profileField('country', { options })])),
      ).toThrow(/choices cannot be edited/);
    });
  });

  it('is part of every save — `assertKycConfigIntegrity` runs it', () => {
    const retyped = DEFAULT_KYC_STEPS.map((s) =>
      s.slug === 'personal'
        ? {
            ...s,
            fields: s.fields.map((f) => (f.name === 'dateOfBirth' ? { ...f, type: 'text' } : f)),
          }
        : s,
    );
    expect(() => assertKycConfigIntegrity(DEFAULT_KYC_STEPS, retyped)).toThrow(
      /must stay a date field/,
    );
  });
});
