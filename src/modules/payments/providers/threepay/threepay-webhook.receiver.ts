import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ALERT_KINDS, raiseAlert } from '../../../../common/logging/alerts';
import type { ProviderEventType } from '../../../../store/payment-provider-events.store';
import { THREEPAY_CODE, ThreePayConfigService } from './threepay-config.service';
import { firstText, objectOf, textOf } from './threepay-json';
import { ThreePayClient } from './threepay.client';
import type {
  NoticeOutcome,
  ProviderNotice,
  ProviderWebhookReceiver,
  WebhookAnswer,
  WebhookReading,
} from '../payment-provider';

const MAX_BODY_BYTES = 64 * 1024;
/** The account's webhook secret is re-read at most this often when a signature fails. */
const SECRET_REFRESH_MS = 10 * 60_000;
/** After a read of the account FAILS, it is not made ahead of the other reads again for this long. */
const URGENT_RETRY_MS = 60_000;

/** Statuses that promise nothing final — the doorbell is not rung for them. */
const NOT_FINAL = new Set(['pending', 'initiated', 'executing', 'amount confirmed', 'processing']);

const PAYMENT_EVENT: Readonly<Record<string, ProviderEventType>> = {
  confirmed: 'payment.succeeded',
  failed: 'payment.failed',
  expired: 'payment.failed',
  cancelled: 'payment.failed',
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

function hexDigest(value: string | undefined): Buffer | null {
  const text = value?.trim().replace(/^sha256=/i, '') ?? '';
  return /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : null;
}

function matches(rawBody: Buffer, given: Buffer, key: string): boolean {
  const expected = createHmac('sha256', key).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The problem with a delivery's signature, or null when it is 3pay's.
 *
 * 3pay confirmed the scheme on 13 Oct 2026: `X-Webhook-Signature: sha256=<hex>`,
 * HMAC-SHA256 of the RAW body keyed by the account's WEBHOOK secret, never the
 * API secret. The `x-3pay-signature` its guide described is not sent and is not
 * accepted. The comparison is in constant time; any of the secrets in force
 * (the operator's, the account's) may match.
 */
export function signatureProblem(
  rawBody: Buffer,
  signature: string | undefined,
  webhookSecrets: readonly string[],
): string | null {
  if (!signature) return 'no X-Webhook-Signature header';
  const given = hexDigest(signature);
  if (!given) return 'a malformed signature';
  if (webhookSecrets.length === 0) {
    return 'a signature made with the account’s webhook secret, which is not known here';
  }
  if (webhookSecrets.some((key) => matches(rawBody, given, key))) return null;
  return 'a signature that does not match';
}

/**
 * One 3pay delivery, from raw bytes to NOTICES (0174; rebuilt 12 Oct 2026) —
 * the core (`ProviderWebhookIngress`) answers each by asking 3pay's API.
 *
 * ## One signature, the one 3pay confirmed
 *
 * `X-Webhook-Signature: sha256=…`, keyed by the account's WEBHOOK secret
 * (3pay, 13 Oct 2026; its guide's `x-3pay-signature` with the API secret is
 * not sent, and is refused here). 3pay omits the header when the account has
 * no webhook secret, so such an account's deliveries are all refused and its
 * deposits are settled by the sweep alone: Test connection says so.
 *
 * The webhook secret is whatever an operator typed, else the one 3pay's own
 * account reply carries (kept in memory by `ThreePayClient`, never stored). A
 * signature that fails is checked once more against a freshly read secret —
 * the account may have rotated it — but at most every ten minutes: a flood of
 * forged deliveries must not spend the requests real payments need.
 *
 * ## Why a verified payload is still only a doorbell
 *
 * 3pay's webhook vocabulary does not match its API's, and a delivery carries
 * no timestamp, so a captured one can be replayed for ever. None of that
 * matters under the doorbell rule: a notice only makes the core re-read the
 * payment or the payout from 3pay, and what 3pay's API says is what moves
 * state. A replay re-reads and changes nothing. That is also why there is no
 * replay-nonce here, unlike Rival's receiver: 3pay RETRIES a delivery with the
 * same bytes, and a nonce would refuse its own retries.
 *
 * ## Every verified delivery is answered 200
 *
 * 3pay's guide (§7, "always respond 200 for verified events") and its online
 * reference ("respond with HTTP 200 immediately") both ask for it, and it
 * retries anything else five times over about fifteen hours. So: 413 oversize,
 * 401 forged, 503 while 3pay is not set up here (an operator mid-setup — worth
 * a retry), and 200 for everything verified, whatever came of it.
 *
 * Until 13 Oct 2026 a delivery about a record 3pay's own API had not caught up
 * on was answered 503, to be sent again. It worked (3pay rings before its API
 * agrees, on every paid deposit), and it was against both documents. The core
 * now asks again itself after a few seconds (`noticeRecheckMs`), and the
 * reconciler sweeps behind all of it either way.
 */
@Injectable()
export class ThreePayWebhookReceiver implements ProviderWebhookReceiver {
  readonly providerCode = THREEPAY_CODE;

  private readonly logger = new Logger(ThreePayWebhookReceiver.name);
  private secretRefreshedAt = 0;

  constructor(
    private readonly config: ThreePayConfigService,
    private readonly client: ThreePayClient,
  ) {}

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

    const body = rawBody ?? Buffer.alloc(0);
    const signature = header('x-webhook-signature');
    let problem = signatureProblem(
      body,
      signature,
      await this.webhookSecrets(config.webhookSecret, false),
    );
    if (problem && signature && this.mayRefreshSecret()) {
      problem = signatureProblem(
        body,
        signature,
        await this.webhookSecrets(config.webhookSecret, true),
      );
    }
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

    // The "send a test webhook" button in 3pay's dashboard: verified, and about nothing.
    if (header('x-webhook-test')?.trim().toLowerCase() === 'true') {
      return { verified: true, notices: [], answer: () => answer(200, 'test') };
    }

    let event: Record<string, unknown> | undefined;
    try {
      event = objectOf(JSON.parse(body.toString('utf8')));
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

  /** At most one fresh read of the account per `SECRET_REFRESH_MS`, whoever is knocking. */
  private mayRefreshSecret(): boolean {
    const now = Date.now();
    if (now - this.secretRefreshedAt < SECRET_REFRESH_MS) return false;
    this.secretRefreshedAt = now;
    return true;
  }

  /**
   * The webhook secrets in force: the operator's, and the account's own. A
   * failure to read the account is not a reason to refuse a delivery the other
   * key may verify, so it is logged and the list is simply shorter.
   */
  private async webhookSecrets(configured: string | null, fresh: boolean): Promise<string[]> {
    const secrets = configured ? [configured] : [];
    const add = (secret: string | undefined) => {
      if (secret && !secrets.includes(secret)) secrets.push(secret);
    };
    const remembered = await this.client.rememberedWebhookSecret().catch(() => undefined);
    /*
     * A routine re-read is background work. With NO secret in hand (a fresh
     * start), or after a failed signature (once in ten minutes at most), the
     * read is what a delivery's verification hangs on, so it goes first. One
     * that fails is not repeated for a minute: while the account cannot be
     * read, a flood of forged deliveries must not spend the reads a payout or
     * a paying client needs.
     */
    const urgent =
      fresh || (!remembered && !configured && !this.client.accountFailedWithin(URGENT_RETRY_MS));
    try {
      const account = await this.client.account(fresh ? 0 : undefined, urgent ? 'high' : 'low');
      add(account.webhookSecret);
    } catch (error) {
      // The last secret read still verifies while 3pay's read allowance is spent.
      add(remembered);
      this.logger.warn(
        `Could not read 3pay’s account for its webhook secret: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return secrets;
  }
}

/**
 * The delivery as notices. Its fields sit under `data` (3pay's online docs) or
 * at the top (its PDF guide); both are read.
 *
 * A deposit is named by its transaction id AND its invoice number, so both
 * travel: whichever one our row holds finds it. A `refund` names neither side
 * for certain, so it rings both doorbells: the payout it may be (3pay reverses
 * a payout that failed on the chain and restores its balance) is re-read, and
 * the deposit it may be raises an ALARM — a settled deposit reversed at 3pay
 * moves no money here, and 3pay's stored state may not show it, so a person
 * looks.
 */
export function noticesOf(delivery: Record<string, unknown>): ProviderNotice[] {
  const event = { ...delivery, ...(objectOf(delivery['data']) ?? {}) };
  const type = textOf(event['type'])?.toLowerCase();
  const status = (textOf(event['status']) ?? 'unknown').toLowerCase();
  const transactionId = firstText(event, 'transactionId', 'id', '_id');
  const invoiceNo = textOf(event['invoiceNo']);
  const providerType = `${type ?? 'unknown'}.${status}`;
  /*
   * A withdrawal is known by its RECORD id: what the request's answer named,
   * what our row holds and what 3pay reads it by. Its other names travel too.
   */
  const recordId = firstText(event, 'withdrawalId', '_id', 'id') ?? transactionId;
  const otherNames = [transactionId, invoiceNo].filter(
    (name): name is string => name !== undefined && name !== recordId,
  );
  const payoutNotice = (eventType: ProviderEventType): ProviderNotice | null =>
    recordId
      ? {
          subject: 'payout',
          providerId: recordId,
          ...(otherNames.length > 0 ? { otherIds: [...new Set(otherNames)] } : {}),
          providerType,
          eventType,
          kind: 'status',
        }
      : null;

  if (type === 'deposit') {
    const paymentId = transactionId ?? invoiceNo;
    if (NOT_FINAL.has(status) || !paymentId) return [];
    return [
      {
        subject: 'payment',
        providerId: paymentId,
        ...(invoiceNo && invoiceNo !== paymentId ? { otherIds: [invoiceNo] } : {}),
        providerType,
        eventType: PAYMENT_EVENT[status] ?? 'payment.pending',
        kind: 'status',
      },
    ];
  }
  // A withdrawal sent through the API is a `withdrawal` in the online docs and a `payout` in the guide.
  if (type === 'payout' || type === 'withdrawal') {
    if (NOT_FINAL.has(status)) return [];
    const notice = payoutNotice(PAYOUT_EVENT[status] ?? 'payout.submitted');
    return notice ? [notice] : [];
  }
  if (type === 'refund') {
    const notices: ProviderNotice[] = [];
    const payout = payoutNotice('payout.rejected');
    if (payout) notices.push(payout);
    const paymentId = transactionId ?? invoiceNo;
    if (paymentId) {
      notices.push({
        subject: 'payment',
        providerId: paymentId,
        ...(invoiceNo && invoiceNo !== paymentId ? { otherIds: [invoiceNo] } : {}),
        providerType,
        eventType: 'payment.reversed',
        kind: 'alarm',
      });
    }
    return notices;
  }
  return [];
}

/** 200 for every verified event, as 3pay asks; the outcome is for the log. */
function answerFor(outcomes: readonly NoticeOutcome[]): WebhookAnswer {
  return answer(200, outcomes[0] ?? 'ignored');
}
