import { Injectable, Logger } from '@nestjs/common';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';
import { AuthenticationError } from '../../../common/errors/domain-errors';
import { ReplayNonceStore } from '../../../common/security/replay-nonce.store';
import { AppSettingsStore } from '../../../store/app-settings.store';
import { TransactionsService } from '../transactions.service';
import { RivalConfigService } from './rival-config.service';
import { RivalWithdrawalsService } from './rival-withdrawals.service';
import { verifyRivalDelivery } from './rival-signature';

/**
 * One verified Rival CRM delivery, from raw bytes to an HTTP answer.
 *
 * ## The order of operations is the security design
 *
 *   verify (bearer + HMAC over raw bytes, ±300s) → claim the replay nonce →
 *   parse → validate the shape → apply
 *
 * Verification runs on bytes that have not been parsed; nothing downstream of
 * it ever sees an unauthenticated payload (R-5.3). The nonce closes the window
 * the timestamp leaves open — the conventions doc explicitly rejects "the
 * downstream apply is idempotent anyway" as an endpoint property, and this is
 * the endpoint that credits deposits and (slice 3) settles payouts.
 *
 * ## Answers are shaped to RIVAL'S RETRY POLICY, not to REST taste
 *
 * Rival delivers at-least-once: 6 attempts (60s → 6h), 5s per attempt, and it
 * retries ONLY network errors, 429 and 5xx — any 4xx is permanent and the
 * event is gone forever. So every branch here answers the question "should
 * Rival try again":
 *
 *   yes, this may resolve  → 503  (not configured yet; reference not seen yet
 *                                  — the create/webhook race; withdrawal
 *                                  handler not deployed yet)
 *   no, and stop           → 401 forgery/wrong key · 400 malformed · 413 oversize
 *   done, stop             → 200, whatever the internal outcome was
 *
 * A DB failure escapes to the exception filter as 500 — retried, correctly.
 */

export interface RivalWebhookAnswer {
  status: 200 | 400 | 401 | 403 | 413 | 503;
  body: { received: boolean; outcome: string };
}

/** ±300s validity span is 600s; the marker must outlive it. */
const NONCE_TTL_MS = 660_000;
const MAX_BODY_BYTES = 64 * 1024;

interface RivalEventBody {
  event: string;
  reference: string;
  withdrawal?: { externalReference?: string | null; adminNotes?: string | null } | null;
}

@Injectable()
export class RivalWebhookService {
  private readonly logger = new Logger(RivalWebhookService.name);

  constructor(
    private readonly config: RivalConfigService,
    private readonly nonces: ReplayNonceStore,
    private readonly settings: AppSettingsStore,
    private readonly transactions: TransactionsService,
    private readonly withdrawals: RivalWithdrawalsService,
  ) {}

  async handle(rawBody: Buffer | undefined, header: (name: string) => string | undefined) {
    return this.handleInternal(rawBody, header);
  }

  private async handleInternal(
    rawBody: Buffer | undefined,
    header: (name: string) => string | undefined,
  ): Promise<RivalWebhookAnswer> {
    /*
     * Size first, before any crypto: HMAC-ing an unbounded body is free work
     * for whoever is flooding the endpoint. 64 KB is an order of magnitude
     * above Rival's real payloads.
     */
    if (rawBody && rawBody.length > MAX_BODY_BYTES) {
      return { status: 413, body: { received: false, outcome: 'oversize' } };
    }

    const config = await this.config.resolve();
    if (!config || !config.webhookKey) {
      /*
       * 503, not 401: an operator may be mid-setup — key minted here, not yet
       * pasted into Rival, or the reverse. Retryable, so an event delivered in
       * that gap survives the six-attempt window instead of dying on a 4xx.
       */
      return { status: 503, body: { received: false, outcome: 'not-configured' } };
    }

    const raw = rawBody?.toString('utf8') ?? '';
    const verdict = verifyRivalDelivery({ rawBody: raw, header, secret: config.webhookKey });
    if (!verdict.ok) {
      // The reason carries fingerprints and never a key (rival-signature.ts).
      this.logger.warn(`Refused a Rival delivery: ${verdict.reason}`);
      raiseAlert(
        this.logger,
        ALERT_KINDS.WEBHOOK_SIGNATURE_FAILURE,
        'notify',
        'A Rival webhook delivery failed verification.',
        { reason: verdict.reason },
      );
      return { status: 401, body: { received: false, outcome: 'unverified' } };
    }

    /*
     * The signature IS the nonce: it commits to the timestamp and the exact
     * bytes, so two deliveries sharing one are the same request. Claimed only
     * AFTER verification — an attacker must not be able to burn markers with
     * garbage — and refused CLOSED if Redis is away (the store's contract).
     */
    try {
      await this.nonces.claim(`rival:${verdict.signature}`, NONCE_TTL_MS);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        this.logger.warn(`Refused a Rival delivery: replay or replay-check unavailable.`);
        return { status: 401, body: { received: false, outcome: 'replayed' } };
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
        return { status: 400, body: { received: false, outcome: 'malformed' } };
      }
      body = parsed as RivalEventBody;
    } catch {
      return { status: 400, body: { received: false, outcome: 'malformed' } };
    }

    /*
     * The pipe-liveness stamp, bumped for every VERIFIED delivery regardless
     * of what it says — the settings screen's "is this even connected", which
     * must not depend on whether the first event happened to match a row.
     */
    await this.settings.touchRivalLastEvent();

    if (body.event.startsWith('transaction.')) {
      return this.applyDepositEvent(body);
    }
    if (body.event.startsWith('withdrawal.')) {
      return this.applyWithdrawalEvent(body);
    }

    // Forward compatibility, per Rival's own integration doc: unknown event
    // names must not break the endpoint.
    return { status: 200, body: { received: true, outcome: 'ignored' } };
  }

  private async applyDepositEvent(body: RivalEventBody): Promise<RivalWebhookAnswer> {
    // `whish:<externalId>` — any other source prefix is a rail this CRM does
    // not consume yet; acknowledged so Rival stops, logged so we notice.
    const match = /^whish:(\d+)$/.exec(body.reference);
    if (!match) {
      this.logger.log(`Ignoring a ${body.event} for unrecognised reference ${body.reference}.`);
      return { status: 200, body: { received: true, outcome: 'not-ours' } };
    }
    const externalId = match[1];

    const kind = body.event.slice('transaction.'.length);
    if (kind === 'pending') {
      // The echo of our own create; the row was born pending. Nothing to learn.
      return { status: 200, body: { received: true, outcome: 'ignored' } };
    }
    if (kind !== 'completed' && kind !== 'failed' && kind !== 'reversed') {
      return { status: 200, body: { received: true, outcome: 'ignored' } };
    }

    const outcome = await this.transactions.applyRivalDepositEvent(externalId, kind);
    switch (outcome) {
      case 'unknown-reference':
        // The create/webhook race: Rival's 60s first retry outruns the UPDATE
        // that stores the externalId, and the poller sits behind it.
        return { status: 503, body: { received: true, outcome } };
      case 'pending':
        // The event says settled; Rival's stored state does not agree yet.
        // Retryable — by the next attempt the read will have caught up.
        return { status: 503, body: { received: true, outcome } };
      default:
        return { status: 200, body: { received: true, outcome } };
    }
  }

  private async applyWithdrawalEvent(body: RivalEventBody): Promise<RivalWebhookAnswer> {
    // `withdrawal:<rivalWithdrawalId>` — the id we recorded at submit time.
    const match = /^withdrawal:(.+)$/.exec(body.reference);
    if (!match) {
      return { status: 400, body: { received: false, outcome: 'malformed' } };
    }
    const rivalWithdrawalId = match[1];

    const kind = body.event.slice('withdrawal.'.length);
    if (kind !== 'pending' && kind !== 'completed' && kind !== 'rejected' && kind !== 'cancelled') {
      return { status: 200, body: { received: true, outcome: 'ignored' } };
    }

    const outcome = await this.withdrawals.applyEvent(rivalWithdrawalId, kind, {
      externalReference: body.withdrawal?.externalReference ?? null,
      adminNotes: body.withdrawal?.adminNotes ?? null,
    });
    /*
     * Every outcome answers 200, including 'not-ours': unlike a deposit's
     * create/webhook race (60 seconds wide, retry outruns it), a withdrawal
     * the CRM submitted gets its id recorded before Rival's operator can
     * possibly decide it — human approval is minutes, not milliseconds — and
     * withdrawals genuinely created OUTSIDE the CRM will never match, so a
     * 503 would make Rival retry those six times for nothing. The reconciler
     * covers the one theoretical gap by notes-match.
     */
    return { status: 200, body: { received: true, outcome } };
  }
}
