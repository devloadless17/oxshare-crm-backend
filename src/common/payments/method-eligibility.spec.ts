import { describe, expect, it } from 'vitest';
import { countryEligible, normaliseCountryRule } from './method-eligibility';
import {
  KYC_NATIONALITY_OPTIONS,
  NATIONALITY_COUNTRIES,
  WORLD_COUNTRIES,
  countryByCode,
  countryByName,
  offeredLists,
} from '../kyc/country-options';

describe('one list of countries drives both dropdowns (0178)', () => {
  it('maps every nationality to countries the platform knows', () => {
    expect(Object.keys(NATIONALITY_COUNTRIES).sort()).toEqual([...KYC_NATIONALITY_OPTIONS].sort());
    for (const codes of Object.values(NATIONALITY_COUNTRIES)) {
      for (const code of codes) expect(countryByCode(code), code).toBeDefined();
    }
  });

  it('offers a nationality exactly when its country is offered', () => {
    const lists = offeredLists(['LB', 'CD']);
    expect(lists.countries).toEqual(['Democratic Republic of the Congo', 'Lebanon']);
    expect(lists.nationalities).toEqual(['Congolese', 'Lebanese']);
    expect(offeredLists(null).countries).toHaveLength(WORLD_COUNTRIES.length);
  });

  it('finds a country however it is typed', () => {
    expect(countryByName('  lebanon ')?.code).toBe('LB');
    expect(countryByName('Egpyt')).toBeUndefined();
  });
});

describe('a method’s country rule', () => {
  const allowEg = { countryRule: 'allow' as const, countryCodes: ['EG'] };
  const denyEg = { countryRule: 'deny' as const, countryCodes: ['EG'] };
  it('allow-only admits listed countries and nobody unknown', () => {
    expect(countryEligible(allowEg, 'Egypt')).toBe(true);
    expect(countryEligible(allowEg, 'Lebanon')).toBe(false);
    expect(countryEligible(allowEg, null)).toBe(false);
  });
  it('deny-only refuses listed countries and admits the rest', () => {
    expect(countryEligible(denyEg, 'Egypt')).toBe(false);
    expect(countryEligible(denyEg, 'Lebanon')).toBe(true);
    expect(countryEligible(denyEg, null)).toBe(true);
  });
  it('no rule admits everyone', () => {
    expect(countryEligible({ countryRule: null, countryCodes: [] }, 'Egypt')).toBe(true);
  });
  it('refuses a rule with no country, an unknown code, and countries without a rule', () => {
    expect(() => normaliseCountryRule('allow', [])).toThrow(/at least one/);
    expect(() => normaliseCountryRule('deny', ['XX'])).toThrow(/not a country/);
    expect(() => normaliseCountryRule(undefined, ['EG'])).toThrow(/Allow only or Deny only/);
    expect(normaliseCountryRule('deny', ['eg', 'EG'])).toEqual({
      countryRule: 'deny',
      countryCodes: ['EG'],
    });
    expect(normaliseCountryRule(null, undefined)).toEqual({ countryRule: null, countryCodes: [] });
    expect(normaliseCountryRule(undefined, undefined)).toBeUndefined();
  });
});
