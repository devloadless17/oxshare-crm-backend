import Decimal from 'decimal.js';
import { ValidationError } from '../../../../common/errors/domain-errors';
import {
  ProviderBusyError,
  type PaymentChannel,
  type PayoutLookup,
  type PayoutProbe,
  type PayoutQuote,
  type PayoutRail,
  type PayoutReport,
  type PayoutRequest,
  type PayoutSubmission,
} from '../payment-provider';
import { amountOf, bodyWithAmount, objectOf, textOf } from './threepay-json';
import { ThreePayClient, ThreePayRequestError } from './threepay.client';
import type { ThreePayAsset } from './threepay-config.service';

/** How many pages of 3pay's withdrawal list one search reads before it stops judging. */
const MAX_PAGES = 50;

/** 3pay's words for a withdrawal, in the core's (guide §05, "Withdrawal statuses"). */
const STATUS: Readonly<Record<string, PayoutReport['status']>> = {
  pending: 'pending', // deducted from the balance, not broadcast yet
  executing: 'pending', // broadcast, awaiting confirmation
  completed: 'completed',
  failed: 'failed', // the money did not leave; 3pay restored its balance
  rejected: 'rejected', // declined before broadcast; nothing was deducted
};

/**
 * 3PAY'S PAYOUTS, as the core's `PayoutRail` asks for them (0174).
 *
 * Translation only — the claim, the fingerprint lock, holding an unknown
 * outcome, adopting, settling and refunding are the core's
 * (`core/payout-engine.service.ts`).
 *
 *   idempotency `none` — `/withdrawal-request` takes no key and stores no
 *                reference of ours, and a payout is broadcast the moment the
 *                request is accepted. A payout whose answer was lost is found
 *                only by what was asked: the address, the amount and the
 *                network, after the claim — which the core's fingerprint lock
 *                makes unique. No `Idempotency-Key` header is sent: 3pay
 *                documents none, and a key it quietly cached would replay an old
 *                refusal at a person's Resend for ever.
 *   cancellable false — there is no cancel endpoint; a payout is on the chain
 *                seconds after it is accepted.
 *   whenUnavailable `wait` — a USDT payout sent by hand is too easy to get
 *                wrong; with 3pay off, approved payouts wait for it.
 *   rate 28/min — 3pay allows 30 a minute; the core queues to this.
 *   fee — 3pay DEDUCTS its fee from the amount (guide §05: "to send exactly
 *                500 USDT … request 502.00"). The owner's rule is that the
 *                client receives exactly what they withdrew, so the quote grosses
 *                up by the configured fee and the broker absorbs it. The net 3pay
 *                reports is checked by the core against the client's amount; a
 *                fee changed at 3pay shows up as a flagged shortfall.
 *
 * Reads: 3pay has no "get one withdrawal" endpoint, so a payout's word comes
 * from its list (`/withdrawal-requests`), from the claim time on, on the
 * channel's network.
 */
export class ThreePayPayouts implements PayoutRail {
  readonly idempotency = 'none' as const;
  readonly cancellable = false;
  readonly ratePerMinute = 28;
  readonly whenUnavailable = 'wait' as const;
  readonly adoptWindowMs = 15 * 60_000;

  constructor(private readonly client: ThreePayClient) {}

  async quote(channel: PaymentChannel, amount: string): Promise<PayoutQuote> {
    const asset = payoutAsset(channel);
    const net = new Decimal(amount);
    if (net.decimalPlaces() > 2) {
      throw new ValidationError(
        `3pay pays to 2 decimal places and cannot send ${amount} exactly; the payout is refused ` +
          'rather than paid a rounded amount.',
      );
    }
    const fee = (await this.client.configured()).payoutFees[asset];
    return { gross: net.plus(fee).toFixed(2), fee, net: net.toFixed(2) };
  }

  async submit(channel: PaymentChannel, request: PayoutRequest): Promise<PayoutSubmission> {
    const asset = payoutAsset(channel);
    let body: Record<string, unknown>;
    try {
      body = (
        await this.client.post(
          'payout',
          '/withdrawal-request',
          bodyWithAmount(request.amount, {
            walletAddress: request.destination.trim(),
            currencyType: asset,
            callbackUrl: request.callbackUrl,
          }),
          request.transactionId,
        )
      ).body;
    } catch (error) {
      // Nothing was sent: requeued when momentary, a person's otherwise.
      if (error instanceof ProviderBusyError) {
        return { outcome: 'refused', reason: error.message, retryAfterMs: error.retryAfterMs };
      }
      if (error instanceof ThreePayRequestError && error.definite) {
        return { outcome: 'refused', reason: refusalOf(error) };
      }
      // A 5xx, no answer, or an answer we cannot read: it may be on the chain.
      return { outcome: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }

    /*
     * 200 — completed within 3pay's 40 s window: `data` is the withdrawal.
     * 202 — broadcast, not confirmed yet: `data.withdrawal` carries its `_id`.
     */
    const data = objectOf(body['data']) ?? {};
    const nested = objectOf(data['withdrawal']) ?? {};
    const payoutId = textOf(data['withdrawalId']) ?? textOf(nested['_id']) ?? textOf(data['_id']);
    if (!payoutId) {
      // Accepted — so it may well be on the chain — but unnamed: adoption finds it.
      return { outcome: 'unknown', reason: '3pay accepted the payout without naming it.' };
    }
    return {
      outcome: 'accepted',
      payoutId,
      report: reportOf(payoutId, { ...nested, ...data }),
    };
  }

  /**
   * Every withdrawal on this network, created since the claim, to this
   * address, for this amount. The fingerprint lock allows only one of ours
   * unresolved at a time, so more than one candidate is somebody else's
   * payout too — and then a person decides.
   */
  async find(channel: PaymentChannel, probe: PayoutProbe): Promise<PayoutLookup> {
    const asset = payoutAsset(channel);
    const destination = keyOf(channel, probe.destination);
    const amount = new Decimal(probe.amount);
    const candidates: string[] = [];
    try {
      const complete = await this.eachPage(asset, probe.since, (record) => {
        const id = textOf(record['_id']);
        const recorded = amountOf(record['amount']);
        const address = textOf(record['walletAddress']);
        if (
          id &&
          recorded !== undefined &&
          amount.equals(recorded) &&
          address !== undefined &&
          keyOf(channel, address) === destination &&
          !createdBefore(record, probe.since)
        ) {
          candidates.push(id);
        }
        return false;
      });
      return complete
        ? { complete: true, candidates }
        : { complete: false, reason: `more than ${MAX_PAGES} pages of 3pay withdrawals` };
    } catch (error) {
      if (error instanceof ProviderBusyError) throw error;
      return { complete: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async read(
    channel: PaymentChannel,
    payoutIds: readonly string[],
    since: Date,
  ): Promise<ReadonlyMap<string, PayoutReport>> {
    const asset = payoutAsset(channel);
    const wanted = new Set(payoutIds);
    const reports = new Map<string, PayoutReport>();
    await this.eachPage(asset, since, (record) => {
      const id = textOf(record['_id']);
      if (id && wanted.has(id)) reports.set(id, reportOf(id, record));
      // Stop paging once every asked-for payout has been seen.
      return reports.size === wanted.size;
    });
    return reports;
  }

  /**
   * Walk 3pay's withdrawal list for one network from `since`, page by page.
   * `visit` returns true to stop early. Resolves true when every page was read
   * (or the walk was stopped on purpose), false when it hit the page cap.
   */
  private async eachPage(
    asset: ThreePayAsset,
    since: Date,
    visit: (record: Record<string, unknown>) => boolean,
  ): Promise<boolean> {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.client.page('/withdrawal-requests', page, {
        currencyType: asset,
        fromDate: since.toISOString(),
      });
      for (const record of result.items) if (visit(record)) return true;
      if (page >= result.totalPages) return true;
    }
    return false;
  }
}

/** The network a 3pay payout channel moves — declared on the channel, never inferred. */
export function payoutAsset(channel: PaymentChannel): ThreePayAsset {
  const code = channel.asset?.code;
  if (code !== 'USDT-TRC20' && code !== 'USDT-ERC20') {
    throw new ValidationError(`3pay has no network for ${channel.label}.`);
  }
  return code;
}

/** A withdrawal record in the core's words. */
export function reportOf(payoutId: string, record: Record<string, unknown>): PayoutReport {
  const rawStatus = textOf(record['status']) ?? 'unknown';
  const gross = amountOf(record['amount']);
  const fee = amountOf(record['fee']);
  const net = amountOf(record['netAmount']);
  const destination = textOf(record['walletAddress']);
  const currency = textOf(record['currencyType']);
  return {
    payoutId,
    // A word this build does not know yet is not a result: keep asking.
    status: STATUS[rawStatus] ?? 'pending',
    rawStatus,
    ...(gross !== undefined ? { gross } : {}),
    ...(fee !== undefined ? { fee } : {}),
    ...(net !== undefined ? { net } : {}),
    ...(destination !== undefined ? { destination } : {}),
    ...(currency !== undefined ? { currency } : {}),
    providerRef: textOf(record['transactionHash']) ?? textOf(record['blockchainTxHash']) ?? null,
  };
}

/**
 * What the desk is told when 3pay definitely refused — the engine prefixes
 * "3pay refused the payout:". Never the secret, never a stack.
 */
function refusalOf(error: ThreePayRequestError): string {
  switch (error.kind) {
    case 'credentials':
      return 'the API key or secret was rejected. Check them in Payment providers → 3pay.';
    case 'ip':
      return (
        'this server’s IP address is not on 3pay’s allowlist. Add it in 3pay’s dashboard ' +
        'under Settings → IP Whitelist.'
      );
    default:
      return error.message;
  }
}

function keyOf(channel: PaymentChannel, address: string): string {
  const trimmed = address.trim();
  return channel.destination?.normalize ? channel.destination.normalize(trimmed) : trimmed;
}

/** Was this record created before the window — when 3pay's own filter was loose? */
function createdBefore(record: Record<string, unknown>, since: Date): boolean {
  const created = textOf(record['createdAt']);
  if (!created) return false;
  const at = Date.parse(created);
  return !Number.isNaN(at) && at < since.getTime();
}
