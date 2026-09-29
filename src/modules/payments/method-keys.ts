import { randomBytes } from 'node:crypto';
import { ValidationError } from '../../common/errors/domain-errors';

/**
 * The rules a payment or withdrawal method's KEY and LABEL share, in one place.
 *
 * ## The key is a permanent ID nobody types
 *
 * It is the primary key every transaction references, it is spelled into
 * `transactions.provider` — `manual_<key>` for a manual deposit, the bare key
 * for a gateway deposit and for a withdrawal — where it is half of the
 * UNIQUE(provider, provider_ref) idempotency guard, and code dispatches on it
 * (`whish`: the gateway, the Rival payouts, the portal's payout field). Migration
 * 0161 records why renaming it was built, measured and rejected.
 *
 * So the console no longer shows it, and a new method gets a GENERATED one —
 * opaque on purpose (`pm_…`, `wm_…`): an ID that reads like a name invites
 * somebody to want to rename it, which is how this began. What the desk sees,
 * types and renames is `internal_label`, joined at read time.
 *
 * ## A key must not borrow a provider the platform already uses
 *
 * The desk's own money is `provider = 'manual_admin'`, and both frontends read
 * that value as "credited by an administrator". A deposit method keyed `admin`
 * would file its deposits under the same provider: indistinguishable from desk
 * credits on every screen, and sharing their idempotency namespace. So the key
 * of a deposit method may not produce a reserved provider, and a withdrawal
 * method (whose provider IS its key) may not enter the `manual_` namespace that
 * deposits and the desk occupy.
 */
export const METHOD_KEY_PATTERN = /^[a-z0-9_]+$/i;
export const METHOD_KEY_MESSAGE = 'key may contain only letters, digits and underscores';

/** Providers the platform writes itself, never on behalf of a method. */
const SYSTEM_PROVIDERS: ReadonlySet<string> = new Set(['manual_admin']);

/** Keys are stored lower-case and trimmed, so 'Whish' and 'whish' are one method. */
export function normaliseMethodKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * A new method's permanent ID: `pm_` (deposit) or `wm_` (withdrawal) and ten
 * random base-36 characters — 36^10 ≈ 3.7e15, so a collision is a lottery win,
 * and the primary key refuses one anyway.
 */
export function generateMethodKey(prefix: 'pm' | 'wm'): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let id = '';
  while (id.length < 10) {
    for (const byte of randomBytes(16)) {
      // 252 = 7 × 36: dropping 252–255 keeps every character equally likely.
      if (byte < 252 && id.length < 10) id += alphabet[byte % 36];
    }
  }
  return `${prefix}_${id}`;
}

/** The provider a MANUAL deposit through this method is filed under. */
export function manualDepositProvider(key: string): string {
  return `manual_${key}`;
}

/** Refuses a deposit key whose deposits would be filed under a platform provider. */
export function assertDepositMethodKeyAllowed(key: string): void {
  if (SYSTEM_PROVIDERS.has(manualDepositProvider(key))) {
    throw new ValidationError(
      `The key ${key} is reserved: the platform files its own manual credits under it.`,
    );
  }
}

/** Refuses a withdrawal key (filed as its own provider) in a namespace the platform uses. */
export function assertWithdrawalMethodKeyAllowed(key: string): void {
  if (key.startsWith('manual_') || SYSTEM_PROVIDERS.has(key)) {
    throw new ValidationError(
      `The key ${key} is reserved: keys starting with manual_ name deposits and the desk's own credits.`,
    );
  }
}

/**
 * The desk's name for a method, as stored: trimmed, and never blank — it is how
 * a person tells two methods apart on a transaction list, so a method without
 * one would be a row nobody can identify.
 */
export function requireInternalLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new ValidationError('The internal name cannot be empty.');
  return trimmed;
}

/** A Postgres foreign-key refusal, however the driver wrapped it. */
export function isForeignKeyViolation(error: unknown): boolean {
  const wrapped = error as { code?: string; cause?: { code?: string } } | null;
  return (wrapped?.cause?.code ?? wrapped?.code) === '23503';
}
