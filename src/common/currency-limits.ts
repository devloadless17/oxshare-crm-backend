import Decimal from 'decimal.js';

/**
 * A currency's money limits, and the one rule for combining them with a deposit
 * method's own range (0162).
 *
 * ## Why per currency
 *
 * The limits were one set of numbers in server config for every currency, so a
 * client could not withdraw more than 50,000 LBP — about fifty cents — while the
 * same 50,000 was a large USD withdrawal. A limit is an amount OF a currency,
 * and with no FX source in this system (there must not be one just for this) it
 * can only be stated per currency, in that currency's units.
 *
 * ## Why a method can only NARROW
 *
 * One place states the rule (the currency) and one place may tighten it for a
 * channel with its own cap (a wallet app that moves at most so much). If a
 * method could also widen it, the currency's limit would stop being a limit, and
 * "what may a client deposit in LBP?" would have as many answers as methods.
 *
 * Pure, so every boundary is one assertion (`currency-limits.spec.ts`). Amounts
 * are decimal STRINGS in and out (§6.1) — never a JS number.
 */

export const CURRENCY_LIMIT_FIELDS = [
  'minDeposit',
  'maxDeposit',
  'minWithdrawal',
  'maxWithdrawal',
  'maxWithdrawalDaily',
  'maxAdminCredit',
] as const;
export type CurrencyLimitField = (typeof CURRENCY_LIMIT_FIELDS)[number];
export type CurrencyLimits = Record<CurrencyLimitField, string>;

/** What each limit is called in a sentence an operator reads. */
const LABEL: Record<CurrencyLimitField, string> = {
  minDeposit: 'minimum deposit',
  maxDeposit: 'maximum deposit',
  minWithdrawal: 'minimum withdrawal',
  maxWithdrawal: 'maximum withdrawal',
  maxWithdrawalDaily: 'daily withdrawal limit',
  maxAdminCredit: 'maximum admin credit',
};

/**
 * Everything wrong with a set of limits, keyed by field — empty when none.
 *
 * The same shape `currencies_money_limits_ck` enforces, said field by field so
 * the form can put each sentence under its own box.
 */
export function currencyLimitProblems(limits: CurrencyLimits): Record<string, string> {
  const problems: Record<string, string> = {};
  const value = (field: CurrencyLimitField) => new Decimal(limits[field]);
  for (const field of CURRENCY_LIMIT_FIELDS) {
    if (!value(field).greaterThan(0)) problems[field] = `The ${LABEL[field]} must be above zero.`;
  }
  const atLeast = (high: CurrencyLimitField, low: CurrencyLimitField) => {
    if (!problems[high] && !problems[low] && value(high).lessThan(value(low))) {
      problems[high] =
        `The ${LABEL[high]} cannot be below the ${LABEL[low]} (${formatLimit(limits[low])}).`;
    }
  };
  atLeast('maxDeposit', 'minDeposit');
  atLeast('maxWithdrawal', 'minWithdrawal');
  // A day that allows less than one withdrawal would refuse the maximum outright.
  atLeast('maxWithdrawalDaily', 'maxWithdrawal');
  return problems;
}

/** A deposit method's own optional range — NULL means "the currency's". */
export interface MethodRange {
  minAmount: string | null;
  maxAmount: string | null;
}

/**
 * The range a client is actually held to on a method: the TIGHTER of the
 * currency's deposit limits and the method's own. Computed, not trusted — a
 * currency whose limits moved after the method was saved still wins where it is
 * tighter, so an override can never turn into a widening.
 */
export function effectiveDepositRange(
  currency: Pick<CurrencyLimits, 'minDeposit' | 'maxDeposit'>,
  method: MethodRange,
): { min: string; max: string } {
  const min =
    method.minAmount !== null
      ? Decimal.max(currency.minDeposit, method.minAmount)
      : new Decimal(currency.minDeposit);
  const max =
    method.maxAmount !== null
      ? Decimal.min(currency.maxDeposit, method.maxAmount)
      : new Decimal(currency.maxDeposit);
  return { min: min.toFixed(8), max: max.toFixed(8) };
}

/**
 * Everything wrong with a method's range against its currency — empty when none.
 *
 * Refused at SAVE rather than silently clamped: an operator who typed a maximum
 * above the currency's has misunderstood what the field does, and saving it
 * would show a number on the admin screen that no client is ever held to.
 */
export function methodRangeProblems(
  currencyCode: string,
  currency: Pick<CurrencyLimits, 'minDeposit' | 'maxDeposit'>,
  method: MethodRange,
): Record<string, string> {
  const problems: Record<string, string> = {};
  const lo = new Decimal(currency.minDeposit);
  const hi = new Decimal(currency.maxDeposit);
  const range = `${formatLimit(lo)}–${formatLimit(hi)} ${currencyCode}`;
  if (method.minAmount !== null) {
    const min = new Decimal(method.minAmount);
    if (!min.greaterThan(0)) problems.minAmount = 'The minimum must be above zero.';
    else if (min.lessThan(lo) || min.greaterThan(hi)) {
      problems.minAmount = `It can only narrow the currency's deposit range, ${range}.`;
    }
  }
  if (method.maxAmount !== null) {
    const max = new Decimal(method.maxAmount);
    if (!max.greaterThan(0)) problems.maxAmount = 'The maximum must be above zero.';
    else if (max.lessThan(lo) || max.greaterThan(hi)) {
      problems.maxAmount = `It can only narrow the currency's deposit range, ${range}.`;
    }
  }
  if (
    !problems.minAmount &&
    !problems.maxAmount &&
    method.minAmount !== null &&
    method.maxAmount !== null &&
    new Decimal(method.maxAmount).lessThan(method.minAmount)
  ) {
    problems.maxAmount = 'The maximum cannot be below the minimum.';
  }
  return problems;
}

/**
 * A limit as a person reads it: the ledger's trailing zeros stripped, and never
 * exponent notation — `toString()` writes 0.00000001 as `1e-8`.
 */
export function formatLimit(value: string | Decimal): string {
  return new Decimal(value).toFixed();
}
