import { Inject, Injectable } from '@nestjs/common';
import { PaymentProvidersStore } from '../../../store/payment-providers.store';
import { PaymentProviderExchangesStore } from '../../../store/payment-provider-exchanges.store';
import { PaymentProviderRegistry } from '../providers/payment-provider-registry';
import {
  PAYMENT_PROVIDER_WEBHOOKS,
  type NoticeOutcome,
  type ProviderWebhookReceiver,
  type WebhookAnswer,
} from '../providers/payment-provider';
import { HostedDepositsService } from './hosted-deposits.service';
import { PayoutEngine } from './payout-engine.service';

/**
 * EVERY PROVIDER'S EVENTS, APPLIED BY THE CORE (0173).
 *
 * A provider's receiver (in its own folder) sizes, verifies and replay-checks
 * a delivery and turns it into NOTICES. This applies them — the one place
 * inbound events reach money — through the same engines the poll and the
 * client's own check use: a payment notice to `HostedDepositsService`, a
 * payout notice to `PayoutEngine`. Both follow the DOORBELL RULE: the
 * provider's API is asked, and its answer is what moves state.
 *
 * A database failure while applying escapes as a 500, which every provider
 * retries — correctly: nothing was applied.
 */
@Injectable()
export class ProviderWebhookIngress {
  private readonly receivers: Map<string, ProviderWebhookReceiver>;

  constructor(
    @Inject(PAYMENT_PROVIDER_WEBHOOKS) receivers: readonly ProviderWebhookReceiver[],
    private readonly registry: PaymentProviderRegistry,
    private readonly deposits: HostedDepositsService,
    private readonly payouts: PayoutEngine,
    private readonly providers: PaymentProvidersStore,
    /* Every delivery and our answer, kept 90 days (0175) — appended last. */
    private readonly exchanges: PaymentProviderExchangesStore,
  ) {
    this.receivers = new Map(receivers.map((receiver) => [receiver.providerCode, receiver]));
  }

  /** Does a provider with this code take events at all? */
  accepts(code: string): boolean {
    return this.receivers.has(code);
  }

  /**
   * Does this provider still take events at the pre-0168 address
   * `/v1/payments/<code>/webhook`? Only one whose adapter declares exactly that
   * address (Rival's dashboard holds it) — every other provider uses
   * `/v1/payments/providers/<code>/webhook`, and the old door stays shut to it.
   */
  acceptsLegacyPath(code: string): boolean {
    return (
      this.accepts(code) && this.registry.find(code)?.webhookPath === `/v1/payments/${code}/webhook`
    );
  }

  /**
   * One delivery, from raw bytes to the answer the provider's retries read —
   * and the delivery and that answer kept for 90 days (0175): the raw body as
   * it came, never its signature header.
   */
  async receive(
    code: string,
    rawBody: Buffer | undefined,
    header: (name: string) => string | undefined,
  ): Promise<WebhookAnswer> {
    const receiver = this.receivers.get(code);
    if (!receiver) return { status: 404, body: { received: false, outcome: 'unknown-provider' } };
    if (!this.registry.find(code)?.keepsExchangeLog) {
      return this.apply(code, receiver, rawBody, header, () => undefined);
    }
    const started = Date.now();
    let reference: string | undefined;
    const log = (status: number, body: unknown, error?: string) =>
      this.exchanges.record({
        providerCode: code,
        direction: 'inbound',
        method: 'POST',
        path: 'webhook',
        requestBody: rawBody ? rawBody.toString('utf8') : null,
        status,
        responseBody: body === null ? null : JSON.stringify(body),
        error: error ?? null,
        durationMs: Date.now() - started,
        reference: reference ?? null,
      });
    try {
      const answer = await this.apply(code, receiver, rawBody, header, (id) => {
        reference ??= id;
      });
      log(answer.status, answer.body);
      return answer;
    } catch (error) {
      // Nothing was applied; the provider retries on the 500 this becomes.
      log(500, null, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async apply(
    code: string,
    receiver: ProviderWebhookReceiver,
    rawBody: Buffer | undefined,
    header: (name: string) => string | undefined,
    // The provider's id for what the delivery is about — the log's reference.
    about: (providerId: string) => void,
  ): Promise<WebhookAnswer> {
    const reading = await receiver.read(rawBody, header);
    if (!reading.verified) return reading.answer;
    for (const notice of reading.notices) about(notice.providerId);

    /*
     * The pipe-liveness stamp, for EVERY verified delivery whatever it says —
     * the provider page's "is this connected", which must not depend on
     * whether the first event matched a row.
     */
    await this.providers.touchLastEvent(code);

    const outcomes: NoticeOutcome[] = [];
    for (const notice of reading.notices) {
      outcomes.push(
        notice.subject === 'payment'
          ? await this.deposits.onNotice(code, notice)
          : await this.payouts.onNotice(code, notice),
      );
    }
    return reading.answer(outcomes);
  }
}
