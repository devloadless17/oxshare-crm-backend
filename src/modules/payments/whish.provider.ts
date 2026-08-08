import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { PaymentIndeterminateError, ValidationError } from '../../common/errors/domain-errors';

/**
 * Whish Money — the operator's hosted collection gateway.
 *
 * ## What this provider CAN and CANNOT do
 *
 * Whish's API offers four operations: read the account balance, create a
 * payment (a "collect"), read a payment's status, and refund a payment that was
 * already made.
 *
 * There is NO payout or disbursement endpoint. Money can be collected FROM a
 * client and refunded BACK to the same payer, and that is all. So Whish backs
 * DEPOSITS here and withdrawals stay on the manual admin-approval path — a
 * client's payout is not something this API can perform, and pretending
 * otherwise would put a button on a screen that cannot work.
 *
 * `refund` is deliberately not implemented either. It reverses a specific prior
 * collect, requires egress-IP whitelisting with Whish, and is an operator action
 * with no client-facing surface — building it now would be an untested money
 * path with no caller.
 *
 * ## The flow, and where trust enters it
 *
 *   1. `createCollect()` → a `collectUrl` on Whish's own domain.
 *   2. The client pays there. Whish owns the OTP and the card details; none of
 *      it touches this system, which is the point of using a hosted page.
 *   3. Whish GETs our callback URL — success or failure.
 *   4. THE CALLBACK IS NOT EVIDENCE. It is an unauthenticated GET with no body
 *      and no signature, so anybody who learns the URL can call it. It is a
 *      NUDGE to go and ask. `getStatus()` is what settles the payment, and it
 *      is the only thing this system credits money on.
 *
 * That last point is the security boundary of this whole integration. A
 * callback-trusting implementation credits a wallet for anybody who can guess a
 * URL.
 *
 * ## Not a `store/` class, and not touching the database
 *
 * This is an HTTP client for one external system. It holds no Drizzle, reads no
 * tables and makes no decision about money — `deposits.service.ts` composes it
 * with the ledger. Keeping the seam thin is what lets the whole flow be tested
 * against a fake without a container.
 */

/** What Whish returns for a collect's state. `unknown` means undetermined. */
export type WhishCollectStatus = 'success' | 'pending' | 'failed' | 'refunded' | 'unknown';

/** The envelope every Whish endpoint answers with. */
interface WhishEnvelope<T> {
  status: boolean;
  code: string | null;
  data: T | null;
}

export interface WhishCollect {
  /** Whish's hosted payment page. The client is sent here. */
  collectUrl: string;
}

export interface WhishStatus {
  collectStatus: WhishCollectStatus;
  /** Present once somebody has paid. Useful for reconciliation, never for auth. */
  payerPhoneNumber: string | null;
}

/**
 * The currencies Whish settles in.
 *
 * NOT the platform's currency list: Whish takes USD and LBP, and a deposit
 * method denominated in anything else cannot route here. `assertSupported`
 * refuses rather than letting the API reject it with an opaque code.
 */
const WHISH_CURRENCIES = ['USD', 'LBP'] as const;
export type WhishCurrency = (typeof WHISH_CURRENCIES)[number];

/** How long to wait on Whish before giving up. */
const REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class WhishProvider {
  private readonly logger = new Logger(WhishProvider.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Is Whish usable at all?
   *
   * All four values or none. A partially configured gateway is worse than an
   * absent one: it appears on the deposit screen and fails at the moment the
   * client commits, which reads as "this platform is broken" rather than "this
   * method is not available".
   *
   * `payment-methods.service.ts` consults this before offering a gateway
   * method, the same way it refuses a manual method with no `pay_to`.
   */
  isConfigured(): boolean {
    return (
      Boolean(this.config.get<string>('WHISH_CHANNEL')) &&
      Boolean(this.config.get<string>('WHISH_SECRET')) &&
      Boolean(this.config.get<string>('WHISH_WEBSITE_URL')) &&
      Boolean(this.config.get<string>('WHISH_BASE_URL'))
    );
  }

  /**
   * Create a payment and get the hosted page to send the client to.
   *
   * `externalId` is OUR reference and must be unique per intended payment.
   * Whish treats a reused one as a replay and returns the original result,
   * which is exactly the behaviour a retried request wants — so the caller
   * passes the deposit's own id rather than minting a fresh value per attempt.
   *
   * The amount crosses as a STRING (§6.1) and is validated against Whish's own
   * rules first: USD takes at most 2 decimals with a 1.00 floor, LBP takes none
   * with a 1000 floor. Sending a value Whish will reject wastes a round trip and
   * surfaces as an opaque code rather than something a client can act on.
   */
  async createCollect(input: {
    externalId: string;
    amount: string;
    currency: string;
    invoice: string;
    successCallbackUrl: string;
    failureCallbackUrl: string;
    successRedirectUrl: string;
    failureRedirectUrl: string;
  }): Promise<WhishCollect> {
    const currency = this.assertSupported(input.currency);
    const amount = this.assertAmount(input.amount, currency);

    const data = await this.post<WhishCollect>('/payment/whish', {
      amount,
      currency,
      invoice: input.invoice,
      externalId: input.externalId,
      successCallbackUrl: input.successCallbackUrl,
      failureCallbackUrl: input.failureCallbackUrl,
      successRedirectUrl: input.successRedirectUrl,
      failureRedirectUrl: input.failureRedirectUrl,
    });

    if (!data?.collectUrl) {
      throw new ValidationError('Whish accepted the payment but returned no payment link.');
    }
    return data;
  }

  /**
   * Ask Whish what actually happened to a payment.
   *
   * THE ONLY THING THIS SYSTEM CREDITS MONEY ON. The callback is an
   * unauthenticated GET that anybody who learns the URL can fire; this is the
   * authenticated question whose answer is authoritative.
   *
   * Note `pending` includes "the client tried and failed but the link is still
   * payable" — a failure callback is NOT the end of a payment. Only `success`
   * and `failed` are settled outcomes.
   */
  async getStatus(externalId: string, currency: string): Promise<WhishStatus> {
    const data = await this.post<WhishStatus>('/payment/collect/status', {
      currency: this.assertSupported(currency),
      externalId,
    });

    // A missing body on a `status: true` envelope is not something to guess at.
    // `unknown` is a real Whish state and the honest mapping for "it answered
    // but told us nothing" — the caller treats it as unsettled and asks again.
    return {
      collectStatus: data?.collectStatus ?? 'unknown',
      payerPhoneNumber: data?.payerPhoneNumber ?? null,
    };
  }

  /**
   * One POST, with the envelope unwrapped and the failure modes separated.
   *
   * Whish signals three different things through `status` and `code`, and they
   * need three different reactions:
   *
   *   status: true                 → done, use `data`
   *   status: false, code: '500'   → PENDING. The outcome is genuinely unknown
   *                                  and must be reconciled, never assumed
   *                                  failed — treating it as a failure is how a
   *                                  paid client is told their payment did not
   *                                  work.
   *   status: false, other code    → refused, and the code says why.
   *
   * The distinction matters most on `createCollect`: a '500' there may mean a
   * payment link exists that the client could still pay.
   */
  private async post<T>(path: string, body: Record<string, string>): Promise<T | null> {
    const baseUrl = this.config.get<string>('WHISH_BASE_URL');
    const channel = this.config.get<string>('WHISH_CHANNEL');
    const secret = this.config.get<string>('WHISH_SECRET');
    const websiteUrl = this.config.get<string>('WHISH_WEBSITE_URL');

    if (!baseUrl || !channel || !secret || !websiteUrl) {
      throw new ValidationError('Whish is not configured on this deployment.');
    }

    /*
     * A timeout, because a hung payment provider must not hold a request open
     * indefinitely — the client is waiting on a screen, and a 15-second refusal
     * they can retry beats a spinner that never resolves.
     */
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          channel,
          secret,
          websiteUrl,
          'User-Agent': 'OXShare-CRM/1.0 (https://oxshare.com; support@oxshare.com)',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      /*
       * The REQUEST failed — no answer at all. Logged without the body, which
       * carries the amount and our externalId; the path is enough to locate it.
       * The secret is in the headers and never goes near a log line.
       */
      this.logger.error(
        `Whish ${path} could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ValidationError(
        'The payment provider could not be reached. Please try again in a moment.',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      /*
       * The BODY, not just the status.
       *
       * This used to log `answered HTTP 401` and discard everything else, which
       * is the least actionable form of this failure: 401, 403 and 404 all reach
       * here, and telling a bad credential pair from a wrong base path from an
       * unwhitelisted egress IP is exactly what the body says and the status does
       * not. An operator reading the log had a number and nowhere to go.
       *
       * Truncated, because an HTML error page from a proxy in front of Whish is
       * kilobytes of markup. Read defensively — a body that cannot be read must
       * not turn a provider refusal into an unhandled error on a money path.
       *
       * Nothing sensitive of OURS is in here: the secret travels in the request
       * headers, and this is Whish's answer. The request body is still withheld,
       * because it carries the amount and our reference.
       */
      const detail = await response
        .text()
        .then((text) => text.slice(0, 500).replace(/\s+/g, ' ').trim())
        .catch(() => '<unreadable>');

      this.logger.error(
        `Whish ${path} answered HTTP ${response.status} ${response.statusText}: ${
          detail || '<empty body>'
        }`,
      );
      throw new ValidationError('The payment provider refused the request. Please try again.');
    }

    const envelope = (await response.json()) as WhishEnvelope<T>;

    if (envelope.status) return envelope.data;

    if (envelope.code === '500') {
      /*
       * PENDING, not failed. Whish is telling us it does not know the outcome.
       *
       * Raised as its own TYPE, not merely its own message. `requestDeposit`
       * marks the deposit row `failure` when a gateway definitively refuses, and
       * it must not do that here: a payment link may exist and may still be
       * paid, so this is the one case that has to stay pending and be reconciled
       * against `getStatus`. A string is not something a caller can branch on.
       */
      this.logger.warn(`Whish ${path} returned an indeterminate result (code 500) — reconcile.`);
      throw new PaymentIndeterminateError(
        'The payment provider did not confirm the result. Check your payment history before retrying.',
      );
    }

    this.logger.warn(`Whish ${path} refused with code ${envelope.code ?? 'null'}`);
    throw new ValidationError('The payment provider refused this payment. Please try again.');
  }

  /** Whish settles USD and LBP. Anything else cannot route here. */
  private assertSupported(currency: string): WhishCurrency {
    const upper = currency.toUpperCase();
    if (!(WHISH_CURRENCIES as readonly string[]).includes(upper)) {
      throw new ValidationError(
        `Whish settles ${WHISH_CURRENCIES.join(' and ')} only; ${currency} cannot be paid this way.`,
      );
    }
    return upper as WhishCurrency;
  }

  /**
   * Whish's own amount rules, checked before the call.
   *
   * decimal.js throughout, never `Number()` — this is a money path and the value
   * arrives as a NUMERIC(28,8) string.
   *
   * The returned STRING is what goes on the wire: Whish wants a JSON string, and
   * it must carry the right scale, so a USD amount is fixed at 2 decimals and an
   * LBP one at 0 rather than sent at the ledger's 8.
   */
  private assertAmount(amount: string, currency: WhishCurrency): string {
    let value: Decimal;
    try {
      value = new Decimal(amount);
    } catch {
      throw new ValidationError('That deposit amount is not a valid number.');
    }
    if (!value.isFinite() || !value.isPositive()) {
      throw new ValidationError('A deposit amount must be positive.');
    }

    if (currency === 'LBP') {
      if (!value.isInteger()) {
        throw new ValidationError('A Whish payment in LBP cannot include decimals.');
      }
      if (value.lessThan(1000)) {
        throw new ValidationError('The minimum Whish payment is 1,000 LBP.');
      }
      return value.toFixed(0);
    }

    if (value.decimalPlaces() > 2) {
      throw new ValidationError('A Whish payment in USD supports at most two decimal places.');
    }
    if (value.lessThan(1)) {
      throw new ValidationError('The minimum Whish payment is 1.00 USD.');
    }
    return value.toFixed(2);
  }
}
