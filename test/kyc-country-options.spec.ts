import { describe, expect, it } from 'vitest';
import { KYC_COUNTRY_OPTIONS, KYC_NATIONALITY_OPTIONS } from '../src/common/kyc/country-options';

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
