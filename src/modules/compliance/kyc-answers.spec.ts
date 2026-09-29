import { describe, expect, it } from 'vitest';
import {
  MAX_ANSWER_LENGTH,
  documentTypeFor,
  isBarePhonePrefix,
  isCompletePhone,
  typedAnswersFor,
  type AnswerField,
} from './kyc-answers';

/**
 * What a client may write into their own KYC submission.
 *
 * Every case here is a thing that reached production or could have: the
 * portal's review screen posted its whole form as the personal step, so
 * document-choice keys, custom-step answers and "[object Object]" were stored
 * as the client's personal details; and the same merge accepted file paths into
 * the columns that hold identity documents.
 */

const PERSONAL: AnswerField[] = [
  { name: 'firstName', label: 'First Name', type: 'text', required: true },
  { name: 'dateOfBirth', label: 'Date of Birth', type: 'date', required: true },
  { name: 'phone', label: 'Phone Number', type: 'phone', required: true },
  { name: 'country', label: 'Country', type: 'select' },
  { name: 'consent', label: 'I agree', type: 'checkbox' },
  { name: 'proof', label: 'Proof', type: 'file' },
];

describe('only the fields the step asks for are stored', () => {
  it('drops keys the configuration does not name — the review screen’s whole form', () => {
    const { answers, problems } = typedAnswersFor(PERSONAL, {
      firstName: 'Jane',
      __docChoice__document: 'passport',
      customField_1790263652846: 'from another step',
      docType: 'passport',
    });
    expect(answers).toEqual({ firstName: 'Jane' });
    expect(problems).toEqual([]);
  });

  it('drops a value that is not a string — how "[object Object]" became an answer', () => {
    const { answers } = typedAnswersFor(PERSONAL, {
      firstName: { filePath: 'uploads/kyc/x.jpg' },
      dateOfBirth: 19900101,
      country: ['Lebanon'],
    });
    expect(answers).toEqual({});
  });

  it('never stores a FILE field, even when the key is configured', () => {
    // A file's answer is written by the upload route alone; accepting one here
    // is how a forged `{ filePath }` pointing at another client's upload gets in.
    const { answers } = typedAnswersFor(PERSONAL, { proof: 'uploads/kyc/someone-else.jpg' });
    expect(answers).toEqual({});
  });

  it('ignores inherited keys — the prototype is not a field list', () => {
    const { answers } = typedAnswersFor([{ name: 'toString', label: 'x', type: 'text' }], {});
    expect(answers).toEqual({});
  });

  it('trims what it keeps, and keeps an empty string so a field can be cleared', () => {
    const { answers } = typedAnswersFor(PERSONAL, { firstName: '  Jane  ', country: '' });
    expect(answers).toEqual({ firstName: 'Jane', country: '' });
  });

  it('refuses an answer longer than the bound', () => {
    const { answers, problems } = typedAnswersFor(PERSONAL, {
      firstName: 'x'.repeat(MAX_ANSWER_LENGTH + 1),
    });
    expect(answers).toEqual({});
    expect(problems).toEqual([{ field: 'firstName', message: expect.stringMatching(/too long/) }]);
  });
});

describe('a phone number is one somebody can dial', () => {
  it('reads a country code alone as NOT ANSWERED — the reported "+961"', () => {
    const { answers, problems } = typedAnswersFor(PERSONAL, { phone: '+961' });
    expect(answers).toEqual({ phone: '' });
    expect(problems).toEqual([]);
  });

  it.each(['+961 7', '+961 70 12', '70123456', '+961 12 345 678'])(
    'refuses %j as incomplete',
    (phone) => {
      const { answers, problems } = typedAnswersFor(PERSONAL, { phone });
      expect(answers).toEqual({});
      expect(problems[0]).toEqual({
        field: 'phone',
        message: expect.stringMatching(/Phone Number is incomplete/),
      });
    },
  );

  it.each(['+961 70 123 456', '+971 50 123 4567', '+44 7911 123456', '+1 202 555 0123'])(
    'accepts %j',
    (phone) => {
      expect(typedAnswersFor(PERSONAL, { phone }).answers).toEqual({ phone });
    },
  );

  it.each([
    ['', true],
    ['+961', true],
    ['+1684', true],
    [' +961 ', true],
    ['+961 7', false],
    ['+96170', false],
    ['70 123 456', false],
  ])('isBarePhonePrefix(%j) is %s', (value, expected) => {
    expect(isBarePhonePrefix(value)).toBe(expected);
  });

  it('isCompletePhone agrees with the country’s length rules', () => {
    expect(isCompletePhone('+961 70 123 456')).toBe(true);
    expect(isCompletePhone('+961 70 123')).toBe(false);
  });
});

describe('each field type holds only what it can mean', () => {
  it('refuses a date that does not parse', () => {
    const { problems } = typedAnswersFor(PERSONAL, { dateOfBirth: 'yesterday-ish' });
    expect(problems[0]?.field).toBe('dateOfBirth');
  });

  it('does not police a select against its list — a stale tab must not block a client', () => {
    expect(typedAnswersFor(PERSONAL, { country: 'Atlantis' }).answers).toEqual({
      country: 'Atlantis',
    });
  });

  it('holds a checkbox to true or false', () => {
    expect(typedAnswersFor(PERSONAL, { consent: 'true' }).answers).toEqual({ consent: 'true' });
    expect(typedAnswersFor(PERSONAL, { consent: 'yes' }).problems[0]?.field).toBe('consent');
  });

  it('reports every problem, not just the first', () => {
    const { problems } = typedAnswersFor(PERSONAL, { dateOfBirth: 'soon', phone: '+961 7' });
    expect(problems.map((p) => p.field)).toEqual(['dateOfBirth', 'phone']);
  });
});

describe('a document step records a document of its own category', () => {
  it.each([
    ['identity', 'national_id', 'national_id'],
    ['identity', ' passport ', 'passport'],
    ['address', 'utility_bill', 'utility_bill'],
    ['identity', 'utility_bill', undefined],
    ['address', 'passport', undefined],
    ['identity', '', undefined],
    ['identity', 'National ID', undefined],
    ['identity', undefined, undefined],
    ['identity', { value: 'passport' }, undefined],
  ] as const)('%s + %j → %j', (category, value, expected) => {
    expect(documentTypeFor(category, value)).toBe(expected);
  });
});

describe('a checkbox WITH choices is "tick all that apply"', () => {
  // Asked for in local testing: "where can I put checkbox options?"
  const funds = {
    name: 'funds',
    label: 'Source of funds',
    type: 'checkbox',
    options: ['Salary', 'Savings', 'Gift'],
  };

  it('stores the ticked choices, in the order the broker listed them', () => {
    expect(typedAnswersFor([funds], { funds: 'Gift, Salary' }).answers).toEqual({
      funds: 'Salary, Gift',
    });
  });

  it('stores nothing ticked as an empty answer', () => {
    expect(typedAnswersFor([funds], { funds: '' }).answers).toEqual({ funds: '' });
  });

  it('refuses a choice the field does not offer, naming it', () => {
    const { answers, problems } = typedAnswersFor([funds], { funds: 'Salary, Lottery' });
    expect(answers).toEqual({});
    expect(problems).toEqual([
      { field: 'funds', message: 'Source of funds: "Lottery" is not one of its choices.' },
    ]);
  });

  it('leaves a single checkbox a yes-or-no', () => {
    const consent = { name: 'consent', label: 'I agree', type: 'checkbox' };
    expect(typedAnswersFor([consent], { consent: 'true' }).answers).toEqual({ consent: 'true' });
    expect(typedAnswersFor([consent], { consent: 'Salary' }).problems).toHaveLength(1);
  });
});
