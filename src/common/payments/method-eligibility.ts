import { FieldValidationError } from '../errors/domain-errors';
import { countryByCode, countryByName } from '../kyc/country-options';

/** A method's country rule (0178): offered only to (`allow`) or to all but (`deny`) these. */
export interface CountryRule {
  countryRule: 'allow' | 'deny' | null;
  countryCodes: readonly string[];
}

/**
 * May a client with this country of residence use this method? Pure — the one
 * rule the portal's lists AND both doors ask, so what a client is offered and
 * what they may submit can never disagree.
 *
 * The client's country is the NAME stored on the profile; it is matched by its
 * ISO code. A client with no country is refused by an allow-list (we cannot
 * show they qualify) and passed by a deny-list (nothing excludes them).
 */
export function countryEligible(
  rule: CountryRule,
  clientCountry: string | null | undefined,
): boolean {
  if (rule.countryRule === null || rule.countryCodes.length === 0) return true;
  const code = clientCountry ? countryByName(clientCountry)?.code : undefined;
  const listed = code !== undefined && rule.countryCodes.includes(code);
  return rule.countryRule === 'allow' ? listed : !listed;
}

/** The sentence a client is shown when a method is refused for their country. */
export const COUNTRY_REFUSAL = 'This method is not available in your country.';

/**
 * A rule as an admin sent it, checked and made canonical: codes upper-cased,
 * known, unique; a rule needs at least one country and no rule keeps none.
 * Returns undefined when the request touches neither field (an update leaves
 * the stored rule alone).
 */
export function normaliseCountryRule(
  rule: 'allow' | 'deny' | null | undefined,
  codes: readonly string[] | undefined,
): { countryRule: 'allow' | 'deny' | null; countryCodes: string[] } | undefined {
  if (rule === undefined && codes === undefined) return undefined;
  if (rule === null || rule === undefined) {
    if (rule === undefined && codes && codes.length > 0) {
      throw new FieldValidationError('Choose Allow only or Deny only for these countries.', {
        countryRule: 'Choose Allow only or Deny only for these countries.',
      });
    }
    return { countryRule: null, countryCodes: [] };
  }
  const wanted = (codes ?? []).map((code) => code.trim().toUpperCase());
  if (wanted.length === 0) {
    throw new FieldValidationError('Choose at least one country for this rule.', {
      countryCodes: 'Choose at least one country for this rule.',
    });
  }
  const unknown = wanted.filter((code) => !countryByCode(code));
  if (unknown.length > 0) {
    throw new FieldValidationError(`${unknown.join(', ')} is not a country we know.`, {
      countryCodes: `${unknown.join(', ')} is not a country we know.`,
    });
  }
  return { countryRule: rule, countryCodes: [...new Set(wanted)] };
}
