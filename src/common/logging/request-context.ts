import { AsyncLocalStorage } from 'async_hooks';
import { EMPTY_MASK, type FieldMask } from '../security/field-mask';
import type { Locale } from '../i18n/locale';

export interface RequestContext {
  requestId: string;
  method?: string;
  path?: string;
  /**
   * The caller's address, resolved once under the configured trust boundary.
   *
   * Carried here rather than passed down so that every audit row records where
   * an action came from without twenty call sites having to remember to thread
   * a `req` through. On a money system "who approved this withdrawal" is only
   * half an answer.
   */
  ip?: string;
  /**
   * The RBAC-03 mask of the admin this request authenticated as — set by
   * `AdminGuard`. Read by the one client search (`clientIdentitySearch`) and
   * by `sortKey`, so a hidden field cannot be learned by ASKING (a fragment
   * search, a sort) as well as not by reading. Absent outside an admin request.
   */
  fieldMask?: FieldMask;
  /** The portal's `X-OxShare-Locale` (`common/i18n/locale.ts`). Absent = English. */
  locale?: Locale;
  /**
   * Operator-authored labels this request has read, English → Arabic (3 Oct 2026) —
   * a broker's KYC question, a payment method's proof field. Registered by the
   * code that reads them (`registerLabelTwins`) so a sentence naming one
   * ("Favourite colour is required.") is translated with its Arabic label on the
   * way out. Absent until something registers one.
   */
  labelTwins?: Map<string, string>;
}

/**
 * The current request, available anywhere without threading it through every
 * signature.
 *
 * The correlation-ID middleware puts the id on the express request, but a log
 * line written five layers down in WalletService has no access to that object.
 * AsyncLocalStorage carries it across every await in the same request, so a
 * money-path log line can be traced back to the caller who triggered it.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** The caller's address for the request in flight, if there is one. */
export function currentClientIp(): string | undefined {
  return requestContext.getStore()?.ip;
}

/** The authenticated admin's field mask, or nothing hidden outside one. */
export function currentFieldMask(): FieldMask {
  return requestContext.getStore()?.fieldMask ?? EMPTY_MASK;
}
