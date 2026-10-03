import { requestContext } from '../logging/request-context';

/**
 * The client portal's languages (2 Oct 2026). The admin console is English
 * only and never sends a locale, so everything here is a no-op for it.
 */
export type Locale = 'en' | 'ar';

export const LOCALES: readonly Locale[] = ['en', 'ar'];

export const DEFAULT_LOCALE: Locale = 'en';

/**
 * The header the portal sends on every request. A header of our own, NOT
 * `Accept-Language`: a browser sends that on its own, so an operator whose
 * browser prefers Arabic would get Arabic errors in the English admin console.
 */
export const LOCALE_HEADER = 'x-oxshare-locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** A header value as a locale — anything unrecognised is English. */
export function parseLocale(value: unknown): Locale {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalised = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 2) : '';
  return isLocale(normalised) ? normalised : DEFAULT_LOCALE;
}

/**
 * The language of the request being served, set once by `RequestIdMiddleware`.
 * English outside a request (jobs, boot) — anything written there for a client
 * must use the client's stored `users.locale` instead.
 */
export function requestLocale(): Locale {
  return requestContext.getStore()?.locale ?? DEFAULT_LOCALE;
}

/**
 * Operator-authored text in a locale: the Arabic when asked for and written,
 * else the English. A blank Arabic is "not translated", never an empty label.
 */
export function pickLocalized(
  en: string,
  ar: string | null | undefined,
  locale: Locale = requestLocale(),
): string {
  return locale === 'ar' && typeof ar === 'string' && ar.trim() !== '' ? ar : en;
}
