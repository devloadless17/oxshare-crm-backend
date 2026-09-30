import type { PaymentProviderAdapter } from './payment-provider';

/**
 * WHAT STATE A PAYMENT PROVIDER IS IN, AND WHETHER A METHOD ON IT IS OFFERED (0168).
 *
 * Pure: the provider page, the method lists and the method writes all answer
 * these two questions, and they must answer them the same way.
 */

/** The configuration row, as far as these rules read it. */
export interface ProviderRowFacts {
  enabled: boolean;
  environment: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  lastEventAt: Date | null;
  lastCheckAt: Date | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
}

/**
 *   connected       — on, and it answered: a passing test, or events arriving since
 *   unverified      — on and set up, but nothing has proved it works yet
 *   failing         — its last connection test failed, and nothing has arrived since
 *   off             — set up, switched off
 *   not_configured  — a required setting is missing, or the saved ones cannot be used
 *   sandbox_refused — a sandbox configuration on a production deployment
 */
export type ProviderStatus =
  'connected' | 'unverified' | 'failing' | 'off' | 'not_configured' | 'sandbox_refused';

export interface ProviderState {
  status: ProviderStatus;
  /** Can its methods take money right now? What the client-facing lists ask. */
  usable: boolean;
  /** One sentence for the console, or null when the status says it all. */
  message: string | null;
}

/** The required settings a provider's row does not hold, by label. */
export function missingSettings(
  adapter: PaymentProviderAdapter,
  row: Pick<ProviderRowFacts, 'config' | 'secrets'> | null,
): string[] {
  return adapter.configFields
    .filter((field) => field.required)
    .filter((field) => {
      const held = field.kind === 'secret' ? row?.secrets[field.name] : row?.config[field.name];
      return !held;
    })
    .map((field) => field.label);
}

/**
 * `usable` is the adapter's own answer (`isUsable`), which can be true with no
 * row saved at all: Rival still runs from `RIVAL_*` environment variables in
 * development. The console says so rather than calling it not configured.
 */
export function providerState(input: {
  adapter: PaymentProviderAdapter;
  row: ProviderRowFacts | null;
  usable: boolean;
  production: boolean;
}): ProviderState {
  const { adapter, row, usable, production } = input;
  if (adapter.builtIn) return { status: 'connected', usable: true, message: null };

  if (row?.environment === 'sandbox' && production) {
    return {
      status: 'sandbox_refused',
      usable: false,
      message: 'A sandbox configuration is refused on a production deployment. Switch it to live.',
    };
  }

  if (!usable) {
    const missing = missingSettings(adapter, row);
    if (missing.length > 0) {
      return {
        status: 'not_configured',
        usable: false,
        message: `Missing: ${missing.join(', ')}.`,
      };
    }
    if (!row?.enabled) return { status: 'off', usable: false, message: null };
    return {
      status: 'not_configured',
      usable: false,
      message: 'The saved settings cannot be used. Enter the secrets again.',
    };
  }

  // A failed test is superseded by an event that arrived after it.
  const heardSince =
    row?.lastEventAt !== undefined &&
    row.lastEventAt !== null &&
    (row.lastCheckAt === null || row.lastEventAt > row.lastCheckAt);
  if (row?.lastCheckOk === false && !heardSince) {
    return { status: 'failing', usable: true, message: row.lastCheckMessage };
  }
  if (row?.lastCheckOk === true || heardSince) {
    return { status: 'connected', usable: true, message: null };
  }
  return {
    status: 'unverified',
    usable: true,
    message: 'Not tested yet. Test the connection to confirm it works.',
  };
}

/**
 * Whether clients are offered a method, and if not, why:
 *   offered                 — enabled, and its provider can take money
 *   disabled                — the desk switched the method off
 *   provider_off            — its provider is switched off
 *   provider_not_configured — its provider is not set up (or cannot be used)
 */
export type MethodAvailability =
  | 'offered'
  | 'disabled'
  | 'provider_off'
  | 'provider_not_configured'
  /** Its provider's network is switched off in this direction (0173). */
  | 'channel_off';

export const METHOD_AVAILABILITIES: readonly MethodAvailability[] = [
  'offered',
  'disabled',
  'provider_off',
  'provider_not_configured',
  'channel_off',
];

/**
 * Whether clients actually see a method, and if not, why — the method's own
 * switch first, then its channel's (0173), then its provider's.
 */
export function methodAvailability(
  methodEnabled: boolean,
  provider: ProviderState | undefined,
  channelOn = true,
): MethodAvailability {
  if (!methodEnabled) return 'disabled';
  if (!channelOn) return 'channel_off';
  if (!provider) return 'provider_not_configured';
  if (provider.usable) return 'offered';
  return provider.status === 'off' ? 'provider_off' : 'provider_not_configured';
}

/**
 * A PAYOUT method's availability and who pays it (0168; 0173 adds switches and
 * `wait` providers). Before 0173 a payout method was offered whenever it was
 * enabled, because the desk paid an automated one by hand while its provider
 * could not. That still holds for a provider declaring `whenUnavailable:
 * 'desk'` (Rival); one declaring `wait` (3pay) is hidden while it cannot pay,
 * and a switched-off network hides its methods either way.
 *
 * `automated` is the channel's provider's `whenUnavailable`, or null for a
 * route the desk always pays.
 */
export function payoutMethodStatus(
  methodEnabled: boolean,
  automated: 'desk' | 'wait' | null,
  provider: ProviderState | undefined,
  channelOn = true,
): { availability: MethodAvailability; paidBy: 'provider' | 'desk' } {
  const providerPays = automated !== null && (provider?.usable ?? false);
  const paidBy = providerPays || automated === 'wait' ? 'provider' : 'desk';
  if (!methodEnabled) return { availability: 'disabled', paidBy };
  if (!channelOn) return { availability: 'channel_off', paidBy };
  if (automated === 'wait' && !providerPays) {
    return { availability: methodAvailability(true, provider), paidBy };
  }
  return { availability: 'offered', paidBy };
}
