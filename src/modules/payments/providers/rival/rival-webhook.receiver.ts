import { Injectable, Logger } from '@nestjs/common';
import { ALERT_KINDS, raiseAlert } from '../../../../common/logging/alerts';
import { AuthenticationError } from '../../../../common/errors/domain-errors';
import {
  ReplayCheckUnavailableError,
  ReplayNonceStore,
} from '../../../../common/security/replay-nonce.store';
import type { ProviderEventType } from '../../../../store/payment-provider-events.store';
import { RivalConfigService } from './rival-config.service';
import { verifyRivalDelivery } from './rival-signature';
import type {
  NoticeOutcome,
  ProviderNotice,
  ProviderWebhookReceiver,
  WebhookAnswer,
  WebhookReading,
} from '../payment-provider';

/**
 * One Rival CRM delivery, from raw bytes to verified NOTICES (0173) — the core
 * (`ProviderWebhookIngress`) applies them by asking Rival's API.
 *
 * ## The order of operations is the security design
 *
 *   size → verify (bearer + HMAC over raw bytes, ±300s) → claim the replay
 *   nonce → parse → validate the shape → notices
 *
 * Verification runs on bytes that have not been parsed; nothing downstream of
 * it ever sees an unauthenticated payload (R-5.3). The nonce closes the window
 * the timestamp leaves open.
 *
 * ## Answers are shaped to RIVAL'S RETRY POLICY, not to REST taste
 *
 * Rival delivers at-least-once — 6 attempts (60s → 6h), 5s per attempt — and
 * retries ONLY network errors, 429 and 5xx; any 4xx is permanent and the event
 * is gone. So every answer asks "should Rival try again":
 *
 *   yes, this may resolve  → 503  (not configured yet; the replay check could
 *                                  not run; a deposit id not stored yet — the
 *                                  start/webhook race; Rival's stored state not
 *                                  caught up)
 *   no, and stop           → 401 forgery/wrong key/replay · 400 malformed · 413
 *   done, stop             → 200, whatever the internal outcome was
 */

/** ±300s validity span is 600s; the marker must outlive it. */
const NONCE_TTL_MS = 660_000;
const MAX_BODY_BYTES = 64 * 1024;

interface RivalEventBody {
  event: string;
  reference: string;
}

/** Rival's deposit events, in the event log's vocabulary. */
const DEPOSIT_EVENTS: Readonly<Record<string, ProviderEventType>> = {
  completed: 'payment.succeeded',
  failed: 'payment.failed',
  reversed: 'payment.reversed',
};
/** Rival's payout events, in the event log's vocabulary. */
const PAYOUT_EVENTS: Readonly<Record<string, ProviderEventType>> = {
  completed: 'payout.completed',
  rejected: 'payout.rejected',
  cancelled: 'payout.cancelled',
};

function answer(status: number, outcome: string, received = status < 400): WebhookAnswer {
  return { status, body: { received, outcome } };
}

@Injectable()
export class RivalWebhookReceiver implements ProviderWebhookReceiver {
  readonly providerCode = 'rival';

  private readonly logger = new Logger(RivalWebhookReceiver.name);

  constructor(
    private readonly config: RivalConfigService,
    private readonly nonces: ReplayNonceStore,
  ) {}

  async read(
    rawBody: Buffer | undefined,
    header: (name: string) => string | undefined,
  ): Promise<WebhookReading> {
    // Size first, before any crypto: HMAC-ing an unbounded body is free work.
    if (rawBody && rawBody.length > MAX_BODY_BYTES) {
      return { verified: false, answer: answer(413, 'oversize') };
    }

    const config = await this.config.resolve();
    if (!config || !config.webhookKey) {
      // 503, not 401: an operator may be mid-setup — retryable, so an event
      // delivered in that gap survives Rival's six-attempt window.
      return { verified: false, answer: answer(503, 'not-configured', false) };
    }

    const raw = rawBody?.toString('utf8') ?? '';
    const verdict = verifyRivalDelivery({ rawBody: raw, header, secret: config.webhookKey });
    if (!verdict.ok) {
      this.logger.warn(`Refused a Rival delivery: ${verdict.reason}`);
      raiseAlert(
        this.logger,
        ALERT_KINDS.WEBHOOK_SIGNATURE_FAILURE,
        'notify',
        'A Rival webhook delivery failed verification.',
        { reason: verdict.reason },
      );
      return { verified: false, answer: answer(401, 'unverified') };
    }

    /*
     * The signature IS the nonce. Claimed only AFTER verification, so garbage
     * cannot burn markers. A check that could not RUN (Redis away) answers 503
     * — Rival retries it — never 401, which Rival would treat as permanent and
     * drop a genuine, verified event for good.
     */
    try {
      await this.nonces.claim(`rival:${verdict.signature}`, NONCE_TTL_MS);
    } catch (error) {
      if (error instanceof ReplayCheckUnavailableError) {
        this.logger.warn('Deferred a Rival delivery: the replay check is unavailable.');
        return { verified: false, answer: answer(503, 'replay-check-unavailable', false) };
      }
      if (error instanceof AuthenticationError) {
        this.logger.warn('Refused a Rival delivery: already delivered.');
        return { verified: false, answer: answer(401, 'replayed') };
      }
      throw error;
    }

    let body: RivalEventBody;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as RivalEventBody).event !== 'string' ||
        typeof (parsed as RivalEventBody).reference !== 'string'
      ) {
        return { verified: false, answer: answer(400, 'malformed') };
      }
      body = parsed as RivalEventBody;
    } catch {
      return { verified: false, answer: answer(400, 'malformed') };
    }

    const notice = this.noticeOf(body);
    if (notice === 'malformed') return { verified: false, answer: answer(400, 'malformed') };
    if (typeof notice === 'string') {
      // Verified, and nothing to apply: 200, so Rival stops.
      return { verified: true, notices: [], answer: () => answer(200, notice) };
    }
    return {
      verified: true,
      notices: [notice],
      answer: (outcomes) => this.answerFor(notice.subject, outcomes),
    };
  }

  /**
   * The event as a notice — or null for one there is nothing to learn from
   * (Rival's echo of our own create, an event name this build does not know:
   * forward compatibility, per Rival's own integration doc).
   */
  private noticeOf(body: RivalEventBody): ProviderNotice | 'ignored' | 'not-ours' | 'malformed' {
    if (body.event.startsWith('transaction.')) {
      // `whish:<externalId>` — any other prefix is a rail this CRM does not use.
      const match = /^whish:(\d+)$/.exec(body.reference);
      if (!match) return 'not-ours';
      const kind = body.event.slice('transaction.'.length);
      const eventType = DEPOSIT_EVENTS[kind];
      if (!eventType) return 'ignored'; // `pending`: the echo of our own create
      return {
        subject: 'payment',
        providerId: match[1],
        providerType: body.event,
        eventType,
        // A reversal of a settled deposit may not show in Rival's stored
        // state, and moves no money here: a person's, as delivered.
        kind: kind === 'reversed' ? 'alarm' : 'status',
      };
    }
    if (body.event.startsWith('withdrawal.')) {
      // `withdrawal:<rivalWithdrawalId>` — the id recorded at submit time.
      const match = /^withdrawal:(.+)$/.exec(body.reference);
      if (!match) return 'malformed';
      const kind = body.event.slice('withdrawal.'.length);
      const eventType = PAYOUT_EVENTS[kind];
      if (!eventType) return 'ignored'; // `pending`: the echo of our own create
      return {
        subject: 'payout',
        providerId: match[1],
        providerType: body.event,
        eventType,
        kind: 'status',
      };
    }
    return 'ignored';
  }

  /**
   * What Rival is told. A DEPOSIT id no row carries yet (the start/webhook
   * race) or a payment Rival's stored state has not caught up on is 503, so
   * Rival retries. A payout's outcome is always 200: its id is recorded long
   * before Rival's operator can decide it, and payouts made outside the CRM
   * never match — a 503 would make Rival retry those six times for nothing.
   */
  private answerFor(
    subject: ProviderNotice['subject'],
    outcomes: readonly NoticeOutcome[],
  ): WebhookAnswer {
    const outcome = outcomes[0] ?? 'ignored';
    if (subject === 'payment' && (outcome === 'unknown-reference' || outcome === 'pending')) {
      return answer(503, outcome, true);
    }
    return answer(200, outcome);
  }
}
