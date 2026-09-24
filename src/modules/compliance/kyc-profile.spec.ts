import { describe, expect, it } from 'vitest';
import { ageInYears, findProfileProblem, MINIMUM_AGE_YEARS } from './kyc-profile';
import type { ProfileFieldRule } from './kyc-profile';

/**
 * The profile rules, unit-tested without a container — the point of the seam.
 *
 * What these pin, in order of what it costs to get wrong:
 *
 *  1. An empty profile is refused. `submit()` used to test `!personalInfo`, the
 *     truthiness of an object, and `{}` is truthy — so a submission with no
 *     name, no date of birth and no address reached the review queue behind
 *     three genuine document images.
 *  2. A client under 18 is refused. "Must be 18+" was a hint string in the
 *     seeded config and a check in the browser; the API had none.
 *  3. The required set comes from the CONFIGURATION, because the admin KYC
 *     builder owns it (D-29). Hardcoding it here would mean the API enforced one
 *     thing while the portal rendered another.
 *
 * `asOf` is passed in rather than read from the clock, so the age cases are
 * fixed dates instead of arithmetic against today.
 */

const RULES: ProfileFieldRule[] = [
  { name: 'firstName', label: 'First Name', type: 'text', required: true },
  { name: 'lastName', label: 'Last Name', type: 'text', required: true },
  { name: 'dateOfBirth', label: 'Date of Birth', type: 'date', required: true },
  { name: 'address', label: 'Residential Address', type: 'text', required: false },
  { name: 'doc_front', label: 'ID Front', type: 'file', required: true },
];

const NOW = new Date('2026-08-05T12:00:00.000Z');

const complete = (over: Record<string, unknown> = {}) => ({
  firstName: 'Jane',
  lastName: 'Doe',
  dateOfBirth: '1990-01-01',
  ...over,
});

describe('findProfileProblem — completeness', () => {
  it('accepts a profile with every required field', () => {
    expect(findProfileProblem(complete(), RULES, NOW)).toBeUndefined();
  });

  it('REFUSES an empty object, which is the defect it was written for', () => {
    const problem = findProfileProblem({}, RULES, NOW);
    expect(problem?.kind).toBe('missing_fields');
  });

  it('refuses an absent profile', () => {
    expect(findProfileProblem(undefined, RULES, NOW)?.kind).toBe('missing_fields');
  });

  it('names every missing field, so the client can fix them in one pass', () => {
    // Returning "profile incomplete" would make the client guess, and each guess
    // is another round trip through a form on a phone.
    const problem = findProfileProblem({ firstName: 'Jane' }, RULES, NOW);
    expect(problem?.fields).toEqual(['lastName', 'dateOfBirth']);
  });

  it('treats whitespace as absent', () => {
    // '   ' satisfies a truthiness check and satisfies nobody reviewing it.
    expect(findProfileProblem(complete({ lastName: '   ' }), RULES, NOW)?.fields).toEqual([
      'lastName',
    ]);
  });

  it('treats a structured value as absent', () => {
    // The column is jsonb, so a value can be an object. String(value) would give
    // '[object Object]' — non-empty, and therefore accepted by a naive check.
    expect(findProfileProblem(complete({ firstName: {} }), RULES, NOW)?.fields).toEqual([
      'firstName',
    ]);
    expect(findProfileProblem(complete({ firstName: ['a'] }), RULES, NOW)?.fields).toEqual([
      'firstName',
    ]);
  });

  it('does not demand optional fields', () => {
    // `address` is configured required:false. Enforcing it anyway would mean the
    // API disagreeing with the builder about what onboarding asks for.
    expect(findProfileProblem(complete(), RULES, NOW)).toBeUndefined();
  });

  it('does not demand file or camera fields, which are satisfied by an upload', () => {
    // `doc_front` is required and lives in a different part of the submission.
    // Demanding it in this blob would reject every complete submission.
    expect(findProfileProblem(complete(), RULES, NOW)).toBeUndefined();
  });

  it('follows the configuration rather than a hardcoded list', () => {
    // The admin builder owns the field set (D-29). A field added there must be
    // enforced here without this file changing.
    const withCustom: ProfileFieldRule[] = [
      ...RULES,
      { name: 'taxId', label: 'Tax ID', type: 'text', required: true },
    ];
    expect(findProfileProblem(complete(), withCustom, NOW)?.fields).toEqual(['taxId']);
    expect(findProfileProblem(complete({ taxId: 'X1' }), withCustom, NOW)).toBeUndefined();
  });
});

describe('findProfileProblem — minimum age', () => {
  it('refuses a client under the minimum age', () => {
    const problem = findProfileProblem(complete({ dateOfBirth: '2015-01-01' }), RULES, NOW);
    expect(problem?.kind).toBe('underage');
    expect(problem?.message).toContain(String(MINIMUM_AGE_YEARS));
  });

  it('admits a client on their 18th birthday, and refuses them the day before', () => {
    // The boundary, both sides. Off-by-one here onboards a minor.
    expect(findProfileProblem(complete({ dateOfBirth: '2008-08-05' }), RULES, NOW)).toBeUndefined();
    expect(findProfileProblem(complete({ dateOfBirth: '2008-08-06' }), RULES, NOW)?.kind).toBe(
      'underage',
    );
  });

  it('refuses a date of birth in the future', () => {
    expect(findProfileProblem(complete({ dateOfBirth: '2030-01-01' }), RULES, NOW)?.kind).toBe(
      'invalid_date_of_birth',
    );
  });

  it('refuses a value that is not a date', () => {
    // Untyped jsonb: 'yesterday' is exactly the sort of thing that arrives.
    expect(findProfileProblem(complete({ dateOfBirth: 'yesterday' }), RULES, NOW)?.kind).toBe(
      'invalid_date_of_birth',
    );
  });

  it('checks the age of an OPTIONAL date of birth too', () => {
    // Whether the field is required is the configuration's call; whether a
    // supplied value is acceptable is not. A date of birth saying the client is
    // fourteen disqualifies them however it got there.
    const optional = RULES.map((f) => (f.name === 'dateOfBirth' ? { ...f, required: false } : f));
    expect(findProfileProblem(complete({ dateOfBirth: '2015-01-01' }), optional, NOW)?.kind).toBe(
      'underage',
    );
    // ...and its absence is then genuinely fine.
    expect(
      findProfileProblem({ firstName: 'Jane', lastName: 'Doe' }, optional, NOW),
    ).toBeUndefined();
  });

  it('reports completeness before age, so the client sees one problem at a time', () => {
    const problem = findProfileProblem({ dateOfBirth: '2015-01-01' }, RULES, NOW);
    expect(problem?.kind).toBe('missing_fields');
  });
});

describe('ageInYears', () => {
  it('counts whole years, not elapsed milliseconds', () => {
    expect(ageInYears(new Date('1990-01-01'), new Date('2026-01-01'))).toBe(36);
    expect(ageInYears(new Date('1990-01-02'), new Date('2026-01-01'))).toBe(35);
  });

  it('does not let leap years admit someone early', () => {
    /*
     * The reason this is calendar arithmetic and not (now - dob) / MS_PER_YEAR.
     * Across 18 years there are between 4 and 5 leap days, so the division form
     * drifts by about a day — and it drifts in the direction that admits a
     * minor. Someone born on 29 February turns 18 on 1 March in a common year.
     */
    expect(ageInYears(new Date('2008-02-29'), new Date('2026-02-28'))).toBe(17);
    expect(ageInYears(new Date('2008-02-29'), new Date('2026-03-01'))).toBe(18);
  });
});

describe('a phone number must be one somebody can dial', () => {
  /*
   * Reported from production: the picker writes the country code the moment a
   * country is chosen, so "+961" alone satisfied a REQUIRED phone and reached
   * the reviewer as the client's number.
   */
  const withPhone: ProfileFieldRule[] = [
    ...RULES,
    { name: 'phone', label: 'Phone Number', type: 'phone', required: true },
  ];

  it('treats a country code alone as MISSING', () => {
    const problem = findProfileProblem(complete({ phone: '+961' }), withPhone, NOW);
    expect(problem).toMatchObject({ kind: 'missing_fields', fields: ['phone'] });
  });

  it('refuses a number cut short, naming the field', () => {
    const problem = findProfileProblem(complete({ phone: '+961 70 12' }), withPhone, NOW);
    expect(problem).toMatchObject({ kind: 'invalid_phone', fields: ['phone'] });
    expect(problem?.message).toMatch(/Phone Number is incomplete/);
  });

  it('accepts a complete number', () => {
    expect(
      findProfileProblem(complete({ phone: '+961 70 123 456' }), withPhone, NOW),
    ).toBeUndefined();
  });

  it('lets an OPTIONAL phone stay empty — a bare code included — but not half-typed', () => {
    const optional = withPhone.map((f) => (f.name === 'phone' ? { ...f, required: false } : f));
    expect(findProfileProblem(complete({ phone: '+961' }), optional, NOW)).toBeUndefined();
    expect(findProfileProblem(complete(), optional, NOW)).toBeUndefined();
    expect(findProfileProblem(complete({ phone: '+961 7' }), optional, NOW)?.kind).toBe(
      'invalid_phone',
    );
  });

  it('does not demand a DOCUMENT field as a typed value', () => {
    const withDoc: ProfileFieldRule[] = [
      ...RULES,
      { name: 'passport', label: 'Passport', type: 'doc:passport', required: true },
    ];
    expect(findProfileProblem(complete(), withDoc, NOW)).toBeUndefined();
  });
});
