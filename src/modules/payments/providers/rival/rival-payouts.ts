import {
  ExternalServiceError,
  PaymentIndeterminateError,
  ValidationError,
} from '../../../../common/errors/domain-errors';
import type {
  PaymentChannel,
  PayoutLookup,
  PayoutProbe,
  PayoutQuote,
  PayoutRail,
  PayoutReport,
  PayoutRequest,
  PayoutSubmission,
} from '../payment-provider';
import { RivalClient, type RivalWithdrawal } from './rival.client';

/**
 * Rival's payout type for each of its payout channels. Rival's create accepts
 * `CASH`, `WISH` and `CRYPTO`; each is one entry here plus one declared channel.
 */
export const RIVAL_PAYOUT_METHODS: Readonly<Record<string, 'WISH'>> = { whish: 'WISH' };

/** How many pages of pending withdrawals an orphan scan reads before it gives up judging. */
const MAX_SCAN_PAGES = 50;

/**
 * RIVAL'S PAYOUTS, as the core's `PayoutRail` asks for them (0173).
 *
 * Only translation lives here — the claim, the held outcome, adoption,
 * settling and refunding are the core's (`core/payout-engine.service.ts`).
 *
 *   idempotency `reference` — Rival stores our `notes: crm:<txId>` and returns
 *                  it, so a create whose answer was lost is found by it.
 *   cancellable — Rival cancels a PENDING payout; its 409 (PROCESSING) is
 *                  "being paid now", surfaced as a refusal.
 *   whenUnavailable `desk` — with Rival off, the desk pays Whish by hand and
 *                  approving records it paid (since 0052).
 *   fee — Rival's commission rule charges it ON TOP to the company, unknown in
 *                  advance: the quote asks for the client's amount, and a net
 *                  Rival reports below it is flagged by the core.
 */
export class RivalPayouts implements PayoutRail {
  readonly idempotency = 'reference' as const;
  readonly cancellable = true;
  readonly ratePerMinute = null;
  readonly whenUnavailable = 'desk' as const;
  readonly adoptWindowMs = 15 * 60_000;

  constructor(private readonly rival: RivalClient) {}

  quote(_channel: PaymentChannel, amount: string): Promise<PayoutQuote> {
    return Promise.resolve({ gross: amount, fee: null, net: amount });
  }

  async submit(channel: PaymentChannel, request: PayoutRequest): Promise<PayoutSubmission> {
    const method = RIVAL_PAYOUT_METHODS[channel.code];
    if (!method) {
      return { outcome: 'refused', reason: `Rival has no payout type for ${channel.label}.` };
    }
    try {
      const created = await this.rival.createWithdrawal({
        amount: request.amount,
        currency: request.currency,
        notes: `crm:${request.transactionId}`,
        method,
        recipientName: request.recipientName,
        recipientPhone: request.destination,
      });
      return { outcome: 'accepted', payoutId: created.id, report: reportOf(created) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // No answer, or a failure mid-write: it may exist. Everything else Rival
      // (or the quantiser, before calling) refused outright.
      if (error instanceof PaymentIndeterminateError) return { outcome: 'unknown', reason };
      if (error instanceof ValidationError || error instanceof ExternalServiceError) {
        return { outcome: 'refused', reason };
      }
      return { outcome: 'unknown', reason };
    }
  }

  /**
   * Every PENDING withdrawal carrying our note. A created-but-unanswered payout
   * is still PENDING at Rival for its operator — money-out needs one — so a
   * complete scan that finds none, past the window, is judged absent (and a
   * person decides).
   */
  async find(_channel: PaymentChannel, probe: PayoutProbe): Promise<PayoutLookup> {
    const note = `crm:${probe.transactionId}`;
    const candidates: string[] = [];
    for (let page = 1; page <= MAX_SCAN_PAGES; page += 1) {
      let list;
      try {
        list = await this.rival.listPendingWithdrawals(page);
      } catch (error) {
        return { complete: false, reason: error instanceof Error ? error.message : String(error) };
      }
      for (const withdrawal of list.data)
        if (withdrawal.notes === note) candidates.push(withdrawal.id);
      if (page >= (list.meta.totalPages || 1)) return { complete: true, candidates };
    }
    return { complete: false, reason: `more than ${MAX_SCAN_PAGES} pages of pending payouts` };
  }

  async read(
    _channel: PaymentChannel,
    payoutIds: readonly string[],
  ): Promise<ReadonlyMap<string, PayoutReport>> {
    const reports = new Map<string, PayoutReport>();
    for (const id of payoutIds) {
      try {
        reports.set(id, reportOf(await this.rival.getWithdrawal(id)));
      } catch {
        // Not reported this time; the next sweep asks again.
      }
    }
    return reports;
  }

  async cancel(_channel: PaymentChannel, payoutId: string): Promise<void> {
    await this.rival.cancelWithdrawal(payoutId);
  }
}

/** Rival's withdrawal, in the core's words. */
function reportOf(withdrawal: RivalWithdrawal): PayoutReport {
  const status: PayoutReport['status'] =
    withdrawal.status === 'COMPLETED'
      ? 'completed'
      : withdrawal.status === 'REJECTED'
        ? 'rejected'
        : withdrawal.status === 'CANCELLED'
          ? 'cancelled'
          : 'pending';
  return {
    payoutId: withdrawal.id,
    status,
    rawStatus: withdrawal.status,
    ...(withdrawal.netAmount !== undefined && withdrawal.netAmount !== null
      ? { net: withdrawal.netAmount }
      : {}),
    currency: withdrawal.currency,
    providerRef: withdrawal.externalReference,
    operatorNote: withdrawal.adminNotes,
  };
}
