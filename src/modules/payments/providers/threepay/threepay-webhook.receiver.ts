import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ALERT_KINDS, raiseAlert } from '../../../../common/logging/alerts';
import type { ProviderEventType } from '../../../../store/payment-provider-events.store';
import { THREEPAY_CODE, ThreePayConfigService } from './threepay-config.service';
import { objectOf, textOf } from './threepay-json';
import type {
  NoticeOutcome,
  ProviderNotice,
  ProviderWebhookReceiver,
  WebhookAnswer,
  WebhookReading,
} from '../payment-provider';

const MAX_BODY_BYTES = 64 * 1024;

/** Statuses that promise nothing final — the doorbell is not rung for them. */
const NOT_FINAL = new Set(['pending', 'initiated', 'executing']);

const PAYMENT_EVENT: Readonly<Record<string, ProviderEventType>> = {
  confirmed: 'payment.succeeded',
  failed: 'payment.failed',
  expired: 'payment.failed',
};
const PAYOUT_EVENT: Readonly<Record<string, ProviderEventType>> = {
  completed: 'payout.completed',
  confirmed: 'payout.completed',
  failed: 'payout.rejected',
  rejected: 'payout.rejected',
};

function answer(status: number, outcome: string): WebhookAnswer {
  return { status, body: { received: status < 400, outcome } };
}

/**
 * The problem with a delivery's signature, or null when it is 3pay's:
 * `x-3pay-signature` is the lower-case hex HMAC-SHA256 of the RAW body, keyed
 * by the API secret (guide §08), compared in constant time.
 */
export function signatureProblem(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): string | null {
  if (!signature) return 'no x-3pay-signature header';
  if (!/^[0-9a-fA-F]{64}$/.test(signature.trim())) return 'a malformed signature';
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature.trim(), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? null
    : 'a signature that does not match';
}

/**
 * One 3pay delivery, from raw bytes to NOTICES (0174) — the core
 * (`ProviderWebhookIngress`) answers each by asking 3pay's API.
 *
 * ## Why a verified payload is still only a doorbell
 *
 * 3pay's webhook vocabulary does not match its API's (a deposit's `status` is
 * listed as `confirmed | failed | executing | pending`, and a `refund` type is
 * never explained), and a delivery carries no timestamp, so a captured one can
 * be replayed for ever. None of that matters under the doorbell rule: a notice
 * only makes the core re-read the invoice or the payout from 3pay, and what
 * 3pay's API says is what moves state. A replay re-reads and changes nothing.
 * That is also why there is no replay-nonce here, unlike Rival's receiver: 3pay
 * RETRIES a delivery with the same bytes, and a nonce would refuse its own
 * retries.
 *
 * ## Answers follow 3pay's retry policy
 *
 * 3pay retries anything but a 2xx, up to five times over about an hour, and
 * asks that every VERIFIED event gets a 200. So: 413 oversize, 401 forged, 503
 * while 3pay is not set up here (an operator mid-setup — worth a retry), and
 * 200 for everything verified — except when every notice hit a movement not
 * stored yet or a record 3pay has not caught up on, which a retry can resolve.
 * The reconciler sweeps behind all of it either way.
 */
@Injectable()
export class ThreePayWebhookReceiver implements ProviderWebhookReceiver {
  readonly providerCode = THREEPAY_CODE;

  private readonly logger = new Logger(ThreePayWebhookReceiver.name);

  constructor(private readonly config: ThreePayConfigService) {}

  async read(
    rawBody: Buffer | undefined,
    header: (name: string) => string | undefined,
  ): Promise<WebhookReading> {
    // Size first, before any crypto.
    if (rawBody && rawBody.length > MAX_BODY_BYTES) {
      return { verified: false, answer: answer(413, 'oversize') };
    }
    const config = await this.config.resolve();
    if (!config) return { verified: false, answer: answer(503, 'not-configured') };

    const problem = signatureProblem(
      rawBody ?? Buffer.alloc(0),
      header('x-3pay-signature'),
      config.apiSecret,
    );
    if (problem) {
      this.logger.warn(`Refused a 3pay delivery: ${problem}.`);
      raiseAlert(
        this.logger,
        ALERT_KINDS.WEBHOOK_SIGNATURE_FAILURE,
        'notify',
        'A 3pay webhook delivery failed verification.',
        { reason: problem },
      );
      return { verified: false, answer: answer(401, 'unverified') };
    }

    let event: Record<string, unknown> | undefined;
    try {
      event = objectOf(JSON.parse((rawBody ?? Buffer.alloc(0)).toString('utf8')));
    } catch {
      event = undefined;
    }
    // Verified but unreadable: 3pay would only resend the same bytes. 200.
    if (!event) return { verified: true, notices: [], answer: () => answer(200, 'malformed') };

    const notices = noticesOf(event);
    if (notices.length === 0) {
      return { verified: true, notices, answer: () => answer(200, 'ignored') };
    }
    return { verified: true, notices, answer: answerFor };
  }
}

/**
 * The delivery as notices. A `refund` names neither side for certain, so it
 * rings both doorbells: the payout it may be (3pay reverses a payout that
 * failed on the chain and restores its balance) is re-read, and the deposit it
 * may be raises an ALARM — a settled deposit reversed at 3pay moves no money
 * here, and 3pay's stored state may not show it, so a person looks.
 */
export function noticesOf(event: Record<string, unknown>): ProviderNotice[] {
  const type = textOf(event['type']);
  const status = textOf(event['status']) ?? 'unknown';
  const transactionId = textOf(event['transactionId']);
  const invoiceNo = textOf(event['invoiceNo']);
  const providerType = `${type ?? 'unknown'}.${status}`;

  if (type === 'deposit') {
    if (NOT_FINAL.has(status) || !invoiceNo) return [];
    return [
      {
        subject: 'payment',
        providerId: invoiceNo,
        providerType,
        eventType: PAYMENT_EVENT[status] ?? 'payment.pending',
        kind: 'status',
      },
    ];
  }
  if (type === 'payout') {
    if (NOT_FINAL.has(status) || !transactionId) return [];
    return [
      {
        subject: 'payout',
        providerId: transactionId,
        providerType,
        eventType: PAYOUT_EVENT[status] ?? 'payout.submitted',
        kind: 'status',
      },
    ];
  }
  if (type === 'refund') {
    const notices: ProviderNotice[] = [];
    if (transactionId) {
      notices.push({
        subject: 'payout',
        providerId: transactionId,
        providerType,
        eventType: 'payout.rejected',
        kind: 'status',
      });
    }
    if (invoiceNo) {
      notices.push({
        subject: 'payment',
        providerId: invoiceNo,
        providerType,
        eventType: 'payment.reversed',
        kind: 'alarm',
      });
    }
    return notices;
  }
  return [];
}

/** 503 only when a retry can help every notice; otherwise 200, as 3pay asks. */
function answerFor(outcomes: readonly NoticeOutcome[]): WebhookAnswer {
  const retry =
    outcomes.length > 0 &&
    outcomes.every((outcome) => outcome === 'unknown-reference' || outcome === 'pending');
  return retry ? answer(503, outcomes[0]) : answer(200, outcomes[0] ?? 'ignored');
}
