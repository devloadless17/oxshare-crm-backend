import { ExternalServiceError } from '../../../common/errors/domain-errors';
import type { ProviderEventType } from '../../../store/payment-provider-events.store';

/**
 * THE CONTRACT EVERY PAYMENT PROVIDER FULFILS (0168; the core's half, 0173).
 *
 * Three layers, and every money path reads them rather than a hardcoded name:
 *
 *   PROVIDER — a system that moves money: `manual` (built in: the desk), `rival`,
 *              `threepay`, and every provider after it. One adapter implementing
 *              this file, in its own folder `providers/<code>/`.
 *   CHANNEL  — one way that provider moves money, DECLARED here, never typed by
 *              an operator: its direction, how it flows, what a payout needs.
 *   METHOD   — what a client picks (`payment_methods`, `withdrawal_payment_methods`),
 *              bound to exactly one (provider, channel), fixed at creation.
 *
 * ## Adapters TRANSLATE; the core DECIDES
 *
 * An adapter talks to ONE provider: its HTTP calls, its auth, its signature
 * scheme, its status words. It never touches money, the database or another
 * provider — lint refuses those imports (`eslint.config.mjs`, "provider
 * boundaries"). Everything that decides — the state machine, the ledger, the
 * claim before a payout, holding an unknown outcome, adopting a payout whose
 * answer was lost, crediting a deposit, asking a person — lives once, in
 * `modules/payments/core/`, and asks the adapter only questions this file
 * defines.
 *
 * ## A provider's differences are DECLARED, never special-cased
 *
 * The core never asks "is this Rival?". Every way providers differ is a
 * declaration here — whether a payout can be retried with a key, found by our
 * reference or only by what was asked; whether a deposit credits the exact link
 * amount or what arrived; what moves at the provider (USDT at par) against what
 * the wallet holds (USD); what a payout needs, how fast the provider accepts
 * them, whether a sent one can be recalled. A genuinely new KIND of money
 * movement is a core feature added once, not an `if` on a provider's name.
 *
 * Adding a provider is one adapter plus its webhook receiver, registered in
 * `PaymentsModule`; the backend CLAUDE.md lists the rest ("Adding a
 * provider"). `test/payment-provider-contract.spec.ts` is what every adapter
 * must pass.
 *
 * No Nest, no Drizzle here: this is the vocabulary the registry, the core and
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
 *   `automated`  — the provider pays once the desk approves (`payouts` below).
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
  /**
   * The destination in the one spelling that compares equal to the provider's
   * echo of it (an EVM address is case-insensitive; a Tron address is not).
   * Absent means "as typed, trimmed".
   */
  normalize?(value: string): string;
}

/**
 * What moves AT THE PROVIDER when it is not the wallet's own currency — 3pay
 * moves USDT on a network while the client's USD wallet moves at PAR (the
 * owner, 30 Sep 2026: 1 USDT = 1 USD, no rate, no spread). Absent means the
 * provider moves the wallet currency itself (Rival).
 */
export interface ChannelAsset {
  /** The provider's own word for it (`USDT-TRC20`) — compared with every report. */
  code: string;
  /** How a person reads it ("USDT on Tron (TRC20)"). */
  label: string;
}

/**
 * What a hosted deposit credits (0173).
 *
 *   `exact`    — the amount the link was created for. A report of any other
 *                figure is a person's decision; nothing is credited (Rival:
 *                a Whish link is fixed-amount, so a difference is an anomaly).
 *   `received` — what the provider confirms ARRIVED, rounded DOWN to the wallet
 *                currency's places: less, more, or after the link expired
 *                (3pay; the tech lead's call, 30 Sep 2026 — the payer chooses
 *                the figure on a crypto transfer, and the money is real).
 */
export type DepositCreditPolicy = 'exact' | 'received';

export interface PaymentChannel {
  /** Unique within its provider and direction: `whish`, `offline`, `usdt_trc20`. */
  code: string;
  direction: ChannelDirection;
  /** The console's name for it ("Whish", "USDT (TRC20)"). */
  label: string;
  flow: ChannelFlow;
  /**
   * The decimal places the provider settles in (Rival, 3pay: 2), or null when
   * the platform's own precision applies. An amount finer than this is refused
   * at the door, never rounded by somebody else.
   */
  settlementScale: number | null;
  /**
   * The WALLET currencies it serves, or `any` when the provider judges that
   * itself. A method's currency must be one of these (checked when it is
   * saved), and so must a withdrawal's (checked at the door).
   */
  currencies: readonly string[] | 'any';
  /** What moves at the provider when it is not the wallet currency (at par). */
  asset?: ChannelAsset;
  /**
   * The smallest amount the provider takes on this channel, in the wallet
   * currency (at par for an `asset`), when it has one — 3pay: 1 (guide §04,
   * §05). A method's minimum is never below it: the effective minimum clients
   * are held to is the higher of the two, and the doors refuse less.
   */
  minimumAmount?: string;
  /** May a method bind it? False for the desk's own `adjustment`. */
  bindable: boolean;
  /** Payouts: what the client must give. Absent on deposits. */
  destination?: ChannelDestination;
  /** Deposits on an `offline` channel may ask for a receipt (a method option). */
  acceptsReceipt?: boolean;
  /** `redirect` deposits: what is credited. Absent means `exact`. */
  creditPolicy?: DepositCreditPolicy;
  /**
   * `redirect` deposits: does the provider send the payer back to us after
   * paying? False (3pay takes no return URL) makes the portal keep the client
   * on a live waiting card and open the checkout in a new tab.
   */
  hostedPageReturns?: boolean;
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
  /**
   * The problem with a value, or undefined — checked when the settings are
   * SAVED (a payout fee that is not a decimal is refused there, not at the
   * first payout).
   */
  validate?(value: string): string | undefined;
}

/** The two things every route is: which provider, which of its channels. */
export interface PaymentRoute {
  providerCode: string;
  channelCode: string;
}

/* ── Hosted deposits ─────────────────────────────────────────────────────── */

/** A hosted-page payment the provider started. */
export interface StartedPayment {
  paymentUrl: string;
  /** The provider's own id for it — what webhooks and polls name. */
  externalId: string;
  /** When the page stops accepting money, when the provider says. */
  expiresAt?: Date;
}

/** What the provider says a payment is now. */
export interface PaymentStatus {
  /** Final at the provider: paid, or it never will be. */
  settled: boolean;
  paid: boolean;
  /**
   * Final and unpaid because the LINK EXPIRED. A `received` channel's provider
   * may still confirm a late payment, which the core then credits.
   */
  expired?: boolean;
  rawStatus: string;
  needsAttention: boolean;
  /** `exact`: the link's figure; `received`: what arrived. */
  amount?: string;
  /** The currency — or, on a channel with an `asset`, the asset — it was reported in. */
  currency?: string;
  /** What the provider kept and what reached the company's balance, when reported. */
  fee?: string;
  net?: string;
}

export interface StartPaymentInput {
  amount: string;
  currency: string;
  invoice: string;
  /** Our reference (`OX-…`) — what the provider echoes, and its replay key where it has one. */
  idempotencyKey: string;
  successRedirectUrl?: string;
  failureRedirectUrl?: string;
  /** Where the provider reports back, for providers that take it per request. */
  callbackUrl?: string;
}

export interface ConnectionCheck {
  ok: boolean;
  message: string;
}

/**
 * The provider is at its REQUEST LIMIT — a 429, or the adapter's own pacing
 * (3pay allows 60 reads a minute) — and NOTHING WAS SENT (0174). A sweep stops
 * its pass and resumes on the next run instead of failing row after row; a
 * payout is requeued; a single call a person or client made reports it.
 */
export class ProviderBusyError extends ExternalServiceError {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/**
 * One movement in the provider's own records, as the unmatched-records audit
 * reads it (0174).
 */
export interface ProviderRecord {
  subject: 'payment' | 'payout';
  /** The id a transaction here would hold (`provider_payment_id` / `provider_payout_id`). */
  providerId: string;
  /**
   * Did money move — a confirmed deposit, a payout not refused? Only those must
   * be explained; an unpaid link nobody used explains itself.
   */
  moved: boolean;
  rawStatus: string;
  amount?: string;
  /**
   * A deposit's NET — what reached the provider balance after its fee — when
   * reported; the provider-balance books add it (0175).
   */
  net?: string;
  /**
   * When it moved the provider's balance, where that differs from
   * `occurredAt` (a deposit created at one time and confirmed at another).
   */
  movedAt?: Date;
  /** The asset it moved in (`USDT-TRC20`). */
  asset?: string;
  /** The other side — the address paid or paid from — when reported. */
  counterparty?: string;
  /** Our reference, when the provider echoes one. */
  reference?: string;
  occurredAt: Date;
}

/** A window of the provider's records; incomplete when it could not all be read. */
export type ProviderRecordPage =
  { complete: true; records: readonly ProviderRecord[] } | { complete: false; reason: string };

/** What a provider holds for the company right now, in the asset it moves. */
export interface ProviderBalance {
  /** Withdrawable now (3pay's `totalAmt`). */
  available: string;
  /** Locked in payouts under way (3pay's `pendingAmt`), when reported. */
  inFlight?: string;
  /** The asset it is counted in ("USDT"). */
  asset: string;
}

/* ── Automated payouts ───────────────────────────────────────────────────── */

/**
 * How a payout whose ANSWER WAS LOST is found again — the one question that
 * decides whether a provider's payouts can ever be paid twice.
 *
 *   `key`       — the provider takes an idempotency key: the same request
 *                 again converges on one payout. (None of today's.)
 *   `reference` — the provider stores a reference of ours and returns it
 *                 (Rival: `notes: crm:<txId>`), so a lost one is found by it.
 *   `none`      — neither (3pay). Found only by WHAT WAS ASKED; the core's
 *                 fingerprint lock allows one unresolved payout per
 *                 (channel, destination, amount), so the match is unique.
 */
export type PayoutIdempotency = 'key' | 'reference' | 'none';

/** What a payout will cost the company, and what the client will receive. */
export interface PayoutQuote {
  /** What the provider is asked to move. */
  gross: string;
  /** The provider's fee, when it is known in advance; null when it is not. */
  fee: string | null;
  /** What should arrive at the destination — the client's amount. */
  net: string;
}

export interface PayoutRequest {
  /** Ours — the reference a `reference` provider stores. */
  transactionId: string;
  /** What to ask the provider to move (`PayoutQuote.gross`). */
  amount: string;
  /** What the client asked for (`PayoutQuote.net`). */
  clientAmount: string;
  currency: string;
  destination: string;
  recipientName: string;
  /** Where the provider reports back, for providers that take it per request. */
  callbackUrl?: string;
}

/** A provider's word on one payout, normalized. */
export interface PayoutReport {
  payoutId: string;
  /** `rejected`/`cancelled`/`failed` all mean "the money did not leave". */
  status: 'pending' | 'completed' | 'rejected' | 'cancelled' | 'failed';
  rawStatus: string;
  /** Moved, taken and delivered, when reported. */
  gross?: string;
  fee?: string;
  net?: string;
  /** The destination as the provider echoes it. */
  destination?: string;
  /** The asset/currency as reported. */
  currency?: string;
  /** The provider's own reference for the money leaving (a hash, a bank ref). */
  providerRef?: string | null;
  /** The provider OPERATOR's note — admin eyes only, never the client's. */
  operatorNote?: string | null;
}

export type PayoutSubmission =
  /** The provider holds it. `report` when the provider already knows the result. */
  | { outcome: 'accepted'; payoutId: string; report?: PayoutReport }
  /**
   * DEFINITELY nothing exists at the provider (a 4xx, a rate limit). With
   * `retryAfterMs` the refusal is momentary (a 429): the core requeues it
   * automatically, because a payout that was never created cannot be paid
   * twice. Without it, a person decides.
   */
  | { outcome: 'refused'; reason: string; retryAfterMs?: number }
  /** It may or may not exist (no answer, a 5xx). The claim is HELD. */
  | { outcome: 'unknown'; reason: string };

/** What the provider holds that could be the payout whose answer was lost. */
export type PayoutLookup =
  /** Every candidate id — the core drops ids already recorded and decides. */
  | { complete: true; candidates: readonly string[] }
  /** The search could not see everything; absence cannot be judged. */
  | { complete: false; reason: string };

export interface PayoutProbe {
  transactionId: string;
  destination: string;
  /** What was asked (`provider_request_amount`). */
  amount: string;
  currency: string;
  /** When the claim was taken — nothing older can be ours. */
  since: Date;
}

/**
 * An adapter's AUTOMATED payouts — required when any of its payout channels is
 * `automated` (the registry refuses the boot otherwise). Everything here talks
 * to the provider; the core (`core/payout-engine.service.ts`) claims, records,
 * adopts, settles, refunds and asks people.
 */
export interface PayoutRail {
  readonly idempotency: PayoutIdempotency;
  /** Can a payout the provider already holds be recalled? */
  readonly cancellable: boolean;
  /** Submissions per minute the provider accepts; the core queues to it. */
  readonly ratePerMinute: number | null;
  /**
   * When the provider cannot pay (switched off, not set up): does approving
   * mean the DESK pays by hand (`desk`, Rival's since 0052), or does the payout
   * wait for the provider (`wait`, 3pay — a hand-sent crypto payout is too
   * easy to get wrong)?
   */
  readonly whenUnavailable: 'desk' | 'wait';
  /** How long after the claim a payout the provider does not show may be judged absent. */
  readonly adoptWindowMs: number;

  quote(channel: PaymentChannel, amount: string, currency: string): Promise<PayoutQuote>;
  submit(channel: PaymentChannel, request: PayoutRequest): Promise<PayoutSubmission>;
  find(channel: PaymentChannel, probe: PayoutProbe): Promise<PayoutLookup>;
  /** The provider's word on payouts it holds. Missing ids: not reported this time. */
  read(
    channel: PaymentChannel,
    payoutIds: readonly string[],
    since: Date,
  ): Promise<ReadonlyMap<string, PayoutReport>>;
  /** Recall one it holds; throws when it can no longer be stopped. */
  cancel?(channel: PaymentChannel, payoutId: string): Promise<void>;
}

/* ── The adapter ─────────────────────────────────────────────────────────── */

/**
 * One payment provider. `manual`, `rival`, `threepay`; each future provider is
 * one more implementation in its own folder, registered in `PaymentsModule`.
 */
export interface PaymentProviderAdapter {
  readonly code: string;
  /** Its name as the console shows it ("Rival", "3pay"). */
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
  /** Automated payouts — required when a payout channel is `automated`. */
  readonly payouts?: PayoutRail;
  /**
   * It keeps an EXCHANGE LOG (0175): every call to it and every delivery from
   * it, bodies included, kept 90 days and shown to whoever may view providers.
   * Declared only by a provider whose exchanges carry NO client identity — 3pay
   * is sent amounts, our reference and payout addresses, never a name, email or
   * phone — because the log is shown unmasked. The adapter's own client records
   * its calls (`PaymentProviderExchangesStore`); the core records deliveries.
   */
  readonly keepsExchangeLog?: boolean;

  /**
   * Can it move money on this deployment right now: switched on, its required
   * settings present, and not a sandbox configuration on a production
   * deployment. A method on a provider that is not usable is not offered.
   */
  isUsable(): Promise<boolean>;

  /** Ask the provider whether the saved settings work. Absent on built-in providers. */
  testConnection?(): Promise<ConnectionCheck>;

  /**
   * The company's balance at the provider, for a provider that pays out of a
   * prefunded balance (3pay). The core compares it with the payouts waiting to
   * be sent and warns BEFORE they start failing for want of funds.
   */
  balance?(): Promise<ProviderBalance>;

  /**
   * Every movement the provider recorded in a window — for the core's
   * UNMATCHED-RECORDS audit: a record no transaction here explains (a payout
   * made by hand in the provider's dashboard, a deposit on a link we did not
   * make) is raised for a person. Absent: the provider cannot list its records.
   */
  listRecords?(since: Date, until: Date): Promise<ProviderRecordPage>;

  /** Its configuration row changed: drop anything cached from the old one. */
  settingsChanged?(): void;

  /** `redirect` deposit channels: open the hosted payment. */
  startPayment?(channel: PaymentChannel, input: StartPaymentInput): Promise<StartedPayment>;

  /** `redirect` deposit channels: what the provider says the payment is now. */
  checkPayment?(channel: PaymentChannel, externalId: string): Promise<PaymentStatus>;

  /**
   * A start whose ANSWER was lost: find or re-create the payment for this
   * reference, or null when the provider provably holds none. Rival replays
   * its create under the same idempotency key; a provider that echoes our
   * reference searches for it.
   */
  recoverPayment?(
    channel: PaymentChannel,
    input: StartPaymentInput,
  ): Promise<StartedPayment | null>;

  /** Ask the provider to re-check a payment upstream (Rival's `/refresh`). */
  refreshPayment?(channel: PaymentChannel, externalId: string): Promise<void>;
}

/** The injection token every adapter is registered under (`PaymentsModule`). */
export const PAYMENT_PROVIDER_ADAPTERS = Symbol('PAYMENT_PROVIDER_ADAPTERS');

/* ── Webhooks: verified NOTICES, applied by the core ─────────────────────── */

/** What a webhook receiver answers — the status is a signal to the provider's retries. */
export interface WebhookAnswer {
  status: number;
  body: unknown;
}

/**
 * One thing a verified delivery told us. THE DOORBELL RULE: a notice never
 * moves money by itself. The core re-reads the movement through the adapter
 * (`checkPayment`, `payouts.read`) and applies what the PROVIDER'S API says —
 * so a replayed, reordered or forged-but-signed payload cannot change state,
 * and a provider's webhook vocabulary never has to match its API's.
 */
export interface ProviderNotice {
  subject: 'payment' | 'payout';
  /** The provider's id — `provider_payment_id` / `provider_payout_id`. */
  providerId: string;
  /** The provider's own event name, as delivered — for the event log. */
  providerType: string;
  /** The event log's vocabulary. */
  eventType: ProviderEventType;
  /**
   * `status`: re-read and apply. `alarm`: a report that can only ever raise a
   * person's attention (a reversal of a settled deposit) — no money moves on
   * it, and the provider's stored state may not show it, so it is acted on as
   * delivered.
   */
  kind: 'status' | 'alarm';
}

/** What the core did with one notice — the receiver maps it to its provider's retry rules. */
export type NoticeOutcome =
  | 'applied'
  | 'duplicate'
  | 'stale'
  | 'ignored'
  | 'not-ours'
  /** No movement carries this id YET (a start/webhook race) — worth a retry. */
  | 'unknown-reference'
  /** The notice says final; the provider's stored state does not agree yet. */
  | 'pending'
  | 'needs-attention';

export type WebhookReading =
  | { verified: false; answer: WebhookAnswer }
  | {
      verified: true;
      notices: readonly ProviderNotice[];
      /** The answer, once the core has applied the notices. */
      answer: (outcomes: readonly NoticeOutcome[]) => WebhookAnswer;
    };

/**
 * A provider's inbound events: size, verification and replay protection, then
 * NOTICES. Registered apart from the adapter; one list, dispatched by provider
 * code from `POST /v1/payments/providers/:code/webhook` through the core's
 * `ProviderWebhookIngress`.
 */
export interface ProviderWebhookReceiver {
  readonly providerCode: string;
  read(
    rawBody: Buffer | undefined,
    header: (name: string) => string | undefined,
  ): Promise<WebhookReading>;
}

/** The injection token every webhook receiver is registered under (`PaymentsModule`). */
export const PAYMENT_PROVIDER_WEBHOOKS = Symbol('PAYMENT_PROVIDER_WEBHOOKS');
