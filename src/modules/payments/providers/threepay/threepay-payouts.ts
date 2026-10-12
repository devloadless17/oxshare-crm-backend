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
import { amountOf, bodyWithAmount, dateOf, firstText, objectOf, textOf } from './threepay-json';
import { ThreePayClient, ThreePayRequestError } from './threepay.client';
import type { ThreePayAsset } from './threepay-config.service';

/** How many pages of 3pay's withdrawal list one search reads before it stops judging. */
const MAX_PAGES = 20;
/** Up to this many payouts are asked about one by one; more are read from the list. */
const SINGLE_READS = 2;

/** 3pay's words for a withdrawal, in the core's (guide §05, "Withdrawal statuses"). */
const STATUS: Readonly<Record<string, PayoutReport['status']>> = {
  // Recorded and taken from the balance; waiting for approval in 3pay's
  // dashboard, or to be broadcast.
  pending: 'pending',
  executing: 'pending', // broadcast, awaiting confirmation
  completed: 'completed',
  failed: 'failed', // the money did not leave; 3pay restored its balance
  rejected: 'rejected', // declined before broadcast
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

/**
 * 3PAY'S PAYOUTS, as the core's `PayoutRail` asks for them (0174; rebuilt
 * 12 Oct 2026 against its live API).
 *
 * Translation only — the claim, the fingerprint lock, holding an unknown
 * outcome, adopting, settling and refunding are the core's
 * (`core/payout-engine.service.ts`).
 *
 *   idempotency `none` — `/withdrawal-request` takes no key and stores no
 *                reference of ours. A payout whose answer was lost is found
 *                only by what was asked: the address, the amount and the
 *                network, after the claim — which the core's fingerprint lock
 *                makes unique. No `Idempotency-Key` header is sent: 3pay
 *                documents none, and a key it quietly cached would replay an old
 *                refusal at a person's Resend for ever.
 *   cancellable false — a payout is on the chain seconds after it is accepted.
 *   whenUnavailable `wait` — a USDT payout sent by hand is too easy to get
 *                wrong; with 3pay off, approved payouts wait for it.
 *   rate 25 per 15 minutes — 3pay's server allows 30 (measured), counted even
 *                for a request it refuses; the core queues to this.
 *
 * ## Who carries 3pay's fee decides what is asked
 *
 * The owner's rule: the client receives exactly what they withdrew. 3pay's
 * ACCOUNT says how its fee is charged (`withdrawalFeePayer`):
 *
 *   `user`      the fee comes out of the amount sent ("to send exactly 500 …
 *               request 502.00", its guide) — so the payout is grossed up.
 *   `merchant`  the fee is charged to the company's balance on top — so the
 *               payout is asked for the client's amount as it is.
 *
 * An account that does not say is treated as its guide describes (`user`).
 * Either way the core checks what 3pay reports DELIVERED against the client's
 * amount and flags a payout that lands short or over, so a wrong reading costs
 * one flagged payout, never a silent difference.
 *
 * ## A payout 3pay holds for approval
 *
 * With auto-withdraw off in 3pay's dashboard, or above its threshold, 3pay
 * answers `pending` and sends nothing until somebody approves it THERE. That
 * is an accepted payout still in flight: it settles here when 3pay reports it
 * completed, and is refunded if it is rejected there.
 *
 * ## Reads
 *
 * One payout is asked about directly (`/payout/get`); several are read from
 * the withdrawal list in one request, because every read shares one budget of
 * a hundred per fifteen minutes.
 */
export class ThreePayPayouts implements PayoutRail {
  readonly idempotency = 'none' as const;
  readonly cancellable = false;
  readonly rate = { limit: 25, windowMs: 15 * 60_000 } as const;
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
    const onTop = (await this.client.account()).withdrawalFeePayer === 'merchant';
    const withFee = net.plus(fee).toFixed(2);
    return {
      gross: onTop ? net.toFixed(2) : withFee,
      fee,
      net: net.toFixed(2),
      balanceCost: withFee,
    };
  }

  async submit(channel: PaymentChannel, request: PayoutRequest): Promise<PayoutSubmission> {
    const asset = payoutAsset(channel);
    let body: Record<string, unknown>;
    try {
      body = (
        await this.client.post('payout', '/withdrawal-request', {
          body: bodyWithAmount(request.amount, {
            walletAddress: request.destination.trim(),
            currencyType: asset,
            callbackUrl: request.callbackUrl,
          }),
          reference: request.transactionId,
        })
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
     * 201 — recorded, waiting for approval at 3pay: `data.withdrawal.id`.
     */
    const data = objectOf(body['data']) ?? {};
    const nested = objectOf(data['withdrawal']) ?? {};
    const record = { ...nested, ...data };
    const payoutId = payoutIdOf(record);
    if (!payoutId) {
      // Accepted — so it may well be on the chain — but unnamed: adoption finds it.
      return { outcome: 'unknown', reason: '3pay accepted the payout without naming it.' };
    }
    return { outcome: 'accepted', payoutId, report: reportOf(payoutId, record) };
  }

  /**
   * Every withdrawal on this network, created since the claim, to this
   * address, for this amount. The fingerprint lock allows only one of ours
   * unresolved at a time, so more than one candidate is somebody else's
   * payout too — and then a person decides.
   *
   * A record for this amount and network that does NOT say where it went
   * cannot be ruled in or out: the search is then incomplete, and the claim
   * stays held rather than being judged "never sent".
   */
  async find(channel: PaymentChannel, probe: PayoutProbe): Promise<PayoutLookup> {
    const asset = payoutAsset(channel);
    const destination = keyOf(channel, probe.destination);
    const amount = new Decimal(probe.amount);
    const candidates: string[] = [];
    let unplaced = 0;
    try {
      const complete = await this.client.walk(
        '/withdrawal-requests',
        {},
        { since: probe.since, maxPages: MAX_PAGES, priority: 'high' },
        (record) => {
          const id = payoutIdOf(record);
          const recorded = amountOf(record['amount']);
          const network = textOf(record['currencyType']);
          if (
            !id ||
            recorded === undefined ||
            !amount.equals(recorded) ||
            (network !== undefined && network !== asset) ||
            createdBefore(record, probe.since)
          ) {
            return false;
          }
          const address = payoutDestinationOf(record);
          if (address === undefined) unplaced += 1;
          else if (keyOf(channel, address) === destination) candidates.push(id);
          return false;
        },
      );
      if (!complete) {
        return { complete: false, reason: `more than ${MAX_PAGES} pages of 3pay withdrawals` };
      }
      if (unplaced > 0) {
        return {
          complete: false,
          reason: `3pay lists ${unplaced} withdrawal(s) of this amount without a destination`,
        };
      }
      return { complete: true, candidates };
    } catch (error) {
      if (error instanceof ProviderBusyError) throw error;
      return { complete: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async read(
    _channel: PaymentChannel,
    payoutIds: readonly string[],
    since: Date,
  ): Promise<ReadonlyMap<string, PayoutReport>> {
    const wanted = new Set(payoutIds.filter((id) => id.length > 0));
    const reports = new Map<string, PayoutReport>();
    if (wanted.size === 0) return reports;
    if (wanted.size <= SINGLE_READS) {
      let listInstead = false;
      for (const id of wanted) {
        const report = await this.readOne(id);
        if (report === 'no-such-endpoint') {
          listInstead = true;
          break;
        }
        if (report) reports.set(id, report);
      }
      if (!listInstead) return reports;
    }
    await this.client.walk(
      '/withdrawal-requests',
      {},
      { since, maxPages: MAX_PAGES, priority: 'high' },
      (record) => {
        const id = payoutIdOf(record);
        if (id && wanted.has(id)) reports.set(id, reportOf(id, record));
        // Stop paging once every asked-for payout has been seen.
        return reports.size === wanted.size;
      },
    );
    return reports;
  }

  /**
   * `/payout/get?id=` — one withdrawal's full record. Null when 3pay holds
   * none by that id. An older 3pay without the endpoint answers with a page
   * that is not JSON; the caller then reads the list instead.
   */
  private async readOne(id: string): Promise<PayoutReport | null | 'no-such-endpoint'> {
    try {
      const { body } = await this.client.get(
        '/payout/get',
        { id },
        { reference: id, priority: 'high' },
      );
      const data = objectOf(body['data']);
      if (!data) return null;
      const named = payoutIdOf(data);
      // A reply about another payout is never applied to this one.
      if (named !== undefined && named !== id) return null;
      return reportOf(id, data);
    } catch (error) {
      if (error instanceof ThreePayRequestError && error.status === 404) {
        return error.providerCode === null && error.message === 'HTTP 404'
          ? 'no-such-endpoint'
          : null;
      }
      throw error;
    }
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

/** A withdrawal's id, under whichever name this reply uses. */
export function payoutIdOf(record: Record<string, unknown>): string | undefined {
  return firstText(record, 'withdrawalId', '_id', 'id');
}

/**
 * Where a withdrawal went. 3pay's live API names it `clientWallet`; its PDF
 * guide `walletAddress`. `clientWallet` wins when both are present, because on
 * a record that carries both, `walletAddress` may be the wallet it was sent
 * FROM.
 */
export function payoutDestinationOf(record: Record<string, unknown>): string | undefined {
  return firstText(record, 'clientWallet', 'walletAddress');
}

/** A withdrawal record in the core's words. */
export function reportOf(payoutId: string, record: Record<string, unknown>): PayoutReport {
  const rawStatus = (textOf(record['status']) ?? 'unknown').toLowerCase();
  const gross = amountOf(record['amount']);
  const fee = amountOf(record['fee']);
  const net = amountOf(record['netAmount']);
  const destination = payoutDestinationOf(record);
  const currency = textOf(record['currencyType']);
  const operatorNote = textOf(record['adminNotes']);
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
    ...(operatorNote !== undefined ? { operatorNote } : {}),
    providerRef: firstText(record, 'transactionHash', 'blockchainTxHash') ?? null,
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

/** Was this record created before the window? 3pay's lists take no date filter. */
function createdBefore(record: Record<string, unknown>, since: Date): boolean {
  const at = dateOf(record['createdAt']);
  return at !== undefined && at.getTime() < since.getTime();
}
