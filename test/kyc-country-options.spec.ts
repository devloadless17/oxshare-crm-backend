import { describe, expect, it } from 'vitest';
import {
  countryLabelsAr,
  countryNameAr,
  KYC_COUNTRY_OPTIONS,
  KYC_NATIONALITY_OPTIONS,
  NATIONALITY_AR,
  nationalityLabelsAr,
  WORLD_COUNTRIES,
} from '../src/common/kyc/country-options';

/**
 * The KYC country and nationality lists, now served rather than hard-coded in
 * the portal.
 *
 * The exclusion below is the reason this file exists. The broker operates from
 * Lebanon, where trading with Israel is prohibited outright, and the constraint
 * travelled with the list when it moved to the server. The portal has the same
 * assertions over its own copy (`countries-data.test.ts`), which still feeds the
 * phone dial-code picker — losing it on either side would be a legal problem,
 * not a cosmetic one.
 */

describe('the offered countries', () => {
  it('excludes Israel', () => {
    expect(KYC_COUNTRY_OPTIONS).not.toContain('Israel');
  });

  it('excludes the matching demonym', () => {
    // A separate list with no code to match on, so it is filtered by name —
    // offering "Israeli" as a nationality two fields after removing Israel as a
    // country would be the same list disagreeing with itself.
    expect(KYC_NATIONALITY_OPTIONS).not.toContain('Israeli');
  });

  it('still offers a full world list', () => {
    // Guards against a filter or a package change quietly emptying it — an
    // empty list renders as a dropdown with no choices, which is exactly the
    // bug this work fixed.
    expect(KYC_COUNTRY_OPTIONS.length).toBeGreaterThan(200);
    expect(KYC_NATIONALITY_OPTIONS.length).toBeGreaterThan(150);
  });

  it('is sorted, because a 250-entry dropdown in any other order is unusable', () => {
    const sorted = [...KYC_COUNTRY_OPTIONS].sort((a, b) => a.localeCompare(b));
    expect(KYC_COUNTRY_OPTIONS).toEqual(sorted);
  });

  it('carries no duplicates', () => {
    expect(new Set(KYC_NATIONALITY_OPTIONS).size).toBe(KYC_NATIONALITY_OPTIONS.length);
  });
});

describe('the lists in Arabic (0179)', () => {
  it('has a hand-written Arabic for EVERY nationality offered, and no two alike', () => {
    const missing = KYC_NATIONALITY_OPTIONS.filter((n) => !NATIONALITY_AR[n]?.trim());
    expect(missing).toEqual([]);
    const arabic = KYC_NATIONALITY_OPTIONS.map((n) => NATIONALITY_AR[n]);
    expect(arabic.every((text) => /[؀-ۿ]/.test(text))).toBe(true);
    expect(new Set(arabic).size).toBe(arabic.length);
    expect(NATIONALITY_AR.Lebanese).toBe('لبناني');
    expect(NATIONALITY_AR.American).toBe('أمريكي');
    expect(NATIONALITY_AR.British).toBe('بريطاني');
    expect(NATIONALITY_AR.Emirati).toBe('إماراتي');
  });

  it('names EVERY country code in Arabic from the runtime', () => {
    const unnamed = WORLD_COUNTRIES.filter((c) => !countryNameAr(c.code));
    expect(unnamed).toEqual([]);
    expect(countryNameAr('LB')).toBe('لبنان');
  });

  it('serves each list keyed by its ENGLISH value, every entry covered', () => {
    const countries = countryLabelsAr(KYC_COUNTRY_OPTIONS);
    expect(Object.keys(countries).sort()).toEqual([...KYC_COUNTRY_OPTIONS].sort());
    expect(countries['United Arab Emirates']).toBe(countryNameAr('AE'));
    const nationalities = nationalityLabelsAr(KYC_NATIONALITY_OPTIONS);
    expect(Object.keys(nationalities)).toHaveLength(KYC_NATIONALITY_OPTIONS.length);
    expect(nationalityLabelsAr(['Lebanese', 'Martian'])).toEqual({ Lebanese: 'لبناني' });
  });
});
