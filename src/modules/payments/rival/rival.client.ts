import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  ExternalServiceError,
  PaymentIndeterminateError,
  ValidationError,
} from '../../../common/errors/domain-errors';
import { RivalConfigService } from './rival-config.service';

/**
 * The one class that talks to Rival — Loadless's payments platform.
 *
 * ## Why the CRM talks to Rival and not to Whish
 *
 * Whish is integrated ONCE, inside Rival. The CRM is a Rival "company": it
 * holds a `tsk_…` API key, creates payments and withdrawals against Rival's
 * merchant API, and Rival owns the provider relationship — the collect page,
 * the callbacks, the reconciliation against Whish, and the operator who
 * approves money out. The `oxshare-psp-portal` has worked this way since
 * before this CRM existed; this client is that integration, in this codebase.
 *
 * HTTP only: no Drizzle, no money decisions, no state. Amounts cross this
 * boundary as decimal strings and are quantised to Rival's 2dp scale here —
 * the caller keeps NUMERIC(28,8); Rival's schema rejects more than 2 fractional
 * digits on money in.
 *
 * ## The error taxonomy, mapped at this seam
 *
 * Rival's envelope is `{success, statusCode, data}` /
 * `{success: false, error: {code, message, details}}`. Its stable codes map
 * onto this codebase's domain errors HERE, so no caller ever branches on a
 * Rival string:
 *
 *   WHISH_PENDING (502)  → PaymentIndeterminateError — Rival asked Whish and
 *                          got no usable answer. The deposit may exist. Callers
 *                          keep the row pending; the poller resolves it.
 *   NO_COMMISSION_RULE   → ValidationError, operator-actionable: the company's
 *                          commission rule at Rival does not cover this amount.
 *                          Nothing was created — Rival pre-checks before minting.
 *   VALIDATION_ERROR     → ValidationError, with Rival's message (it is written
 *                          for integrators and safe to surface).
 *   UNAUTHORIZED/FORBIDDEN → ValidationError naming the settings screen — the
 *                          key was rejected, and the person who can fix that is
 *                          an operator, not the client.
 *   WRITE_CONFLICT (409) → documented retry-safe; retried once here, then
 *                          surfaced as ExternalServiceError.
 *   anything 5xx / WHISH_ERROR / network / timeout on a READ
 *                        → ExternalServiceError (502: Rival is down, we are not).
 *
 * ⚠️ A timeout on a WRITE is the one case that is never a plain failure:
 * `createWithdrawal` may have created the withdrawal and lost the response.
 * That maps to PaymentIndeterminateError, and `RivalWithdrawalsService` holds
 * its claim rather than retrying — Rival's withdrawal create has NO idempotency
 * key, so a blind retry is a double payout.
 */

/**
 * The scale Rival settles at, and the ONLY place that number lives.
 *
 * It was an anonymous `2` inside two quantise helpers. That mattered more than
 * a magic number usually does: the CRM stores NUMERIC(28,8) and an operator can
 * set a currency to as many as 8 display decimals, so the difference between
 * what the CRM can hold and what this rail can send is a real, configurable
 * gap — and nothing named it, so nothing could check it.
 *
 * Exported so `PaymentGateways.payoutScale` can answer for this rail and the
 * withdrawal door can refuse an amount it could never pay exactly.
 */
export const RIVAL_MONEY_SCALE = 2;

/** Rival's whish payment object, as `integrations/whish/payments` returns it. */
export interface RivalPayment {
  id: string;
  companyId: string;
  /** Numeric string; the join key inbound events carry as `whish:<externalId>`. */
  externalId: string;
  status: 'PENDING' | 'PAID' | 'FAILED';
  amount: string;
  currency: string;
  invoice: string;
  collectUrl: string | null;
  payerPhoneNumber: string | null;
  transactionId: string | null;
  needsAttention: boolean;
  settlementError: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface RivalWithdrawal {
  id: string;
  amount: string;
  currency: string;
  netAmount: string;
  totalAmount: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'APPROVED';
  externalReference: string | null;
  /** OUR note, set at create — carries `crm:<txId>` for the orphan reconcile. */
  notes: string | null;
  /** RIVAL's operator note — the rejection reason a client should be told. */
  adminNotes: string | null;
  processedAt: string | null;
  createdAt: string;
}

/** What Rival believes our CRM webhook config is — the test-connection read. */
export interface RivalCrmConfig {
  apiUrl: string | null;
  hasApiKey: boolean;
  enabled: boolean;
}

interface RivalEnvelope<T> {
  success: boolean;
  statusCode: number;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/** Rival's list envelope nests a second level: `data: { data: [...], meta }`. */
interface RivalList<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export class RivalNotConfiguredError extends ValidationError {
  constructor() {
    super(
      'Rival is not configured on this deployment. Set the base URL and API key in ' +
        'Settings → Payments.',
    );
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class RivalClient {
  private readonly logger = new Logger(RivalClient.name);

  constructor(private readonly config: RivalConfigService) {}

  async createWhishPayment(input: {
    amount: string;
    currency: string;
    invoice: string;
    idempotencyKey: string;
    /**
     * OPTIONAL, matching Rival's schema — and Rival REFUSES a localhost or
     * loopback value here (its rule is measured against live Whish, which
     * 403s such redirects). Callers omit these when the portal address is not
     * payer-reachable (`payer-reachable-url.ts`); Rival then serves its own
     * platform result pages, and settlement never depended on the redirect.
     */
    successRedirectUrl?: string;
    failureRedirectUrl?: string;
  }): Promise<RivalPayment> {
    return this.request<RivalPayment>('POST', '/integrations/whish/payments', {
      body: {
        amount: quantiseIn(input.amount),
        currency: input.currency,
        invoice: input.invoice,
        idempotencyKey: input.idempotencyKey,
        ...(input.successRedirectUrl ? { successRedirectUrl: input.successRedirectUrl } : {}),
        ...(input.failureRedirectUrl ? { failureRedirectUrl: input.failureRedirectUrl } : {}),
      },
      // A create that timed out may still have minted a payment; the
      // idempotencyKey makes a later replay converge, but THIS call cannot
      // claim success or failure.
      indeterminateOnNoAnswer: true,
    });
  }

  /** Rival's stored state — cheap, no upstream call. */
  async getWhishPayment(externalId: string): Promise<RivalPayment> {
    return this.request<RivalPayment>('GET', `/integrations/whish/payments/${externalId}`, {});
  }

  /** Forces Rival to re-ask Whish — the missed-callback recovery. */
  async refreshWhishPayment(externalId: string): Promise<RivalPayment> {
    return this.request<RivalPayment>(
      'POST',
      `/integrations/whish/payments/${externalId}/refresh`,
      {},
    );
  }

  async createWithdrawal(input: {
    amount: string;
    currency: string;
    notes: string;
    /** Rival's payout type for the channel (0168) — `RIVAL_PAYOUT_METHODS`. */
    method: 'WISH';
    recipientName: string;
    recipientPhone: string;
  }): Promise<RivalWithdrawal> {
    return this.request<RivalWithdrawal>('POST', '/company/withdrawals', {
      body: {
        // Money OUT: rounded DOWN if anything sub-cent survived — never ask
        // Rival to pay more than the CRM debited.
        amount: quantiseOut(input.amount),
        currency: input.currency,
        notes: input.notes,
        payout: {
          method: input.method,
          recipientName: input.recipientName,
          recipientPhone: input.recipientPhone,
        },
      },
      indeterminateOnNoAnswer: true,
    });
  }

  async getWithdrawal(id: string): Promise<RivalWithdrawal> {
    return this.request<RivalWithdrawal>('GET', `/company/withdrawals/${id}`, {});
  }

  async cancelWithdrawal(id: string): Promise<RivalWithdrawal> {
    /*
     * NOT indeterminate on timeout, deliberately: a cancel that may or may not
     * have landed is resolved by reading the withdrawal back, and the caller
     * treats "still PENDING at Rival" as cancel-failed. Unlike create, a
     * replayed cancel of an already-cancelled row is a 409 the caller maps.
     */
    return this.request<RivalWithdrawal>('POST', `/company/withdrawals/${id}/cancel`, {
      body: {},
    });
  }

  /**
   * Rival's PENDING withdrawals — the orphan-adoption scan. The reconciler
   * matches our `crm:<txId>` note against rows a timed-out create may have
   * made without telling us.
   */
  async listPendingWithdrawals(): Promise<RivalWithdrawal[]> {
    const page = await this.request<RivalList<RivalWithdrawal>>(
      'GET',
      '/company/withdrawals?status=PENDING&pageSize=100',
      {},
    );
    return page.data;
  }

  /**
   * The test-connection read. Chosen over `/health` because health is
   * unauthenticated — it proves reachability and says nothing about the key.
   * This validates the key AND returns what Rival believes our webhook config
   * is, which the settings screen shows beside what we minted.
   */
  async getCrmConfig(): Promise<RivalCrmConfig> {
    return this.request<RivalCrmConfig>('GET', '/company/crm/config', {});
  }

  /* ── transport ─────────────────────────────────────────────────────────── */

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: Record<string, unknown>; indeterminateOnNoAnswer?: boolean },
    isRetry = false,
  ): Promise<T> {
    const config = await this.config.resolve();
    if (!config) throw new RivalNotConfiguredError();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': 'OXShare-CRM/1.0 (https://oxshare.com; support@oxshare.com)',
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      // No answer at all. Logged without the body (amounts, references); the
      // path locates it. The key lives in a header and never nears a log line.
      this.logger.error(
        `Rival ${method} ${path} could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (options.indeterminateOnNoAnswer) {
        throw new PaymentIndeterminateError(
          'The payment platform did not answer. The operation may or may not have been ' +
            'recorded — it will be reconciled, do not retry blindly.',
        );
      }
      throw new ExternalServiceError('The payment platform could not be reached.');
    } finally {
      clearTimeout(timeout);
    }

    /*
     * Read the body FIRST: Rival's envelope carries the error code even on
     * non-2xx, and the code — not the status — is what maps to a domain error.
     * Read defensively; a proxy's HTML error page must not turn a refusal into
     * an unhandled throw on a money path.
     */
    let envelope: RivalEnvelope<T> | null = null;
    try {
      envelope = (await response.json()) as RivalEnvelope<T>;
    } catch {
      // Non-JSON answer — a proxy or a crash page. Fall through to status
      // handling with no code.
    }

    if (envelope?.success && envelope.data !== undefined) {
      return envelope.data;
    }

    const code = envelope?.error?.code;
    const message = envelope?.error?.message ?? `HTTP ${response.status} ${response.statusText}`;

    switch (code) {
      case 'WHISH_PENDING':
        throw new PaymentIndeterminateError(
          'The payment provider gave no usable answer; the payment state is unknown and will ' +
            'be reconciled.',
          detailsOf(envelope),
        );
      case 'NO_COMMISSION_RULE':
        throw new ValidationError(
          'The payment platform has no commission rule covering this amount — the deposit ' +
            'method is misconfigured on the Rival side. Nothing was created.',
        );
      case 'VALIDATION_ERROR':
        throw new ValidationError(message, detailsOf(envelope));
      case 'UNAUTHORIZED':
      case 'FORBIDDEN':
        this.logger.error(`Rival ${method} ${path} rejected the API key (${code}).`);
        throw new ValidationError(
          'The payment platform rejected our credentials. Check the Rival API key in ' +
            'Settings → Payments.',
        );
      case 'INSUFFICIENT_BALANCE':
        // Only reachable on money-out: OxShare's Rival wallet cannot cover it.
        throw new ValidationError(
          'The payment platform reports insufficient company balance for this payout.',
          detailsOf(envelope),
        );
      case 'WRITE_CONFLICT':
        // Documented always-retry-safe. Once, here; twice is a real problem.
        if (!isRetry) return this.request<T>(method, path, options, true);
        throw new ExternalServiceError('The payment platform kept refusing with a write conflict.');
      case 'NOT_FOUND':
        throw new ValidationError('The payment platform does not know this reference.', {
          rivalCode: code,
        });
      default: {
        this.logger.error(
          `Rival ${method} ${path} answered HTTP ${response.status}` +
            (code ? ` (${code})` : '') +
            `: ${truncate(message)}`,
        );
        if (options.indeterminateOnNoAnswer && response.status >= 500) {
          // A 5xx on a write: Rival may have acted before failing to answer.
          throw new PaymentIndeterminateError(
            'The payment platform failed mid-operation; the result is unknown and will be ' +
              'reconciled.',
          );
        }
        throw new ExternalServiceError('The payment platform refused the request.');
      }
    }
  }
}

/**
 * Money IN: REFUSE anything Rival cannot collect exactly — symmetrically with
 * `quantiseOut`.
 *
 * This rounded to NEAREST, which is worse than it sounds on a deposit. The link
 * is created at the rounded figure while the wallet is later credited
 * `tx.amount`, so the client pays one number and is credited another — and
 * because the rounding is half-UP rather than down, the CRM can credit MORE
 * than was collected, with the broker paying the difference every time.
 *
 * ## Why "never reject money-in" does not apply here
 *
 * Rival's own schemas quantise an incoming amount rather than rejecting it, and
 * give the reason: *"the deposit already happened at the provider, so a 400 here
 * would strand real money."* That is right — for INGESTING a payment somebody
 * has already made.
 *
 * This is the opposite moment. `createWhishPayment` is the only caller and it
 * CREATES the link: nothing has been paid, so there is nothing to strand, and
 * refusing costs a client one corrected amount instead of a permanent
 * discrepancy between what they paid and what they hold.
 */
function quantiseIn(amount: string): string {
  const value = new Decimal(amount);
  if (value.decimalPlaces() > RIVAL_MONEY_SCALE) {
    throw new ValidationError(
      `The payment platform collects to ${RIVAL_MONEY_SCALE} decimal places and cannot take ` +
        `${amount} exactly. Crediting a different figure than the client pays is refused.`,
    );
  }
  return value.toFixed(RIVAL_MONEY_SCALE);
}

/**
 * Money OUT: REFUSE anything Rival cannot send exactly.
 *
 * This used to round DOWN, on the reasoning that we must never ask Rival to pay
 * more than the CRM debited. That half was right and still holds — but rounding
 * down silently KEPT the difference: the client was debited 50.12345679 and
 * paid 50.12, with no refund and no record. Under a cent each time, and it
 * scales.
 *
 * `requestWithdrawal` now refuses an over-precise amount at the door, so in
 * normal operation nothing reaches here that needs quantising. That is exactly
 * why this must throw rather than round: a value arriving here with more places
 * than Rival can send means the door check was BYPASSED or is WRONG — a new
 * rail, a currency reconfigured to more decimals than Rival supports, a row
 * created before the rule existed — and every one of those is a configuration
 * problem a person should see, not a sub-cent rounding a person never will.
 *
 * `submitApproved` turns this into a definite refusal: the claim is cleared,
 * the row is flagged with the reason, and the approvers are told. Loud and
 * recoverable, which is what silent flooring was not.
 */
function quantiseOut(amount: string): string {
  const value = new Decimal(amount);
  if (value.decimalPlaces() > RIVAL_MONEY_SCALE) {
    throw new ValidationError(
      `The payment platform settles to ${RIVAL_MONEY_SCALE} decimal places and cannot send ` +
        `${amount} exactly. Paying the rounded amount would keep the difference from the ` +
        'client, so this payout is refused until the amount is corrected.',
    );
  }
  return value.toFixed(RIVAL_MONEY_SCALE);
}

/** Rival's `details` is written for integrators; safe to carry, never required. */
function detailsOf(envelope: RivalEnvelope<unknown> | null): Record<string, unknown> | undefined {
  const details = envelope?.error?.details;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : undefined;
}

function truncate(text: string): string {
  return text.slice(0, 500).replace(/\s+/g, ' ').trim();
}
