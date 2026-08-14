import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ExternalServiceError,
  PaymentIndeterminateError,
  ValidationError,
} from '../../../common/errors/domain-errors';

export interface Mt5Group {
  name: string;
  currency: string;
  leverageDefault: number;
}

export interface Mt5CreatedAccount {
  login: number;
  group: string;
  leverage: number;
  currency: string;
  /** Returned ONCE by MT5. Deliver it and do not store it. */
  masterPassword: string;
  investorPassword: string;
}

export interface Mt5AccountSnapshot {
  login: number;
  group: string;
  currency: string;
  leverage: number;
  balance: string;
  equity: string;
  credit: string;
  margin: string;
  marginFree: string;
  marginLevel: string | null;
}

export interface Mt5BalanceResult {
  dealId: number;
  /** True when this idempotency key had already run — same deal, not a new one. */
  replayed: boolean;
}

/**
 * The CRM's client for the MT5 bridge.
 *
 * The bridge is a Windows service wrapping the Manager API, which cannot be
 * called from Node at all (ARCHITECTURE §3.1). This is the only place in the
 * backend that knows its address, and nothing else should call it directly.
 *
 * ── Every write carries an idempotency key, and the CALLER owns it ──────────
 *
 * `DealerBalance` on the MT5 side is not idempotent: a retry after a timeout
 * credits a client twice. The bridge defends against that with a durable key
 * store, but only if the key is STABLE across retries — which means it has to
 * come from something the CRM already persists, like the transaction id, and
 * never from `randomUUID()` at the call site. A fresh key per attempt is exactly
 * equivalent to having no protection at all.
 *
 * ── An unknown outcome is its own error type ───────────────────────────────
 *
 * A TIMEOUT on a balance operation means MT5 may or may not have posted the
 * deal. That raises `PaymentIndeterminateError` — the same type the payment
 * gateways use for "the provider did not say whether it did" — rather than a
 * plain failure, because the one thing the caller must not do is assume nothing
 * happened and retry with a fresh key.
 *
 * That applies to WRITES only. A timed-out GET changed nothing and raises an
 * ordinary `ExternalServiceError`; see `request()` for why the distinction is
 * taken from the HTTP method rather than from a caller-supplied flag, and for
 * the client-facing screen that made it matter.
 */
@Injectable()
export class Mt5BridgeClient {
  private readonly logger = new Logger(Mt5BridgeClient.name);

  constructor(private readonly config: ConfigService) {}

  /** True when the bridge is configured at all. */
  get isConfigured(): boolean {
    return Boolean(this.config.get<string>('MT5_BRIDGE_URL'));
  }

  async listGroups(): Promise<Mt5Group[]> {
    return await this.request<Mt5Group[]>('GET', '/groups');
  }

  async createAccount(input: {
    group: string;
    name: string;
    email: string;
    country?: string;
    phone?: string;
    leverage?: number;
    /** The CRM's client id, carried into MT5's comment so rows trace both ways. */
    externalId: string;
  }): Promise<Mt5CreatedAccount> {
    return await this.request<Mt5CreatedAccount>('POST', '/accounts', input);
  }

  async getAccount(login: string): Promise<Mt5AccountSnapshot | null> {
    try {
      return await this.request<Mt5AccountSnapshot>('GET', `/accounts/${login}`);
    } catch (error) {
      // "No such account" is an ordinary answer to a lookup, not a failure.
      if (error instanceof ExternalServiceError && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Deposit to or withdraw from a trading account.
   *
   * @param idempotencyKey MUST be stable across retries of the same logical
   * operation — derive it from the transaction id, never generate a new one.
   */
  async balance(input: {
    login: string;
    amount: string;
    type: 'balance' | 'credit';
    comment: string;
    idempotencyKey: string;
  }): Promise<Mt5BalanceResult> {
    if (!input.idempotencyKey) {
      throw new ValidationError('An MT5 balance operation requires an idempotency key.');
    }

    return await this.request<Mt5BalanceResult>('POST', `/accounts/${input.login}/balance`, {
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      type: input.type === 'credit' ? 1 : 0,
      comment: input.comment,
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const baseUrl = this.config.get<string>('MT5_BRIDGE_URL');
    const apiKey = this.config.get<string>('MT5_BRIDGE_API_KEY');

    if (!baseUrl || !apiKey) {
      /*
       * A stated failure, not a crash and not a silent no-op.
       *
       * An unconfigured bridge is a deployment state, not a bug in the caller —
       * the CRM is expected to run without one during development. What it must
       * never do is pretend an account was created.
       */
      throw new ExternalServiceError(
        'The MT5 bridge is not configured on this server (MT5_BRIDGE_URL / MT5_BRIDGE_API_KEY).',
      );
    }

    /*
     * ── A READ is safe, and is treated as one ─────────────────────────────
     *
     * Derived from the HTTP method rather than passed in by the caller, because
     * a flag can be forgotten and the direction it fails in matters: a write
     * mistakenly marked safe is a double credit. GET and HEAD cannot have
     * changed anything on the MT5 server, so a timeout on one is an ordinary
     * unreachable-service failure with nothing to reconcile.
     *
     * This was not a distinction until a client-facing screen started reading
     * `GET /accounts/{login}`. Before that every call through here was an admin
     * write, so treating all of them as possibly-committed cost nothing. It
     * costs something now: a timed-out READ was answering the portal with
     * PAYMENT_INDETERMINATE, which tells an operator to reconcile a client's
     * balance against MT5 because somebody opened an account page.
     */
    const safe = method === 'GET' || method === 'HEAD';

    /*
     * Reads get their own, much shorter budget.
     *
     * 30 seconds is calibrated for a balance write, where waiting beats not
     * knowing whether money moved. A snapshot read has the opposite trade-off:
     * nobody is served by a page that hangs for 30 seconds and then says the
     * server could not be reached, and the answer is stale by then anyway.
     *
     * TEN seconds, not five, and the number is measured rather than guessed.
     * Against this broker's Web API a healthy `GET /accounts/{login}` takes
     * ~2.5s and `GET /groups` ~4.9s — every MT5 call is a round trip to the
     * broker, not a local lookup. A 5s budget would sit inside the normal range
     * of a call that WORKS, which is the worst place to put a timeout: it turns
     * an ordinary slow response into a reported outage, and the retry adds load
     * to the server it just gave up on.
     */
    const timeout = safe
      ? Number(this.config.get('MT5_BRIDGE_READ_TIMEOUT_MS') ?? 10_000)
      : Number(this.config.get('MT5_BRIDGE_TIMEOUT_MS') ?? 30_000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'X-Bridge-Key': apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        this.logger.error(
          `MT5 bridge ${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`,
        );
        throw new ExternalServiceError(
          `MT5 bridge returned ${response.status} for ${method} ${path}: ${text.slice(0, 200)}`,
        );
      }

      return (text ? JSON.parse(text) : null) as T;
    } catch (error) {
      if (error instanceof ExternalServiceError) throw error;

      /*
       * A timeout on a BALANCE call is the dangerous one, and the message says
       * so rather than reading as an ordinary network blip. MT5 may have
       * committed the deal; the caller must reconcile rather than retry with a
       * fresh key.
       */
      const aborted = error instanceof Error && error.name === 'AbortError';
      if (aborted && safe) {
        /*
         * A read that timed out changed nothing, so there is nothing to
         * reconcile and the caller may simply try again. Saying INDETERMINATE
         * here would be a false alarm about a client's money, and false alarms
         * about money are how the real ones stop being read.
         */
        throw new ExternalServiceError(
          `MT5 bridge timed out after ${timeout}ms on ${method} ${path}. Nothing was changed.`,
        );
      }

      if (aborted) {
        /*
         * INDETERMINATE, not failed — the same distinction the payment gateways
         * make, for the same reason. A timeout on a balance operation means MT5
         * may well have posted the deal and the response was lost on the way
         * back. Reporting it as a plain failure invites the caller to retry with
         * a fresh idempotency key, which is precisely how a client gets credited
         * twice.
         */
        throw new PaymentIndeterminateError(
          `MT5 bridge timed out after ${timeout}ms on ${method} ${path}. ` +
            'If this was a balance operation its outcome is UNKNOWN — reconcile against the MT5 ' +
            'deal history before retrying, and reuse the SAME idempotency key when you do.',
        );
      }

      throw new ExternalServiceError(
        `MT5 bridge unreachable for ${method} ${path}: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
