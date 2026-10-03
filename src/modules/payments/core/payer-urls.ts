import type { ConfigService } from '@nestjs/config';
import { isPayerReachableUrl } from './payer-reachable-url';
import {
  PaymentProviderRegistry,
  providerWebhookUrl,
} from '../providers/payment-provider-registry';

/**
 * Where a provider that takes its callback per request (3pay) reports back —
 * the same address the console shows for it.
 */
export function providerCallbackUrl(
  providers: PaymentProviderRegistry,
  config: ConfigService,
  providerCode: string,
): string | undefined {
  const adapter = providers.find(providerCode);
  if (!adapter) return undefined;
  return providerWebhookUrl(config.get<string>('API_PUBLIC_URL'), adapter) ?? undefined;
}

/** Where the CLIENT's browser lands after paying. The portal, not the API. */
function redirectUrl(
  config: ConfigService,
  method: string,
  reference: string,
  outcome: 'success' | 'failure',
): string {
  const base = (config.get<string>('PORTAL_URL') ?? '').replace(/\/+$/, '');
  /*
   * `method` travels too, and its absence was a latent bug.
   *
   * The landing page settles by calling
   * `GET /payments/deposits/:reference/status?method=…`, and that query
   * matches on `transactions.provider` — so the method has to be right or the
   * lookup finds nothing. Only `reference` was sent, so the portal defaulted
   * to `whish` and documented itself as reading the method "from the query
   * when present". It was never present.
   *
   * With one gateway that was invisible. The day a second one is added, every
   * redirect from it would settle against `whish`, miss, and leave the client
   * on "not confirmed yet" for a payment that had gone through — while the
   * comment claimed the case was handled.
   */
  return (
    `${base}/deposit/${outcome}` +
    `?reference=${encodeURIComponent(reference)}&method=${encodeURIComponent(method)}`
  );
}

/**
 * The redirect URL the PROVIDER gets — the API's return bounce when the API
 * has a public address, the portal directly as a fallback, or nothing.
 *
 * Preference order, and why (tech lead's direction):
 *
 *  1. `API_PUBLIC_URL` + the `PaymentsReturnController` bounce. The provider
 *     only ever sees the API origin — which is public anyway, for webhooks —
 *     and the API 302s the payer on to wherever `PORTAL_URL` points, even a
 *     localhost portal in dev (the payer's browser IS the dev machine).
 *  2. The portal directly, when no `API_PUBLIC_URL` is set but the portal
 *     address is itself payer-reachable.
 *  3. Omitted. Rival refuses localhost/loopback redirect URLs at create time
 *     (its rule is measured against live Whish, which 403s them), so sending
 *     one would fail EVERY deposit. Omitted, Rival serves its own platform
 *     result pages; settlement never depended on the redirect (webhook +
 *     poll own it).
 */
export function payerRedirectUrl(
  config: ConfigService,
  method: string,
  reference: string,
  outcome: 'success' | 'failure',
): string | undefined {
  const apiBase = (config.get<string>('API_PUBLIC_URL') ?? '').replace(/\/+$/, '');
  if (apiBase) {
    const bounce =
      `${apiBase}/v1/payments/deposits/${encodeURIComponent(reference)}` +
      `/return/${outcome}?method=${encodeURIComponent(method)}`;
    if (isPayerReachableUrl(bounce)) return bounce;
  }
  const direct = redirectUrl(config, method, reference, outcome);
  return isPayerReachableUrl(direct) ? direct : undefined;
}
