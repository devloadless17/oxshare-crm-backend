/**
 * THE CONTRACT EVERY PAYMENT PROVIDER FULFILS (0168).
 *
 * Three layers, and every money path reads them rather than a hardcoded name:
 *
 *   PROVIDER — a system that moves money: `manual` (built in: the desk), `rival`,
 *              and every provider after it. One adapter implementing this file.
 *   CHANNEL  — one way that provider moves money, DECLARED here, never typed by
 *              an operator: its direction, how it flows, what a payout needs.
 *   METHOD   — what a client picks (`payment_methods`, `withdrawal_payment_methods`),
 *              bound to exactly one (provider, channel), fixed at creation.
 *
 * Channels are namespaced by their provider, so Rival's USDT and another
 * provider's USDT are two channels that coexist, and every transaction records
 * which one it was filed on.
 *
 * Adding a provider is one adapter: its channels, its settings fields (the
 * console renders them without a new screen), its calls. Nothing outside the
 * adapter names it. The adapter contract suite
 * (`test/payment-provider-contract.spec.ts`) is what every adapter must pass;
 * the backend CLAUDE.md lists the rest ("Adding a provider").
 *
 * No Nest, no Drizzle here: this is the vocabulary the registry, the services and
 * the specs share.
 */

export type ChannelDirection = 'deposit' | 'payout';

/**
 * How money moves on a channel.
 *
 * Deposits:
 *   `redirect`   — the client pays on the provider's hosted page; the provider
 *                  settles it (webhook / poll). Nobody approves it by hand.
 *   `offline`    — the client pays outside the platform (OMT, a bank, cash) and
 *                  the desk confirms it, with a receipt when the method asks.
 *   `adjustment` — the desk's own credit; never a method a client picks.
 * Payouts:
 *   `automated`  — the provider pays once the desk approves.
 *   `desk`       — the desk pays, to the destination the client gave.
 *   `cash`       — the client collects in person.
 */
export type ChannelFlow = 'redirect' | 'offline' | 'adjustment' | 'automated' | 'desk' | 'cash';

/** What a payout needs from the client — the portal renders exactly this field. */
export type DestinationKind = 'none' | 'phone' | 'crypto_address' | 'iban' | 'text';

export interface ChannelDestination {
  kind: DestinationKind;
  /** A crypto channel's network (`TRC20`, `ERC20`): an address is only valid on one. */
  network?: string;
  /** What the value is, in the console's words ("Whish phone number"). */
  label: string;
  /**
   * The problem with a destination, or undefined when it can be paid. The
   * provider's own rules — Whish's phone rule lives in Rival's channel, never
   * at a door that names a method key.
   */
  validate?(value: string): string | undefined;
}

export interface PaymentChannel {
  /** Unique within its provider: `whish`, `offline`, `desk`, `cash`. */
  code: string;
  direction: ChannelDirection;
  /** The console's name for it ("Whish", "Paid outside the platform"). */
  label: string;
  flow: ChannelFlow;
  /**
   * The decimal places the provider settles in (Rival: 2), or null when the
   * platform's own precision applies. An amount finer than this is refused at
   * the door, never rounded by somebody else.
   */
  settlementScale: number | null;
  /** The currencies it can carry, or `any` when the provider judges that itself. */
  currencies: readonly string[] | 'any';
  /** May a method bind it? False for the desk's own `adjustment`. */
  bindable: boolean;
  /** Payouts: what the client must give. Absent on deposits. */
  destination?: ChannelDestination;
  /** Deposits on an `offline` channel may ask for a receipt (a method option). */
  acceptsReceipt?: boolean;
}

/** One setting a provider needs, rendered by the console without a screen of its own. */
export interface ProviderConfigField {
  name: string;
  label: string;
  kind: 'url' | 'text' | 'secret';
  required: boolean;
  hint?: string;
  /** Minted by the platform (a webhook key), never typed — rotated, not edited. */
  generated?: boolean;
}

/** The two things every route is: which provider, which of its channels. */
export interface PaymentRoute {
  providerCode: string;
  channelCode: string;
}

/** A hosted-page payment the provider started. */
export interface StartedPayment {
  paymentUrl: string;
  /** The provider's own id for it — what webhooks and polls name. */
  externalId: string;
}

/** What the provider says a payment is now. */
export interface PaymentStatus {
  settled: boolean;
  paid: boolean;
  rawStatus: string;
  needsAttention: boolean;
  amount?: string;
  currency?: string;
}

export interface StartPaymentInput {
  amount: string;
  currency: string;
  invoice: string;
  idempotencyKey: string;
  successRedirectUrl?: string;
  failureRedirectUrl?: string;
}

export interface ConnectionCheck {
  ok: boolean;
  message: string;
}

/**
 * One payment provider. `manual` and `rival` today; each future provider is one
 * more implementation, registered in `PaymentsModule`.
 */
export interface PaymentProviderAdapter {
  readonly code: string;
  /** Its name as the console shows it ("Rival", "Manual"). */
  readonly name: string;
  /** Built into the platform: always on, no settings, cannot be switched off. */
  readonly builtIn: boolean;
  readonly channels: readonly PaymentChannel[];
  readonly configFields: readonly ProviderConfigField[];
  /**
   * Where the provider delivers its events, under `/v1`, when it sends any.
   * New providers use the generic `payments/providers/<code>/webhook`; Rival
   * keeps the address its dashboard already holds.
   */
  readonly webhookPath?: string;

  /**
   * Can it move money on this deployment right now: switched on, its required
   * settings present, and not a sandbox configuration on a production
   * deployment. A method on a provider that is not usable is not offered.
   */
  isUsable(): Promise<boolean>;

  /** Ask the provider whether the saved settings work. Absent on built-in providers. */
  testConnection?(): Promise<ConnectionCheck>;

  /** Its configuration row changed: drop anything cached from the old one. */
  settingsChanged?(): void;

  /** `redirect` deposit channels: open the hosted payment. */
  startPayment?(channel: PaymentChannel, input: StartPaymentInput): Promise<StartedPayment>;

  /** `redirect` deposit channels: what the provider says the payment is now. */
  checkPayment?(channel: PaymentChannel, externalId: string): Promise<PaymentStatus>;
}

/** The injection token every adapter is registered under (`PaymentsModule`). */
export const PAYMENT_PROVIDER_ADAPTERS = Symbol('PAYMENT_PROVIDER_ADAPTERS');

/** What a webhook receiver answers — the status is a signal to the provider's retries. */
export interface WebhookAnswer {
  status: number;
  body: unknown;
}

/**
 * A provider's inbound events: verification, replay protection and applying
 * them. Registered apart from the adapter because it needs the money services,
 * which themselves need the registry — one list, dispatched by provider code
 * from `POST /v1/payments/providers/:code/webhook`.
 */
export interface ProviderWebhookReceiver {
  readonly providerCode: string;
  receive(
    rawBody: Buffer | undefined,
    header: (name: string) => string | undefined,
  ): Promise<WebhookAnswer>;
}

/** The injection token every webhook receiver is registered under (`PaymentsModule`). */
export const PAYMENT_PROVIDER_WEBHOOKS = Symbol('PAYMENT_PROVIDER_WEBHOOKS');
