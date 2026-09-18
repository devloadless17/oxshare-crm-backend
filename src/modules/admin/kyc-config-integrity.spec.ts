import { describe, expect, it } from 'vitest';
import { assertFieldKeysUniquePerStep, assertReservedKeysNotRenamed } from './kyc-config-integrity';
import type { KycStepConfig } from '../../store/kyc-config.store';

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

  it.each([
    ['dateOfBirth', /minimum-age/],
    ['phone', /phone number/],
    ['country', /country/],
  ])('refuses renaming %s, and names what would break', (key, expected) => {
    const before = reserved(key);
    const after = [step({ fields: [field({ id: 'f1', name: 'renamed' })] })];
    expect(() => assertReservedKeysNotRenamed(before, after)).toThrow(expected);
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
