import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  ExternalServiceError,
  PaymentIndeterminateError,
  ValidationError,
} from '../../../../common/errors/domain-errors';
import { ALERT_KINDS, raiseAlert } from '../../../../common/logging/alerts';
import {
  ProviderBusyError,
  type ConnectionCheck,
  type PaymentChannel,
  type PaymentProviderAdapter,
  type PaymentCheckUrgency,
  type PaymentStatus,
  type ProviderBalance,
  type ProviderConfigField,
  type ProviderRecord,
  type ProviderRecordPage,
  type StartedPayment,
  type StartPaymentInput,
} from '../payment-provider';
import { evmAddressIssue, evmAddressKey, tronAddressIssue } from './threepay-address';
import { amountOf, dateOf, firstText, numberLiteral, objectOf, textOf } from './threepay-json';
import { ThreePayPayouts, payoutDestinationOf } from './threepay-payouts';
import { ThreePayClient, ThreePayRequestError, type ThreePayAccount } from './threepay.client';
import type { BudgetState } from './threepay-rate-limit';
import {
  THREEPAY_CODE,
  THREEPAY_SETTINGS,
  ThreePayConfigService,
  payoutFeeIssue,
  type ThreePayAsset,
} from './threepay-config.service';

const TRC20 = { code: 'USDT-TRC20', label: 'USDT on Tron (TRC20)' } as const;
const ERC20 = { code: 'USDT-ERC20', label: 'USDT on Ethereum (ERC20)' } as const;

/** How many pages of a 3pay list the records audit reads for one window. */
const AUDIT_PAGES = 30;
/** A search by our own reference matches a handful of rows at most. */
const SEARCH_PAGES = 3;

/**
 * How long a payment link lives, in minutes — sent with every link (`timer`).
 * 3pay's own default is the account's setting (10 minutes on a new account),
 * which is short for a client who must open a wallet, send, and wait for the
 * network; and a payment that arrives after the link expired is not credited
 * by 3pay without a support ticket. Stated here so the expiry is also KNOWN:
 * 3pay's reply does not say when a link ends.
 */
const LINK_MINUTES = 30;
/** The client is told the link ends a little before it does. */
const LINK_MARGIN_MS = 30_000;

/** A deposit on 3pay: what is credited, and what the client is shown while they pay. */
const DEPOSIT = {
  direction: 'deposit',
  flow: 'redirect',
  settlementScale: 2,
  // "amount … Minimum 1" (guide §04).
  minimumAmount: '1',
  // The client's USD wallet moves at PAR with the USDT (the owner, 30 Sep 2026).
  currencies: ['USD'],
  bindable: true,
  // The payer chooses the figure on a crypto transfer: credit what ARRIVED.
  creditPolicy: 'received',
  // The portal keeps the client on a waiting card and opens 3pay's page beside it.
  hostedPageReturns: false,
} as const;

const PAYOUT = {
  direction: 'payout',
  flow: 'automated',
  settlementScale: 2,
  // "Minimum withdrawal: 1 USDT (net amount must be positive after fee)" (guide §05):
  // the client's amount is the net, so it is held to 1.
  minimumAmount: '1',
  currencies: ['USD'],
  bindable: true,
} as const;

/**
 * 3PAY — a USDT processor, as a provider (0174; rebuilt 12 Oct 2026 against
 * its live API). 3pay cannot be asked to change anything, so every gap in its
 * API is closed on this side.
 *
 * Two networks, each a channel in each direction: USDT on Tron (TRC20) and on
 * Ethereum (ERC20). A 3pay method is a USD method: the client's USD wallet
 * moves at par with the USDT (1 USDT = 1 USD, no rate, no spread — the owner,
 * 30 Sep 2026), and the channel's `asset` is what the core checks every report
 * against.
 *
 *   Deposits  a payment link per deposit (`POST /transaction/create`, its
 *             fields in the QUERY STRING) carrying our reference; credited with
 *             what 3pay reports ARRIVED, rounded down — less, more, or late.
 *   Payouts   `ThreePayPayouts`: no idempotency key; the fee handled the way
 *             3pay's account says it is charged.
 *   Events    `ThreePayWebhookReceiver`: HMAC over the raw bytes, then notices
 *             the core answers by asking 3pay's API (the doorbell rule).
 *   Audit     `listRecords` feeds the core's unmatched-records audit; `balance`
 *             its warning before payouts run out of funds.
 *
 * ## A deposit has TWO names at 3pay
 *
 * `transactionId` (a uuid — what `/transaction/verify` and the webhook use) and
 * `invoiceNo` (`INV-…`, what its PDF guide uses). The id kept on our row is the
 * transaction id when 3pay gives one, else the invoice number, chosen by ONE
 * function (`paymentIdOf`) for the create reply, the lists and the webhook, so
 * every path names a deposit the same way.
 *
 * Only translation lives here; the money is the core's.
 */
@Injectable()
export class ThreePayPaymentProvider implements PaymentProviderAdapter {
  private readonly logger = new Logger(ThreePayPaymentProvider.name);

  readonly code = THREEPAY_CODE;
  readonly name = '3pay';
  // Its exchanges carry no client identity: amounts, our reference, payout addresses (0175).
  readonly keepsExchangeLog = true;
  readonly builtIn = false;

  readonly configFields: readonly ProviderConfigField[] = [
    {
      name: THREEPAY_SETTINGS.baseUrl,
      label: 'API base URL',
      kind: 'url',
      required: true,
      hint:
        'Live: https://pay.3pa-y.com/api/v1 — 3pay’s PDF guide prints api.3pa-y.com, which ' +
        'does not exist. Sandbox: https://sandbox.pay.3pa-y.com/api/v1.',
    },
    {
      name: THREEPAY_SETTINGS.apiKey,
      label: 'API key (apikey)',
      kind: 'text',
      required: true,
      hint: 'From 3pay’s dashboard: Settings → API Credentials. A public identifier.',
    },
    {
      name: THREEPAY_SETTINGS.apiSecret,
      label: 'API secret (x-api-secret)',
      kind: 'secret',
      required: true,
      hint: 'Write-only. Sent with every call to 3pay.',
    },
    {
      name: THREEPAY_SETTINGS.webhookSecret,
      label: 'Webhook secret (optional)',
      kind: 'secret',
      required: false,
      hint:
        'Leave blank: it is read from your 3pay account. Type it only if Test connection says ' +
        'it could not be read (3pay’s dashboard → Settings → Webhooks).',
    },
    {
      name: THREEPAY_SETTINGS.trc20PayoutFee,
      label: 'TRC20 payout fee (USDT)',
      kind: 'text',
      required: true,
      hint:
        '3pay’s withdrawal fee on Tron (2.00 in its guide). When 3pay takes it out of the ' +
        'amount sent, payouts are grossed up by it, so the client receives exactly what they ' +
        'withdraw.',
      validate: payoutFeeIssue,
    },
    {
      name: THREEPAY_SETTINGS.erc20PayoutFee,
      label: 'ERC20 payout fee (USDT)',
      kind: 'text',
      required: true,
      hint: '3pay’s withdrawal fee on Ethereum (2.50 in its guide).',
      validate: payoutFeeIssue,
    },
  ];

  readonly channels: readonly PaymentChannel[] = [
    { ...DEPOSIT, code: 'usdt_trc20', label: 'USDT (TRC20)', asset: TRC20 },
    { ...DEPOSIT, code: 'usdt_erc20', label: 'USDT (ERC20)', asset: ERC20 },
    {
      ...PAYOUT,
      code: 'usdt_trc20',
      label: 'USDT (TRC20)',
      asset: TRC20,
      destination: {
        kind: 'crypto_address',
        network: 'TRC20',
        label: 'USDT (TRC20) wallet address',
        validate: tronAddressIssue,
        // Base58 is case-sensitive: compared exactly as written.
      },
    },
    {
      ...PAYOUT,
      code: 'usdt_erc20',
      label: 'USDT (ERC20)',
      asset: ERC20,
      destination: {
        kind: 'crypto_address',
        network: 'ERC20',
        label: 'USDT (ERC20) wallet address',
        validate: evmAddressIssue,
        normalize: evmAddressKey,
      },
    },
  ];

  readonly payouts: ThreePayPayouts;

  constructor(
    private readonly client: ThreePayClient,
    private readonly config: ThreePayConfigService,
  ) {
    this.payouts = new ThreePayPayouts(client);
  }

  isUsable(): Promise<boolean> {
    return this.config.isUsable();
  }

  settingsChanged(): void {
    this.config.invalidate();
    this.client.forget();
  }

  /**
   * More than "the key works": the account is read, and both lists are asked
   * for one page, so a reply this build cannot read is found by a person
   * pressing a button — not by the first client's deposit. The answer also
   * says how the ACCOUNT is set, because two of its settings decide what a
   * payout does: whether 3pay sends it without a second approval in its own
   * dashboard, and who carries its fee.
   */
  async testConnection(): Promise<ConnectionCheck> {
    try {
      const account = await this.client.account(0, 'high');
      await this.client.page('/transaction/list', 1, { type: 'deposit' }, 'high');
      await this.client.page('/withdrawal-requests', 1, {}, 'high');
      const secret = (await this.client.configured()).webhookSecret ?? account.webhookSecret;
      return {
        ok: true,
        message: [
          'Connected. 3pay accepts the credentials from this server.',
          `Available: ${account.available} USDT; in payouts under way: ${account.inFlight ?? '0'} USDT.`,
          ...accountNotes(account),
          limitsNote(this.client.limits()),
          secret
            ? null
            : 'The webhook secret could not be read from the account: deliveries signed with ' +
              'it are refused until it is entered here.',
        ]
          .filter((line) => line !== null)
          .join(' '),
      };
    } catch (error) {
      return { ok: false, message: explain(error) };
    }
  }

  /** `getMerchantDetails`: `totalAmt` is what can be paid out now (guide §6.1). */
  async balance(): Promise<ProviderBalance> {
    const account = await this.client.account(0, 'low');
    return {
      available: account.available,
      asset: 'USDT',
      ...(account.inFlight !== undefined ? { inFlight: account.inFlight } : {}),
    };
  }

  /**
   * `POST /transaction/create`. What 3pay's live server reads, measured:
   * `currencyType` and `amount` from the QUERY STRING (in the body they are
   * ignored, and the request is refused as "currencyType is required"), and
   * the customer context from the body.
   *
   *   webhookUrl   where 3pay reports this payment — ours, per request, so it
   *                does not depend on what somebody typed in 3pay's dashboard.
   *   callbackUrl  where 3pay sends the payer's browser afterwards: the API's
   *                return bounce. (Its PDF guide calls this one the webhook
   *                address; a webhook posted there finds no route, and the one
   *                at `webhookUrl` and the sweep still settle the deposit.)
   *   referenceId  our reference. `clientReference` is the name 3pay's replies
   *                and its older guide use, so both are sent.
   */
  async startPayment(channel: PaymentChannel, input: StartPaymentInput): Promise<StartedPayment> {
    const asset = depositAsset(channel);
    if (!input.callbackUrl) {
      throw new ExternalServiceError(
        'USDT deposits are unavailable: this deployment has no public API address for 3pay to ' +
          'report payments to (API_PUBLIC_URL).',
      );
    }
    const asked = Date.now();
    let body: Record<string, unknown>;
    try {
      body = (
        await this.client.post('create', '/transaction/create', {
          query: {
            currencyType: asset,
            amount: numberLiteral(input.amount),
            timer: String(LINK_MINUTES),
            webhookUrl: input.callbackUrl,
            callbackUrl: httpsOnly(input.successRedirectUrl),
          },
          body: JSON.stringify({
            referenceId: input.idempotencyKey,
            clientReference: input.idempotencyKey,
            description: input.invoice,
          }),
          reference: input.idempotencyKey,
        })
      ).body;
    } catch (error) {
      throw this.startFailure(error);
    }

    // The reply's fields sit at the top (the live API) or under `data` (the PDF guide).
    const data = { ...(objectOf(body['data']) ?? {}), ...body };
    const paymentId = paymentIdOf(data);
    const paymentUrl = firstText(data, 'url', 'paymentUrl');
    if (!paymentId) {
      // Created, most likely, but unnamed: the sweep finds it by our reference.
      throw new PaymentIndeterminateError(UNCONFIRMED_PAGE);
    }
    /*
     * The link must ask for exactly what the client chose, on the network the
     * method names, and be a page of 3pay's own, over https. Anything else is
     * 3pay's mistake or ours: the link is withheld (nobody can pay it), the
     * deposit stays pending with its id for the sweep, and it expires unpaid.
     */
    const echoedAsset = textOf(data['currencyType']);
    const echoedAmount = amountOf(data['amount']);
    const baseUrl = (await this.client.configured()).baseUrl;
    if (
      !paymentUrl ||
      !isProvidersPage(paymentUrl, baseUrl) ||
      (echoedAsset !== undefined && echoedAsset !== asset) ||
      (echoedAmount !== undefined && !new Decimal(echoedAmount).equals(input.amount))
    ) {
      this.logger.error(
        `3pay made payment ${paymentId} for deposit ${input.idempotencyKey} unlike what was asked ` +
          `(${echoedAmount ?? '?'} ${echoedAsset ?? '?'} at ${paymentUrl ?? 'no page'}); ` +
          'the link is withheld.',
      );
      throw new PaymentIndeterminateError(UNCONFIRMED_PAGE, { providerPaymentId: paymentId });
    }
    const expiresAt =
      dateOf(data['expiresAt']) ?? new Date(asked + LINK_MINUTES * 60_000 - LINK_MARGIN_MS);
    return { paymentUrl, externalId: paymentId, expiresAt };
  }

  /**
   * `/transaction/verify` — 3pay's own record of one payment. `amount` is what
   * ARRIVED, never the link's figure: the core credits it on a confirmed
   * payment, and on an expired one reads it as money that came in unconfirmed.
   * A figure 3pay does not state plainly is reported absent, and a person
   * decides (`arrivedOf`).
   */
  async checkPayment(
    channel: PaymentChannel,
    externalId: string,
    urgency: PaymentCheckUrgency = 'background',
  ): Promise<PaymentStatus> {
    depositAsset(channel);
    let body: Record<string, unknown>;
    try {
      body = (
        await this.client.get('/transaction/verify', verifyQuery(externalId), {
          reference: externalId,
          // 3pay's own delivery is news; a sweep asking again leaves room for it.
          priority: urgency === 'event' ? 'high' : 'normal',
        })
      ).body;
    } catch (error) {
      throw readFailure(error);
    }
    const data = objectOf(body['data']) ?? {};
    const echoed = isInvoiceNo(externalId)
      ? textOf(data['invoiceNo'])
      : textOf(data['transactionId']);
    if (echoed !== undefined && echoed !== externalId) {
      throw new ExternalServiceError(
        `3pay answered about payment ${echoed} when asked about ${externalId}.`,
      );
    }
    const kind = textOf(data['type']) ?? textOf(data['transactionType']);
    if (kind !== undefined && kind !== 'deposit') {
      throw new ExternalServiceError(
        `3pay answered about a ${kind} when asked about deposit ${externalId}.`,
      );
    }
    const rawStatus = (textOf(data['status']) ?? 'unknown').toLowerCase();
    const paid = rawStatus === 'confirmed';
    const unpaid = DEPOSIT_UNPAID.has(rawStatus);
    if (!paid && !unpaid && !DEPOSIT_OPEN.has(rawStatus)) {
      this.logger.warn(
        `3pay reports payment ${externalId} as "${rawStatus}", a word this build does not know; it is left open.`,
      );
    }
    const arrived = arrivedOf(data, paid);
    const currency = textOf(data['currencyType']);
    const fee = amountOf(data['fee']);
    const net = amountOf(data['netAmount']);
    return {
      settled: paid || unpaid,
      paid,
      // 3pay's live API calls an expired link `failed`: a link has no other way to fail.
      expired: rawStatus === 'expired' || rawStatus === 'failed',
      rawStatus,
      needsAttention: false,
      ...(arrived !== undefined ? { amount: arrived } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(fee !== undefined ? { fee } : {}),
      ...(net !== undefined ? { net } : {}),
    };
  }

  /**
   * A start whose answer was lost: 3pay keeps our reference with the payment,
   * so it is FOUND by it — never made again. Null when 3pay provably holds
   * none. 3pay's search is free text, so every hit is checked to carry exactly
   * this reference.
   */
  async recoverPayment(
    channel: PaymentChannel,
    input: StartPaymentInput,
  ): Promise<StartedPayment | null> {
    depositAsset(channel);
    const found: string[] = [];
    try {
      for (let page = 1; ; page += 1) {
        const result = await this.client.page(
          '/transaction/list',
          page,
          { type: 'deposit', search: input.idempotencyKey },
          'normal',
        );
        for (const item of result.items) {
          const id = paymentIdOf(item);
          if (id && firstText(item, 'referenceId', 'clientReference') === input.idempotencyKey) {
            found.push(id);
          }
        }
        if (result.last) break;
        if (page === SEARCH_PAGES) {
          throw new ExternalServiceError('Too many 3pay payments match this reference to judge.');
        }
      }
    } catch (error) {
      throw readFailure(error);
    }
    const unique = [...new Set(found)];
    if (unique.length > 1) {
      throw new ExternalServiceError(
        `3pay holds ${unique.length} payments for ${input.idempotencyKey} ` +
          `(${unique.join(', ')}); match it by hand.`,
      );
    }
    return unique.length === 1 ? { paymentUrl: '', externalId: unique[0] } : null;
  }

  /**
   * Every confirmed deposit and every withdrawal 3pay recorded in a window,
   * both networks. 3pay's lists take no date filter, so each is walked from its
   * newest record back to `since` and cut to the window here.
   */
  async listRecords(since: Date, until: Date): Promise<ProviderRecordPage> {
    const records: ProviderRecord[] = [];
    const inWindow = (record: ProviderRecord | null): record is ProviderRecord =>
      record !== null &&
      record.occurredAt.getTime() >= since.getTime() &&
      record.occurredAt.getTime() < until.getTime();
    try {
      const deposits = await this.client.walk(
        '/transaction/list',
        // Only money that arrived must be explained; an unpaid link explains itself.
        { type: 'deposit', status: 'confirmed' },
        { since, maxPages: AUDIT_PAGES, priority: 'low' },
        (item) => {
          const record = depositRecord(item);
          if (inWindow(record)) records.push(record);
          return false;
        },
      );
      if (!deposits) {
        return { complete: false, reason: `more than ${AUDIT_PAGES} pages of 3pay deposits` };
      }
      const withdrawals = await this.client.walk(
        '/withdrawal-requests',
        {},
        { since, maxPages: AUDIT_PAGES, priority: 'low' },
        (item) => {
          const record = payoutRecord(item);
          if (inWindow(record)) records.push(record);
          return false;
        },
      );
      if (!withdrawals) {
        return { complete: false, reason: `more than ${AUDIT_PAGES} pages of 3pay withdrawals` };
      }
    } catch (error) {
      if (error instanceof ProviderBusyError) throw error;
      return { complete: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { complete: true, records };
  }

  /**
   * A failed start, in the words a CLIENT may read. 3pay's own words go to the
   * log, the exchange log and a page — never to the client: its first refusal
   * in production ("Validation failed") was shown to one, and told them
   * nothing they could act on.
   */
  private startFailure(error: unknown): Error {
    if (error instanceof ProviderBusyError) {
      const minutes = Math.max(1, Math.ceil(error.retryAfterMs / 60_000));
      return new ProviderBusyError(
        `USDT payments are busy right now. Please try again in about ${minutes} ` +
          `${minutes === 1 ? 'minute' : 'minutes'}.`,
        error.retryAfterMs,
      );
    }
    if (!(error instanceof ThreePayRequestError))
      return new PaymentIndeterminateError(UNCONFIRMED_PAGE);
    if (!error.definite) return new PaymentIndeterminateError(UNCONFIRMED_PAGE);
    // Refused, credentials, allowlist, configuration: nobody can pay this way until it is fixed.
    raiseAlert(
      this.logger,
      ALERT_KINDS.PAYMENT_STATE_MISMATCH,
      'page',
      `3pay refused to start a payment: ${explain(error)}`,
      { provider: THREEPAY_CODE, kind: error.kind },
    );
    return new ExternalServiceError(
      'USDT deposits are unavailable right now. Please try again later.',
    );
  }
}

const UNCONFIRMED_PAGE =
  'The payment provider did not confirm the payment page. Check your transactions in a few ' +
  'minutes before trying again.';

/** 3pay's words for a payment still open: made, or seen on the chain and being collected. */
const DEPOSIT_OPEN = new Set(['initiated', 'pending', 'amount confirmed', 'processing']);
/** Final, and nothing was credited at 3pay. */
const DEPOSIT_UNPAID = new Set(['expired', 'failed', 'cancelled', 'canceled']);

/** The network a 3pay deposit channel moves. */
function depositAsset(channel: PaymentChannel): ThreePayAsset {
  const code = channel.asset?.code;
  if (channel.direction !== 'deposit' || (code !== 'USDT-TRC20' && code !== 'USDT-ERC20')) {
    throw new ValidationError(`3pay has no hosted payment for ${channel.label}.`);
  }
  return code;
}

/**
 * THE id a deposit is known by on our rows: 3pay's transaction id, or its
 * invoice number where no transaction id is given. One rule for the create
 * reply, a list row and a webhook, so they always agree.
 */
export function paymentIdOf(record: Record<string, unknown>): string | undefined {
  return firstText(record, 'transactionId', 'invoiceNo');
}

function isInvoiceNo(id: string): boolean {
  return /^INV-/i.test(id);
}

/** How `/transaction/verify` is asked about an id of either kind. */
function verifyQuery(id: string): Record<string, string> {
  return isInvoiceNo(id) ? { invoiceNo: id } : { transactionId: id, type: 'deposit' };
}

/**
 * WHAT ARRIVED on a payment, as an exact decimal, or undefined when 3pay does
 * not say it plainly.
 *
 *  1. `actualBalance` — the on-chain figure, when 3pay reports it. Always wins.
 *  2. Otherwise, on a CONFIRMED payment only, the link's `amount` — but only if
 *     3pay's own arithmetic agrees with it (`netAmount + fee`, when both are
 *     given). 3pay credits its merchant the net of what arrived, so the two
 *     differing means `amount` is not what arrived.
 *
 * Anything else is undefined: the core then credits nothing and a person
 * confirms the figure, which is the right outcome for a number nobody stated.
 */
export function arrivedOf(data: Record<string, unknown>, confirmed: boolean): string | undefined {
  const onChain = amountOf(data['actualBalance']);
  if (onChain !== undefined) return onChain;
  if (!confirmed) return undefined;
  const asked = amountOf(data['amount']);
  if (asked === undefined) return undefined;
  const net = amountOf(data['netAmount']);
  const fee = amountOf(data['fee']);
  if (net !== undefined && fee !== undefined && !new Decimal(net).plus(fee).equals(asked)) {
    return undefined;
  }
  return asked;
}

/** A return address 3pay will take: https, or nothing. */
function httpsOnly(url: string | undefined): string | undefined {
  return url?.startsWith('https://') ? url : undefined;
}

/**
 * Is this payment page 3pay's own — https, on the site its API is served from?
 * A client is sent to whatever this is, so a reply naming another site is
 * never followed. (A simulator on a bare address has no site to compare.)
 */
export function isProvidersPage(paymentUrl: string, baseUrl: string): boolean {
  let page: URL;
  let api: URL;
  try {
    page = new URL(paymentUrl);
    api = new URL(baseUrl);
  } catch {
    return false;
  }
  if (page.protocol !== 'https:') return false;
  const site = siteOf(api.hostname);
  return site === null || page.hostname === site || page.hostname.endsWith(`.${site}`);
}

/** The registrable site of a host name (`pay.3pa-y.com` → `3pa-y.com`); null for an address. */
function siteOf(hostname: string): string | null {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':') || !hostname.includes('.')) return null;
  return hostname.split('.').slice(-2).join('.');
}

/** What the connection test says about how the ACCOUNT is set. */
function accountNotes(account: ThreePayAccount): (string | null)[] {
  return [
    account.approval !== undefined && account.approval !== 'approved'
      ? `3pay has not approved this account yet (${account.approval}).`
      : null,
    account.autoWithdraw === false
      ? 'Payouts: every one waits for approval in 3pay’s dashboard, because auto-withdraw is ' +
        'off there. Turn it on in 3pay’s settings for payouts to go out on their own.'
      : account.autoWithdraw === true
        ? `Payouts: sent automatically up to ${account.maxAutoWithdraw ?? '?'} USDT; a larger ` +
          'one waits for approval in 3pay’s dashboard.'
        : null,
    account.withdrawalFeePayer === 'merchant'
      ? 'Payout fee: charged to the 3pay balance, on top of what the client receives.'
      : account.withdrawalFeePayer === 'user'
        ? 'Payout fee: taken out of the amount sent, so each payout is grossed up by it.'
        : null,
    account.depositFeePayer ? `Deposit fee: carried by the ${account.depositFeePayer}.` : null,
    account.staticWallet === true
      ? 'A static wallet is ON at 3pay: payouts above its threshold go to that wallet, not to ' +
        'the client — each one is held here for a person.'
      : null,
  ];
}

/**
 * What the connection test says about 3pay's request limits: the figures its
 * server stated to THIS server on real, authenticated calls — the limit AND
 * the window it is counted in. 3pay's PDF guides print other limits, so this
 * sentence is where a person reads the ones in force. A kind of call not made
 * since the last restart has not been stated yet, and is said so.
 */
function limitsNote(limits: ReturnType<ThreePayClient['limits']>): string {
  const part = (state: BudgetState, name: string) =>
    state.stated
      ? `${state.limit} ${name} per ${windowWords(state.windowSeconds)}`
      : `${name} not stated yet (none since the last restart)`;
  return (
    'Request limits, as 3pay’s server states them to this server: ' +
    `${part(limits.read, 'status checks')}${limits.read.stated ? ` (${limits.read.left} left now)` : ''}; ` +
    `${part(limits.create, 'payment links')}; ${part(limits.payout, 'payout requests')}.`
  );
}

/** A window's length in words: 900 → "15 minutes", 60 → "minute". */
function windowWords(seconds: number): string {
  if (seconds === 60) return 'minute';
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

/** A read that failed, as the core expects it: busy stays busy, the rest is a 502. */
function readFailure(error: unknown): Error {
  if (error instanceof ProviderBusyError || error instanceof ExternalServiceError) return error;
  return new ExternalServiceError(explain(error));
}

/** What a person is told about a failed 3pay call. */
function explain(error: unknown): string {
  if (error instanceof ThreePayRequestError) {
    switch (error.kind) {
      case 'credentials':
        return '3pay rejected the API key or secret.';
      case 'ip':
        return (
          '3pay refused this server’s IP address. Add it in 3pay’s dashboard under ' +
          'Settings → IP Whitelist.'
        );
      case 'unreachable':
        return `3pay could not be reached: ${error.message}`;
      case 'unreadable':
        return `3pay answered in a form this build cannot read: ${error.message}`;
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function depositRecord(item: Record<string, unknown>): ProviderRecord | null {
  const kind = textOf(item['type']) ?? textOf(item['transactionType']);
  if (kind !== undefined && kind !== 'deposit') return null;
  const providerId = paymentIdOf(item);
  const occurredAt = dateOf(item['createdAt']);
  if (!providerId || !occurredAt) return null;
  const rawStatus = (textOf(item['status']) ?? 'unknown').toLowerCase();
  const amount = amountOf(item['actualBalance']) ?? amountOf(item['amount']);
  const asset = textOf(item['currencyType']);
  const counterparty = textOf(item['walletAddress']);
  const reference = firstText(item, 'referenceId', 'clientReference');
  return {
    subject: 'payment',
    providerId,
    moved: rawStatus === 'confirmed',
    rawStatus,
    occurredAt,
    ...(amount !== undefined ? { amount } : {}),
    ...(asset !== undefined ? { asset } : {}),
    ...(counterparty !== undefined ? { counterparty } : {}),
    ...(reference !== undefined ? { reference } : {}),
  };
}

function payoutRecord(item: Record<string, unknown>): ProviderRecord | null {
  const providerId = firstText(item, '_id', 'id', 'withdrawalId');
  const occurredAt = dateOf(item['createdAt']);
  if (!providerId || !occurredAt) return null;
  const rawStatus = (textOf(item['status']) ?? 'unknown').toLowerCase();
  const amount = amountOf(item['amount']);
  const asset = textOf(item['currencyType']);
  const counterparty = payoutDestinationOf(item);
  return {
    subject: 'payout',
    providerId,
    // Anything not refused has left, or is leaving, the company's balance.
    moved: !['failed', 'rejected', 'cancelled', 'canceled'].includes(rawStatus),
    rawStatus,
    occurredAt,
    ...(amount !== undefined ? { amount } : {}),
    ...(asset !== undefined ? { asset } : {}),
    ...(counterparty !== undefined ? { counterparty } : {}),
  };
}
