import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  method?: string;
  path?: string;
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
