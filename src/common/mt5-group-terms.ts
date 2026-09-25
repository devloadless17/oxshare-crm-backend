/**
 * A group's own trading terms as the bridge reports them: MT5's commission
 * rules and the margin-call / stop-out levels.
 *
 * ## Why this is checked on the way in
 *
 * The rules are stored as JSON in `mt5_groups.commissions` and rendered on the
 * MT5 groups screen. The bridge is ours, but its answer still crosses a network
 * and a version boundary, so only the known fields are kept, each coerced to
 * the type the screen expects. A malformed rule is dropped rather than failing
 * the sync: one odd rule must not stop every other group from being recorded.
 *
 * ## Null is "not reported", never "none"
 *
 * A bridge that predates these fields sends nothing, and `commissionsFrom`
 * returns null so the sync leaves the stored value alone. A group that charges
 * nothing is an EMPTY array.
 */
export interface Mt5GroupCommissionTier {
  mode: string;
  type: string;
  value: string;
  currency: string | null;
  minimal: string | null;
  maximal: string | null;
  rangeFrom: string | null;
  rangeTo: string | null;
}

export interface Mt5GroupCommission {
  name: string;
  description: string;
  symbolPath: string;
  mode: string;
  rangeMode: string;
  chargeMode: string;
  entryMode: string;
  tiers: Mt5GroupCommissionTier[];
}

const DECIMAL = /^-?\d{1,20}(\.\d{1,8})?$/;
const WORD = /^[a-z_]{1,32}$/;

/** A decimal string the NUMERIC(28,8) columns accept, or null. */
export function amountFrom(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return amountFrom(String(raw));
  return typeof raw === 'string' && DECIMAL.test(raw) ? raw : null;
}

function text(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.slice(0, max) : '';
}

/** One of the bridge's lower-case words, or "unknown" for anything else. */
function word(raw: unknown): string {
  return typeof raw === 'string' && WORD.test(raw) ? raw : 'unknown';
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function tierFrom(raw: unknown): Mt5GroupCommissionTier | null {
  if (!isRecord(raw)) return null;
  const value = amountFrom(raw.value);
  if (value === null) return null;
  const currency = text(raw.currency, 10).trim();
  return {
    mode: word(raw.mode),
    type: word(raw.type),
    value,
    currency: currency === '' ? null : currency,
    minimal: amountFrom(raw.minimal),
    maximal: amountFrom(raw.maximal),
    rangeFrom: amountFrom(raw.rangeFrom),
    rangeTo: amountFrom(raw.rangeTo),
  };
}

function ruleFrom(raw: unknown): Mt5GroupCommission | null {
  if (!isRecord(raw) || !Array.isArray(raw.tiers)) return null;
  return {
    name: text(raw.name, 128),
    description: text(raw.description, 256),
    symbolPath: text(raw.symbolPath, 256),
    mode: word(raw.mode),
    rangeMode: word(raw.rangeMode),
    chargeMode: word(raw.chargeMode),
    entryMode: word(raw.entryMode),
    tiers: raw.tiers.map(tierFrom).filter((tier) => tier !== null),
  };
}

/** The group's rules, or null when the bridge did not report them. */
export function commissionsFrom(raw: unknown): Mt5GroupCommission[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map(ruleFrom).filter((rule) => rule !== null);
}

/** "percent" or "money", or null when not reported. */
export function stopOutModeFrom(raw: unknown): 'percent' | 'money' | null {
  return raw === 'percent' || raw === 'money' ? raw : null;
}
