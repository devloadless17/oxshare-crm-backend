import { describe, expect, it } from 'vitest';
import { identityProblems, isAnswered, type ProfileFieldRule } from './kyc-profile';

/**
 * The judgement of a client's answers (26 Sep 2026).
 *
 *  1. The IDENTITY is judged by the platform's rules — the profile writer's own
 *     checks — and nothing the builder configures. It used to read the required
 *     set and the age rule from the personal step's fields, so deleting the
 *     date-of-birth field switched the age check off.
 *  2. An empty identity is refused. `submit()` once tested `!personalInfo`, the
 *     truthiness of an object, and `{}` is truthy.
 *  3. Every problem is reported at once, in the form's order, so a client fixes
 *     them in one pass rather than meeting one refusal at a time.
 *  4. The broker's own questions are judged by their configuration.
 *
 * Leap years, the 18th birthday and E.164 are pinned where the rules live:
 * `common/profile/client-profile.spec.ts`.
 */

const ASOF = new Date('2026-09-26T12:00:00Z');

const COMPLETE = {
  firstName: 'Layla',
  lastName: 'Haddad',
  dateOfBirth: '1990-04-12',
  nationality: 'Lebanese',
  phone: '+96170123456',
  country: 'Lebanon',
  address: 'Hamra Street 12',
  city: 'Beirut',
};

describe('the identity is judged by the platform’s rules', () => {
  it('accepts a complete identity — the postal code is never required', () => {
    expect(identityProblems(COMPLETE, ASOF)).toEqual([]);
  });

  it('REFUSES an empty object, and an absent profile, naming every field', () => {
    for (const empty of [{}, undefined]) {
      const problems = identityProblems(empty, ASOF);
      expect(problems.map((p) => p.key)).toEqual([
        'firstName',
        'lastName',
        'dateOfBirth',
        'nationality',
        'phone',
        'country',
        'address',
        'city',
      ]);
      expect(problems.every((p) => p.kind === 'missing')).toBe(true);
    }
  });

  it('names what is missing as the client reads it', () => {
    const [problem] = identityProblems({ ...COMPLETE, city: '  ' }, ASOF);
    expect(problem).toEqual({
      key: 'city',
      label: 'City',
      kind: 'missing',
      message: 'City is required.',
    });
  });

  it('treats a structured value as absent — "[object Object]" is not a name', () => {
    expect(identityProblems({ ...COMPLETE, firstName: {} }, ASOF)[0]?.key).toBe('firstName');
  });

  it('refuses an under-age client, whatever the builder says about the field', () => {
    const [problem] = identityProblems({ ...COMPLETE, dateOfBirth: '2015-01-01' }, ASOF);
    expect(problem).toMatchObject({ key: 'dateOfBirth', kind: 'invalid', code: 'underage' });
    expect(problem.message).toMatch(/at least 18 years old/);
  });

  it('refuses every value the profile writer would refuse — the judge and the writer agree', () => {
    const problems = identityProblems(
      {
        ...COMPLETE,
        firstName: 't1',
        phone: '+961 70',
        country: 'Atlantis',
        dateOfBirth: '1990-02-31',
      },
      ASOF,
    );
    expect(problems.map((p) => [p.key, p.kind])).toEqual([
      ['firstName', 'invalid'],
      ['dateOfBirth', 'invalid'],
      ['phone', 'invalid'],
      ['country', 'invalid'],
    ]);
    expect(problems.find((p) => p.key === 'phone')?.code).toBe('invalid_phone');
  });

  it('still judges an OPTIONAL value that was given', () => {
    const [problem] = identityProblems({ ...COMPLETE, postalCode: '!!' }, ASOF);
    expect(problem).toMatchObject({ key: 'postalCode', kind: 'invalid' });
  });
});

describe('the broker’s own questions are judged by their configuration', () => {
  const text: ProfileFieldRule = { name: 'q', label: 'Q', type: 'text', required: true };

  it('treats blank and whitespace as unanswered', () => {
    expect(isAnswered(text, '')).toBe(false);
    expect(isAnswered(text, '   ')).toBe(false);
    expect(isAnswered(text, 'Engineer')).toBe(true);
  });

  it('counts a checkbox only when ticked — "false" is not consent', () => {
    const box: ProfileFieldRule = { name: 'b', label: 'B', type: 'checkbox', required: true };
    expect(isAnswered(box, 'false')).toBe(false);
    expect(isAnswered(box, 'true')).toBe(true);
  });

  it('counts a choice only if the list still offers it — an empty box is not an answer', () => {
    const pick: ProfileFieldRule = {
      name: 'p',
      label: 'P',
      type: 'select',
      required: true,
      options: ['Salary', 'Savings'],
    };
    expect(isAnswered(pick, 'Salary')).toBe(true);
    expect(isAnswered(pick, 'Inheritance')).toBe(false);
  });

  it('never counts a phone’s own dial code as a number', () => {
    const phone: ProfileFieldRule = { name: 't', label: 'T', type: 'phone', required: true };
    expect(isAnswered(phone, '+961')).toBe(false);
    expect(isAnswered(phone, '+96170123456')).toBe(true);
  });
});
