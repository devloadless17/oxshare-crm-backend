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
  /*
   * MT5's own trading terms on the group, reported by bridges from 26 Sep 2026
   * on. ABSENT or null from an older bridge, which the group sync reads as "not
   * reported" and leaves the stored values alone. Checked field by field on
   * the way in — see `common/mt5-group-terms.ts`.
   */
  marginCall?: string | null;
  marginStopOut?: string | null;
  marginStopOutMode?: string | null;
  commissions?: unknown;
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

/**
 * Fresh credentials for an account whose owner lost theirs.
 *
 * Both passwords, always — the bridge rotates the pair together because a
 * client who has lost one cannot say which. Returned ONCE, exactly like
 * `Mt5CreatedAccount`: deliver it and store nothing.
 */
export interface Mt5ResetPasswords {
  login: number;
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
 * One OPEN position, read live from MT5.
 *
 * `profit` is the FLOATING result and moves on every tick, which is why nothing
 * here is stored: a persisted copy is stale the moment it is written, and would
 * be shown to a client wearing the same label as a live figure.
 *
 * `commission` is NULL on the Manager protocol, which carries commission on
 * deals rather than on the open position. Null means "this protocol will not
 * say" and is not interchangeable with `'0'`, which would claim a fee-free
 * position.
 *
 * `stopLoss` and `takeProfit` are null when unset — MT5 stores an absent stop as
 * the price 0, and a stop loss rendered as `0.00` reads as an order to close at
 * zero.
 */
export interface Mt5Position {
  ticket: number;
  login: number;
  symbol: string;
  /** MT5's numeric side: 0 buy, 1 sell. Passed through, never re-encoded. */
  action: number;
  volume: string;
  priceOpen: string;
  priceCurrent: string;
  stopLoss: string | null;
  takeProfit: string | null;
  profit: string;
  swap: string;
  commission: string | null;
  comment: string;
  openedAt: string;
}

/**
 * What the bridge did with a request to watch some accounts live.
 *
 * `refused` is not an error — see `Mt5BridgeClient.watchLive`. A login lands
 * there when the bridge's live round is already at capacity, and the correct
 * response is to leave that screen polling.
 *
 * `ttlSeconds` is the bridge's OWN lease length rather than a constant repeated
 * here, so the heartbeat is paced against what the bridge actually enforces and
 * the two cannot drift apart across a deploy.
 */
export interface Mt5LiveWatch {
  accepted: string[];
  refused: string[];
  ttlSeconds: number;
}

/**
 * The bridge's delivery queue, as it reports it.
 *
 * `failing` is deliberately distinct from `pending`: a pending row may simply
 * be new and about to go out, while a failing one has already been attempted
 * and rejected. Alerting on `pending` cries wolf on a healthy busy system;
 * alerting on `failing` does not.
 */
export interface BridgeOutbox {
  summary: { total: number; delivered: number; pending: number; failing: number };
  rows: {
    dealId: string;
    source: string;
    attempts: number;
    nextAttempt: string;
    deliveredAt: string | null;
    lastError: string | null;
    createdAt: string;
  }[];
}

/**
 * Balance operations the bridge has run.
 *
 * `amount` is a decimal STRING all the way from MT5 — §6.1 applies here as
 * everywhere, and this one is read by a human checking a client's balance.
 * `stuck` counts rows with no `completedAt`: money in an unknown state.
 */
export interface BridgeOperations {
  summary: { total: number; completed: number; stuck: number };
  rows: {
    idempotencyKey: string;
    login: string;
    amount: string;
    type: string;
    dealId: string | null;
    startedAt: string;
    completedAt: string | null;
  }[];
}

/** The tail of the bridge's log file. `exists: false` is a normal first-run answer. */
export interface BridgeLogs {
  file: string;
  exists: boolean;
  matched?: number;
  lines: string[];
}

/** One closed deal, as the bridge reports it. Amounts are decimal strings. */
export interface Mt5Deal {
  dealId: number;
  login: number;
  orderId: number;
  positionId: number;
  symbol: string;
  action: number;
  entry: number;
  volume: string;
  price: string;
  profit: string;
  commission: string;
  swap: string;
  comment: string;
  dealtAt: string;
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

  /**
   * Rotate BOTH passwords on an existing account.
   *
   * NOT retried and not idempotent — every call mints a new pair and kills the
   * previous one, so a retry after a timeout would issue a second set and leave
   * the client holding an email for credentials that no longer work. `request`
   * does not retry, and no caller here should add one: on a timeout the honest
   * answer is "we do not know", which the service turns into a message telling
   * the client to try again rather than a silent second reset.
   *
   * Returns null for an unknown login, matching `getAccount`.
   */
  async resetPasswords(login: string): Promise<Mt5ResetPasswords | null> {
    try {
      return await this.request<Mt5ResetPasswords>('POST', `/accounts/${login}/password`);
    } catch (error) {
      if (error instanceof ExternalServiceError && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Change the account HOLDER's name as MT5 records it.
   *
   * The bridge does a read-modify-write, so every field this does not name
   * survives. Returns false for an unknown login.
   */
  async updateName(login: string, name: string): Promise<boolean> {
    try {
      await this.request<{ login: number; name: string }>('PATCH', `/accounts/${login}`, { name });
      return true;
    } catch (error) {
      if (error instanceof ExternalServiceError && error.message.includes('404')) {
        return false;
      }
      throw error;
    }
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
   * Every OPEN position on one login, with live floating P/L.
   *
   * An empty array is a real answer — the account has nothing open — and is not
   * distinguishable from an unknown login, deliberately: the bridge treats both
   * the same because the caller has already established the account exists by
   * reading the login out of its own table to build this call.
   */
  async getPositions(login: string): Promise<Mt5Position[]> {
    return await this.request<Mt5Position[]>('GET', `/accounts/${login}/positions`);
  }

  /**
   * Tell the bridge somebody is LOOKING at these accounts.
   *
   * ## This is a lease, and the caller has to keep renewing it
   *
   * Nothing tells the bridge a browser tab closed — a shut laptop and a
   * backgrounded phone both send exactly nothing — so a watch EXPIRES unless it
   * is renewed inside `ttlSeconds`. That expiry is the only thing bounding what
   * the bridge's live loop reads, and a subscription that had to be cancelled
   * instead would leak a watched account on every abandoned tab.
   *
   * ## `refused` is an ordinary answer, not an error
   *
   * The bridge caps how many accounts one live round may cover, because every
   * read in that round takes the single MT5 session lock and a round that
   * cannot finish inside its own interval starves reconnects. Past the cap a
   * NEW login is refused so that viewers already being served keep being
   * served. A refused caller has lost nothing: their screen keeps reading
   * `/accounts/:id/live` on its own, which is where every screen was before
   * this existed.
   *
   * So a caller must branch on the answer rather than assuming acceptance, and
   * must treat a bridge that is down the same way — the live path is an
   * enhancement over polling, never a replacement for it.
   */
  async watchLive(logins: string[]): Promise<Mt5LiveWatch> {
    return await this.request<Mt5LiveWatch>('POST', '/live/watch', { logins });
  }

  /**
   * Closed deals for ONE login in a window, read live from the trading server.
   *
   * ## Nothing in the CRM calls this any more
   *
   * The client's account history used to come through here. It is served from
   * `mt5_deals` now — same deals by ticket, reaching further back than MT5 will
   * answer for in one request, and available while this bridge is down. See
   * `TradingService.historyMine` for the full reasoning.
   *
   * Kept because it is the only way to ask MT5 directly, which is what you want
   * when the question is "did ingestion miss something": a window read through
   * here and the same window read from `mt5_deals` should agree, and where they
   * do not, this one is the authority. Deleting it would leave that comparison
   * impossible to make.
   *
   * The bridge REFUSES a window over 31 days rather than truncating, because
   * MT5 silently caps a larger request and would hand back a partial set that
   * looks complete.
   */
  async getAccountDeals(login: string, from: Date, to: Date): Promise<Mt5Deal[]> {
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    return await this.request<Mt5Deal[]>('GET', `/accounts/${login}/deals?${params.toString()}`);
  }

  /**
   * The bridge's own DELIVERY QUEUE — has each deal reached us, and when.
   *
   * Diagnostic, not a data source. The deals themselves live in `mt5_deals`
   * once ingested; this answers the different question of whether ingestion is
   * working, which `mt5_deals` cannot — a deal that never arrived leaves no row
   * to notice the absence of.
   *
   * `pending` narrows to rows the bridge has not delivered. On a healthy system
   * that is empty or briefly non-empty; a persistent backlog means the CRM is
   * rejecting deals, and `lastError` on each row says why.
   */
  async getOutbox(options: { pending?: boolean; limit?: number } = {}): Promise<BridgeOutbox> {
    const params = new URLSearchParams();
    if (options.pending) params.set('pending', 'true');
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return await this.request<BridgeOutbox>('GET', `/admin/outbox${query ? `?${query}` : ''}`);
  }

  /**
   * Balance operations the bridge has executed, and — the point of this — the
   * ones it CLAIMED and never confirmed.
   *
   * A row with `completedAt: null` is an operation where the bridge told MT5 to
   * move money and never learned whether it did. The key stays claimed on
   * purpose so a retry cannot double-credit, which also means it stays that way
   * until a person reconciles it against MT5's own deal history.
   *
   * `stuck: true` is therefore not a convenience filter, it is the alert. Any
   * row it returns is money in an unknown state.
   */
  async getBalanceOperations(
    options: { stuck?: boolean; limit?: number } = {},
  ): Promise<BridgeOperations> {
    const params = new URLSearchParams();
    if (options.stuck) params.set('stuck', 'true');
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return await this.request<BridgeOperations>(
      'GET',
      `/admin/operations${query ? `?${query}` : ''}`,
    );
  }

  /** The tail of the bridge's log for today, optionally filtered. */
  async getLogs(options: { lines?: number; contains?: string } = {}): Promise<BridgeLogs> {
    const params = new URLSearchParams();
    if (options.lines) params.set('lines', String(options.lines));
    if (options.contains) params.set('contains', options.contains);
    const query = params.toString();
    return await this.request<BridgeLogs>('GET', `/admin/logs${query ? `?${query}` : ''}`);
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
     * Every MT5 call is a round trip to the broker, not a local lookup, and a
     * budget that sits inside the normal range of a call that WORKS is the worst
     * place to put a timeout: it turns an ordinary slow response into a reported
     * outage, and the retry adds load to the server it just gave up on.
     *
     * ── The measurements, and a correction ────────────────────────────────
     *
     * This said `GET /accounts/{login}` takes ~2.5s and `GET /groups` ~4.9s.
     * Re-measured against the live bridge on 3 Sep 2026, an account read is
     * ~90–490ms (median ~180ms) and a positions read ~105–500ms — an order of
     * magnitude faster than the figure recorded here, which disagreed with the
     * ~285ms in `BridgeOptions` and sent capacity planning in two directions.
     *
     * The ten-second budget STAYS. It is sized for the tail, not the median: the
     * same reads were recorded at 5.4s under contention with a sweep, and that is
     * the case a timeout exists for. What changes is that nobody should plan
     * throughput off the 2.5s figure — `GET /admin/live` on the bridge reports
     * the real per-read cost continuously.
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
