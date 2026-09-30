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
  type PaymentStatus,
  type ProviderBalance,
  type ProviderConfigField,
  type ProviderRecord,
  type ProviderRecordPage,
  type StartedPayment,
  type StartPaymentInput,
} from '../payment-provider';
import { evmAddressIssue, evmAddressKey, tronAddressIssue } from './threepay-address';
import { amountOf, bodyWithAmount, objectOf, textOf } from './threepay-json';
import { ThreePayPayouts } from './threepay-payouts';
import { ThreePayClient, ThreePayRequestError } from './threepay.client';
import {
  THREEPAY_CODE,
  THREEPAY_SETTINGS,
  ThreePayConfigService,
  payoutFeeIssue,
  type ThreePayAsset,
} from './threepay-config.service';

const TRC20 = { code: 'USDT-TRC20', label: 'USDT on Tron (TRC20)' } as const;
const ERC20 = { code: 'USDT-ERC20', label: 'USDT on Ethereum (ERC20)' } as const;

/** How many pages of a 3pay list the records audit or a reference search reads. */
const MAX_PAGES = 50;

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
  // 3pay takes no return URL: the portal keeps the client on a waiting card.
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
 * 3PAY — a USDT processor, as a provider (0174). Its guide is
 * `docs/integration-guide.pdf`; 3pay cannot be asked to change anything, so
 * every gap in its API is closed on this side.
 *
 * Two networks, each a channel in each direction: USDT on Tron (TRC20) and on
 * Ethereum (ERC20). A 3pay method is a USD method: the client's USD wallet
 * moves at par with the USDT (1 USDT = 1 USD, no rate, no spread — the owner,
 * 30 Sep 2026), and the channel's `asset` is what the core checks every report
 * against.
 *
 *   Deposits  a payment link per deposit (`/transaction/create`) with our
 *             reference as `clientReference`; credited with what 3pay reports
 *             ARRIVED (`actualBalance`), rounded down — less, more, or late.
 *   Payouts   `ThreePayPayouts`: no idempotency key, grossed up by the fee.
 *   Events    `ThreePayWebhookReceiver`: HMAC over the raw bytes, then notices
 *             the core answers by asking 3pay's API (the doorbell rule).
 *   Audit     `listRecords` feeds the core's unmatched-records audit; `balance`
 *             its warning before payouts run out of funds.
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
      hint: 'https://api.3pa-y.com/api/v1',
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
      hint: 'Write-only. 3pay also signs every webhook with it.',
    },
    {
      name: THREEPAY_SETTINGS.trc20PayoutFee,
      label: 'TRC20 payout fee (USDT)',
      kind: 'text',
      required: true,
      hint:
        '3pay’s withdrawal fee on Tron (2.00 in its guide). Payouts are grossed up by it, so ' +
        'the client receives exactly what they withdraw.',
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
  }

  async testConnection(): Promise<ConnectionCheck> {
    try {
      const balance = await this.balance();
      return {
        ok: true,
        message:
          `Connected. 3pay accepts the credentials from this server. Available: ` +
          `${balance.available} USDT; in payouts under way: ${balance.inFlight ?? '0'} USDT.`,
      };
    } catch (error) {
      return { ok: false, message: explain(error) };
    }
  }

  /** `getMerchantDetails`: `totalAmt` is what can be paid out now (guide §6.1). */
  async balance(): Promise<ProviderBalance> {
    const { body } = await this.client.get('/getMerchantDetails');
    const data = objectOf(body['data']);
    const available = amountOf(data?.['totalAmt']);
    if (available === undefined) {
      throw new ThreePayRequestError('unreadable', '3pay did not report a balance.');
    }
    const inFlight = amountOf(data?.['pendingAmt']);
    return { available, asset: 'USDT', ...(inFlight !== undefined ? { inFlight } : {}) };
  }

  async startPayment(channel: PaymentChannel, input: StartPaymentInput): Promise<StartedPayment> {
    const asset = depositAsset(channel);
    if (!input.callbackUrl) {
      throw new ExternalServiceError(
        'USDT deposits are unavailable: this deployment has no public API address for 3pay to ' +
          'report payments to (API_PUBLIC_URL).',
      );
    }
    let body: Record<string, unknown>;
    try {
      body = (
        await this.client.post(
          'create',
          '/transaction/create',
          bodyWithAmount(input.amount, {
            currencyType: asset,
            callbackUrl: input.callbackUrl,
            clientReference: input.idempotencyKey,
            description: input.invoice,
          }),
          input.idempotencyKey,
        )
      ).body;
    } catch (error) {
      throw this.startFailure(error);
    }

    const data = objectOf(body['data']) ?? {};
    const invoiceNo = textOf(data['invoiceNo']);
    const paymentUrl = textOf(data['paymentUrl']);
    if (!invoiceNo) {
      // Created, most likely, but unnamed: the sweep finds it by our reference.
      throw new PaymentIndeterminateError(UNCONFIRMED_PAGE);
    }
    /*
     * The link must ask for exactly what the client chose, on the network the
     * method names, and be a real https page. Anything else is 3pay's mistake
     * or ours: the link is withheld (nobody can pay it), the deposit stays
     * pending with its invoice for the sweep, and it expires unpaid.
     */
    const echoedAsset = textOf(data['currencyType']);
    const echoedAmount = amountOf(data['amount']);
    if (
      !paymentUrl ||
      !paymentUrl.startsWith('https://') ||
      (echoedAsset !== undefined && echoedAsset !== asset) ||
      (echoedAmount !== undefined && !new Decimal(echoedAmount).equals(input.amount))
    ) {
      this.logger.error(
        `3pay made invoice ${invoiceNo} for deposit ${input.idempotencyKey} unlike what was asked ` +
          `(${echoedAmount ?? '?'} ${echoedAsset ?? '?'} at ${paymentUrl ?? 'no page'}); ` +
          'the link is withheld.',
      );
      throw new PaymentIndeterminateError(UNCONFIRMED_PAGE, { providerPaymentId: invoiceNo });
    }
    const expiresAt = dateOf(data['expiresAt']);
    return { paymentUrl, externalId: invoiceNo, ...(expiresAt ? { expiresAt } : {}) };
  }

  /**
   * `/transaction/verify` — 3pay's own record of one invoice. `amount` is what
   * ARRIVED (`actualBalance`), never the link's figure: the core credits it on
   * a confirmed invoice, and on an expired one reads it as money that came in
   * unconfirmed. An absent figure is reported absent, and a person decides.
   */
  async checkPayment(channel: PaymentChannel, externalId: string): Promise<PaymentStatus> {
    depositAsset(channel);
    let body: Record<string, unknown>;
    try {
      body = (await this.client.get('/transaction/verify', { invoiceNo: externalId }, externalId))
        .body;
    } catch (error) {
      throw readFailure(error);
    }
    const data = objectOf(body['data']) ?? {};
    const echoed = textOf(data['invoiceNo']);
    if (echoed !== undefined && echoed !== externalId) {
      throw new ExternalServiceError(
        `3pay answered about invoice ${echoed} when asked about ${externalId}.`,
      );
    }
    const rawStatus = textOf(data['status']) ?? 'unknown';
    if (!DEPOSIT_STATUSES.has(rawStatus)) {
      this.logger.warn(
        `3pay reports invoice ${externalId} as "${rawStatus}", a word this build does not know; it is left open.`,
      );
    }
    const arrived = amountOf(data['actualBalance']);
    const currency = textOf(data['currencyType']);
    const fee = amountOf(data['fee']);
    const net = amountOf(data['netAmount']);
    return {
      settled: rawStatus === 'confirmed' || rawStatus === 'expired' || rawStatus === 'failed',
      paid: rawStatus === 'confirmed',
      expired: rawStatus === 'expired',
      rawStatus,
      needsAttention: false,
      ...(arrived !== undefined ? { amount: arrived } : {}),
      ...(currency !== undefined ? { currency } : {}),
      ...(fee !== undefined ? { fee } : {}),
      ...(net !== undefined ? { net } : {}),
    };
  }

  /**
   * A start whose answer was lost: 3pay echoes our reference as
   * `clientReference`, so the invoice is FOUND by it — never made again.
   * Null when 3pay provably holds none.
   */
  async recoverPayment(
    channel: PaymentChannel,
    input: StartPaymentInput,
  ): Promise<StartedPayment | null> {
    const asset = depositAsset(channel);
    const found: string[] = [];
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const result = await this.client.page('/transaction/list', page, {
          search: input.idempotencyKey,
          currencyType: asset,
        });
        for (const item of result.items) {
          const invoiceNo = textOf(item['invoiceNo']);
          if (invoiceNo && textOf(item['clientReference']) === input.idempotencyKey) {
            found.push(invoiceNo);
          }
        }
        if (page >= result.totalPages) break;
        if (page === MAX_PAGES) {
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

  /** Every deposit and withdrawal 3pay recorded in a window, both networks. */
  async listRecords(since: Date, until: Date): Promise<ProviderRecordPage> {
    const records: ProviderRecord[] = [];
    const window = { fromDate: since.toISOString(), toDate: until.toISOString() };
    try {
      for (const path of ['/transaction/list', '/withdrawal-requests'] as const) {
        let complete = false;
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const result = await this.client.page(path, page, window);
          for (const item of result.items) {
            const record = path === '/transaction/list' ? depositRecord(item) : payoutRecord(item);
            if (record) records.push(record);
          }
          if (page >= result.totalPages) {
            complete = true;
            break;
          }
        }
        if (!complete)
          return { complete: false, reason: `more than ${MAX_PAGES} pages of ${path}` };
      }
    } catch (error) {
      if (error instanceof ProviderBusyError) throw error;
      return { complete: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { complete: true, records };
  }

  /** A failed start, in the words a CLIENT may read — the detail goes to the log. */
  private startFailure(error: unknown): Error {
    if (error instanceof ProviderBusyError) {
      return new ProviderBusyError(
        'USDT payments are busy right now. Please try again in a minute.',
        error.retryAfterMs,
      );
    }
    if (!(error instanceof ThreePayRequestError))
      return new PaymentIndeterminateError(UNCONFIRMED_PAGE);
    if (!error.definite) return new PaymentIndeterminateError(UNCONFIRMED_PAGE);
    if (error.kind === 'refused') {
      return new ValidationError(`The payment provider refused this payment: ${error.message}`);
    }
    // Credentials, allowlist, configuration: the rail is down for everyone.
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

/** 3pay's words for an invoice (guide §6.2). */
const DEPOSIT_STATUSES = new Set(['confirmed', 'pending', 'expired', 'initiated', 'failed']);

/** The network a 3pay deposit channel moves. */
function depositAsset(channel: PaymentChannel): ThreePayAsset {
  const code = channel.asset?.code;
  if (channel.direction !== 'deposit' || (code !== 'USDT-TRC20' && code !== 'USDT-ERC20')) {
    throw new ValidationError(`3pay has no hosted payment for ${channel.label}.`);
  }
  return code;
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
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function dateOf(value: unknown): Date | undefined {
  const text = textOf(value);
  if (!text) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : new Date(at);
}

function depositRecord(item: Record<string, unknown>): ProviderRecord | null {
  const providerId = textOf(item['invoiceNo']);
  const occurredAt = dateOf(item['createdAt']);
  if (!providerId || !occurredAt) return null;
  const rawStatus = textOf(item['status']) ?? 'unknown';
  const amount = amountOf(item['actualBalance']) ?? amountOf(item['amount']);
  const net = amountOf(item['netAmount']);
  // The balance moves at the confirmation; the list is filtered by creation.
  const movedAt = dateOf(item['confirmedAt']);
  const asset = textOf(item['currencyType']);
  const counterparty = textOf(item['walletAddress']);
  const reference = textOf(item['clientReference']);
  return {
    subject: 'payment',
    providerId,
    moved: rawStatus === 'confirmed',
    rawStatus,
    occurredAt,
    ...(amount !== undefined ? { amount } : {}),
    ...(net !== undefined ? { net } : {}),
    ...(movedAt !== undefined ? { movedAt } : {}),
    ...(asset !== undefined ? { asset } : {}),
    ...(counterparty !== undefined ? { counterparty } : {}),
    ...(reference !== undefined ? { reference } : {}),
  };
}

function payoutRecord(item: Record<string, unknown>): ProviderRecord | null {
  const providerId = textOf(item['_id']);
  const occurredAt = dateOf(item['createdAt']);
  if (!providerId || !occurredAt) return null;
  const rawStatus = textOf(item['status']) ?? 'unknown';
  const amount = amountOf(item['amount']);
  const asset = textOf(item['currencyType']);
  const counterparty = textOf(item['walletAddress']);
  return {
    subject: 'payout',
    providerId,
    // Anything not refused has left, or is leaving, the company's balance.
    moved: rawStatus !== 'failed' && rawStatus !== 'rejected',
    rawStatus,
    occurredAt,
    ...(amount !== undefined ? { amount } : {}),
    ...(asset !== undefined ? { asset } : {}),
    ...(counterparty !== undefined ? { counterparty } : {}),
  };
}
