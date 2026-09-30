import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ValidationError } from '../../../common/errors/domain-errors';
import {
  PAYMENT_PROVIDER_ADAPTERS,
  type ChannelDirection,
  type PaymentChannel,
  type PaymentProviderAdapter,
  type PaymentRoute,
  type PaymentStatus,
  type PayoutRail,
  type StartedPayment,
  type StartPaymentInput,
} from './payment-provider';
import { providerState, type ProviderRowFacts, type ProviderState } from './provider-status';

/** A channel together with the provider that declares it — what a method may bind. */
export interface BindableChannel {
  provider: PaymentProviderAdapter;
  channel: PaymentChannel;
}

/**
 * EVERY PAYMENT PROVIDER THE BUILD KNOWS, AND EVERY QUESTION ABOUT A ROUTE (0168).
 *
 * The one place the platform asks "which provider, which channel, what can it
 * do". It replaces `PaymentGateways`, whose whole registry was
 * `key === 'whish'`: a method was a Rival method because of its key, and every
 * money path repeated that comparison. Now a method and a transaction carry
 * their route (`provider_code`, `channel_code`), and this answers from the
 * adapters' own declarations.
 *
 * A channel is identified by (provider, direction, code): Rival declares `whish`
 * twice — the hosted deposit and the payout — and they are different channels.
 * A transaction's direction says which: a deposit reads the provider's deposit
 * channel, a withdrawal its payout channel.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly providers = new Map<string, PaymentProviderAdapter>();

  constructor(
    @Inject(PAYMENT_PROVIDER_ADAPTERS) adapters: readonly PaymentProviderAdapter[],
    /** Absent only in unit specs, which run as a non-production deployment. */
    @Optional() private readonly config?: ConfigService,
  ) {
    for (const adapter of adapters) {
      if (this.providers.has(adapter.code)) {
        throw new Error(`Two payment providers are registered as "${adapter.code}".`);
      }
      assertWellDeclared(adapter);
      this.providers.set(adapter.code, adapter);
    }
  }

  /** Every provider, in registration order — the console's list. */
  list(): PaymentProviderAdapter[] {
    return [...this.providers.values()];
  }

  /** A provider the build knows, or undefined. */
  find(code: string): PaymentProviderAdapter | undefined {
    return this.providers.get(code);
  }

  /** A provider the build knows; a code it does not is a refusal naming it. */
  provider(code: string): PaymentProviderAdapter {
    const adapter = this.providers.get(code);
    if (!adapter) throw new ValidationError(`There is no payment provider "${code}".`);
    return adapter;
  }

  /** The channel a route names in one direction, or undefined. */
  findChannel(route: PaymentRoute, direction: ChannelDirection): PaymentChannel | undefined {
    return this.providers
      .get(route.providerCode)
      ?.channels.find(
        (channel) => channel.code === route.channelCode && channel.direction === direction,
      );
  }

  /** The channel a route names; a route no provider declares is a refusal. */
  channel(route: PaymentRoute, direction: ChannelDirection): PaymentChannel {
    const channel = this.findChannel(route, direction);
    if (!channel) {
      throw new ValidationError(
        `${this.provider(route.providerCode).name} has no ${direction} channel "${route.channelCode}".`,
      );
    }
    return channel;
  }

  /** Every channel a method of this direction may bind, across every provider. */
  bindableChannels(direction: ChannelDirection): BindableChannel[] {
    return this.list().flatMap((provider) =>
      provider.channels
        .filter((channel) => channel.direction === direction && channel.bindable)
        .map((channel) => ({ provider, channel })),
    );
  }

  /**
   * Refuse a method bound to a route it cannot use — at SAVE, where the admin
   * can fix it, not later when a client tries to pay (0168). The channel must
   * exist in this direction, be one a method may bind, carry the method's
   * currency, and take a receipt only if it is an offline deposit channel.
   */
  assertBindable(
    route: PaymentRoute,
    direction: ChannelDirection,
    options: { currency?: string; requiresProof?: boolean },
  ): PaymentChannel {
    const channel = this.channel(route, direction);
    if (!channel.bindable) {
      throw new ValidationError(`${channel.label} is the desk's own; no method can use it.`);
    }
    if (
      options.currency !== undefined &&
      channel.currencies !== 'any' &&
      !channel.currencies.includes(options.currency)
    ) {
      throw new ValidationError(
        `${this.provider(route.providerCode).name} · ${channel.label} does not carry ${options.currency}.`,
      );
    }
    if (options.requiresProof && !channel.acceptsReceipt) {
      throw new ValidationError(
        `${channel.label} is settled by ${this.provider(route.providerCode).name}; it takes no receipt.`,
      );
    }
    return channel;
  }

  /** Can the route's provider move money right now (on, configured, not sandbox in production)? */
  isUsable(providerCode: string): Promise<boolean> {
    const adapter = this.providers.get(providerCode);
    return adapter ? adapter.isUsable() : Promise.resolve(false);
  }

  /**
   * Every provider's state (`provider-status.ts`), from its configuration rows —
   * one read the provider page, the method lists and the method writes share.
   * A provider with no row reads as never saved.
   */
  async states(
    rows: readonly (ProviderRowFacts & { code: string })[],
  ): Promise<Map<string, ProviderState>> {
    const byCode = new Map(rows.map((row) => [row.code, row]));
    const production = this.config?.get<string>('NODE_ENV') === 'production';
    const entries = await Promise.all(
      this.list().map(
        async (adapter) =>
          [
            adapter.code,
            providerState({
              adapter,
              row: byCode.get(adapter.code) ?? null,
              usable: await adapter.isUsable(),
              production,
            }),
          ] as const,
      ),
    );
    return new Map(entries);
  }

  /**
   * Every route whose movements a PERSON decides: deposits the desk confirms
   * (paid outside the platform), and every payout, which the desk approves
   * before anybody — the provider included — pays it. As
   * `transactions.direction` spells the direction.
   */
  deskDecidedRoutes(): {
    direction: 'deposit' | 'withdrawal';
    providerCode: string;
    channelCode: string;
  }[] {
    return this.list().flatMap((provider) =>
      provider.channels
        .filter((c) => c.direction === 'payout' || c.flow === 'offline')
        .map((c) => ({
          direction: c.direction === 'payout' ? ('withdrawal' as const) : ('deposit' as const),
          providerCode: provider.code,
          channelCode: c.code,
        })),
    );
  }

  /** Does a deposit on this route go to the provider's hosted page? */
  isRedirect(route: PaymentRoute): boolean {
    return this.findChannel(route, 'deposit')?.flow === 'redirect';
  }

  /** Is this deposit one the desk confirms by hand (paid outside the platform)? */
  isDeskDecided(route: PaymentRoute): boolean {
    return this.findChannel(route, 'deposit')?.flow === 'offline';
  }

  /** Does the provider pay this payout once the desk approves it? */
  isAutomatedPayout(route: PaymentRoute): boolean {
    return this.findChannel(route, 'payout')?.flow === 'automated';
  }

  /**
   * The provider's payout operations for an AUTOMATED payout route, or
   * undefined for a route the desk pays. The boot guarantees every automated
   * channel has them (`assertWellDeclared`), so undefined never means "an
   * automated route nobody can submit".
   */
  payoutRail(
    route: PaymentRoute,
  ): { adapter: PaymentProviderAdapter; channel: PaymentChannel; rail: PayoutRail } | undefined {
    const adapter = this.providers.get(route.providerCode);
    const channel = this.findChannel(route, 'payout');
    if (!adapter || !channel || channel.flow !== 'automated' || !adapter.payouts) return undefined;
    return { adapter, channel, rail: adapter.payouts };
  }

  /** The decimal places the route's provider settles in, or null for the platform's own. */
  settlementScale(route: PaymentRoute, direction: ChannelDirection): number | null {
    return this.findChannel(route, direction)?.settlementScale ?? null;
  }

  /** Open a hosted payment on a `redirect` deposit route. */
  startPayment(route: PaymentRoute, input: StartPaymentInput): Promise<StartedPayment> {
    const { adapter, channel } = this.redirect(route);
    if (!adapter.startPayment) {
      throw new ValidationError(`${adapter.name} cannot open a hosted payment.`);
    }
    return adapter.startPayment(channel, input);
  }

  /** What the provider says a hosted payment is now. */
  checkPayment(route: PaymentRoute, externalId: string): Promise<PaymentStatus> {
    const { adapter, channel } = this.redirect(route);
    if (!adapter.checkPayment) {
      throw new ValidationError(`${adapter.name} cannot report on a hosted payment.`);
    }
    return adapter.checkPayment(channel, externalId);
  }

  /**
   * A hosted payment whose start never answered: found or re-made at the
   * provider, or null when it provably holds none. A provider that cannot
   * recover answers null — the start is then judged by age alone.
   */
  async recoverPayment(
    route: PaymentRoute,
    input: StartPaymentInput,
  ): Promise<StartedPayment | null> {
    const { adapter, channel } = this.redirect(route);
    return adapter.recoverPayment ? adapter.recoverPayment(channel, input) : null;
  }

  /** Ask the provider to re-check a payment upstream, where it can. */
  async refreshPayment(route: PaymentRoute, externalId: string): Promise<void> {
    const { adapter, channel } = this.redirect(route);
    if (adapter.refreshPayment) await adapter.refreshPayment(channel, externalId);
  }

  private redirect(route: PaymentRoute): {
    adapter: PaymentProviderAdapter;
    channel: PaymentChannel;
  } {
    const adapter = this.provider(route.providerCode);
    const channel = this.channel(route, 'deposit');
    if (channel.flow !== 'redirect') {
      throw new ValidationError(`${adapter.name} · ${channel.label} has no hosted payment page.`);
    }
    return { adapter, channel };
  }
}

/**
 * Where a provider delivers its events, as the provider must be told it — the
 * console shows it, and providers that take a callback per request (3pay) are
 * sent it. Null for the built-in desk, and when the API has no public address
 * (then no provider can reach it anyway).
 */
export function providerWebhookUrl(
  apiPublicUrl: string | undefined,
  adapter: Pick<PaymentProviderAdapter, 'builtIn' | 'code' | 'webhookPath'>,
): string | null {
  if (adapter.builtIn || !apiPublicUrl) return null;
  const path = adapter.webhookPath ?? `/v1/payments/providers/${adapter.code}/webhook`;
  return `${apiPublicUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * The namespace of `transactions.provider` — half of UNIQUE(provider,
 * provider_ref), the idempotency guard — for a new DEPOSIT row. Kept exactly as
 * it was before 0168 for the routes that existed (`whish` for Rival's Whish,
 * `manual_<method key>` for a deposit paid outside), so an older build and every
 * existing row agree; a new provider's rows read `<provider>_<channel>`. Nothing
 * routes on it any more: `provider_code`/`channel_code` do.
 */
export function depositNamespace(route: PaymentRoute, methodKey: string): string {
  if (route.providerCode === 'manual') return `manual_${methodKey}`;
  if (route.providerCode === 'rival' && route.channelCode === 'whish') return 'whish';
  return `${route.providerCode}_${route.channelCode}`;
}

/**
 * An adapter whose declarations the core cannot honour is refused at BOOT —
 * never discovered by a client's money. Two channels with one identity; a
 * payout with nowhere to send it; an AUTOMATED payout channel on a provider
 * with no payout operations (approval would mark it paid with nothing sent —
 * the failure the 0173 core exists to make impossible); a hosted deposit the
 * core cannot open or ask about; deposit-only declarations on anything else.
 */
export function assertWellDeclared(adapter: PaymentProviderAdapter): void {
  const seen = new Set<string>();
  for (const channel of adapter.channels) {
    const identity = `${channel.direction}:${channel.code}`;
    const named = `${adapter.code}'s ${channel.direction} channel ${channel.code}`;
    if (seen.has(identity)) {
      throw new Error(`${adapter.code} declares the ${identity} channel twice.`);
    }
    seen.add(identity);
    if (channel.direction === 'payout' && !channel.destination) {
      throw new Error(`${named} declares no destination.`);
    }
    if (channel.flow === 'automated' && !adapter.payouts) {
      throw new Error(`${named} is automated, but ${adapter.code} has no payout operations.`);
    }
    if (channel.flow === 'redirect' && (!adapter.startPayment || !adapter.checkPayment)) {
      throw new Error(`${named} is a hosted deposit ${adapter.code} cannot open or report on.`);
    }
    const hostedOnly =
      channel.creditPolicy !== undefined || channel.hostedPageReturns !== undefined;
    if (hostedOnly && channel.flow !== 'redirect') {
      throw new Error(`${named} declares hosted-deposit behaviour but is not a hosted deposit.`);
    }
    if (channel.asset && channel.currencies === 'any') {
      throw new Error(`${named} moves ${channel.asset.code} but names no wallet currency for it.`);
    }
  }
}
