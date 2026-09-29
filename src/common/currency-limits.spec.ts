import { describe, expect, it } from 'vitest';
import {
  currencyLimitProblems,
  effectiveDepositRange,
  formatLimit,
  methodRangeProblems,
} from './currency-limits';

const USD = {
  minDeposit: '10',
  maxDeposit: '250000',
  minWithdrawal: '10',
  maxWithdrawal: '50000',
};

describe('currencyLimitProblems', () => {
  it('accepts a sensible set, and LBP-sized numbers', () => {
    expect(currencyLimitProblems(USD)).toEqual({});
    expect(
      currencyLimitProblems({
        minDeposit: '1000000',
        maxDeposit: '5000000000',
        minWithdrawal: '1000000',
        maxWithdrawal: '500000000',
      }),
    ).toEqual({});
  });

  it('accepts a ceiling EQUAL to its floor — one fixed amount is a real policy', () => {
    expect(currencyLimitProblems({ ...USD, minDeposit: '100', maxDeposit: '100' })).toEqual({});
  });

  it('names each broken field', () => {
    expect(
      currencyLimitProblems({ ...USD, minDeposit: '0', maxWithdrawal: '5', minWithdrawal: '0' }),
    ).toEqual({
      minDeposit: 'The minimum deposit must be above zero.',
      minWithdrawal: 'The minimum withdrawal must be above zero.',
    });
  });

  it('compares as decimals, never as strings — "9" is below "10"', () => {
    expect(currencyLimitProblems({ ...USD, minDeposit: '10', maxDeposit: '9' })).toHaveProperty(
      'maxDeposit',
    );
  });
});

describe('effectiveDepositRange', () => {
  it("is the currency's when the method sets none", () => {
    expect(effectiveDepositRange(USD, { minAmount: null, maxAmount: null })).toEqual({
      min: '10.00000000',
      max: '250000.00000000',
    });
  });

  it('takes the TIGHTER of the two on each side — it can only narrow', () => {
    expect(effectiveDepositRange(USD, { minAmount: '50', maxAmount: '1000' })).toEqual({
      min: '50.00000000',
      max: '1000.00000000',
    });
    // An override looser than the currency (the currency tightened later) loses.
    expect(effectiveDepositRange(USD, { minAmount: '1', maxAmount: '999999' })).toEqual({
      min: '10.00000000',
      max: '250000.00000000',
    });
  });
});

describe('methodRangeProblems', () => {
  it('accepts a range inside the currency’s, or none', () => {
    expect(methodRangeProblems('USD', USD, { minAmount: '20', maxAmount: '5000' })).toEqual({});
    expect(methodRangeProblems('USD', USD, { minAmount: null, maxAmount: null })).toEqual({});
  });

  it('refuses one outside it, naming the range in the currency', () => {
    expect(methodRangeProblems('USD', USD, { minAmount: '5', maxAmount: '300000' })).toEqual({
      minAmount: "It can only narrow the currency's deposit range, 10–250000 USD.",
      maxAmount: "It can only narrow the currency's deposit range, 10–250000 USD.",
    });
  });

  it('refuses a maximum below the minimum', () => {
    expect(methodRangeProblems('USD', USD, { minAmount: '500', maxAmount: '100' })).toEqual({
      maxAmount: 'The maximum cannot be below the minimum.',
    });
  });
});

describe('formatLimit', () => {
  it('strips the ledger zeros and never writes exponent notation', () => {
    expect(formatLimit('5000000000.00000000')).toBe('5000000000');
    expect(formatLimit('0.00000001')).toBe('0.00000001');
  });
});
