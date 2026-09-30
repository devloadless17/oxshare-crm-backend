import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertPublicOutboundHost } from '../../../../common/security/outbound-host';
import { PaymentProviderExchangesStore } from '../../../../store/payment-provider-exchanges.store';
import { countOf, objectOf, parseLossless, textOf } from './threepay-json';
import { SlidingWindowLimit, busy } from './threepay-rate-limit';
import { ThreePayConfigService, type ThreePayConfig } from './threepay-config.service';

/**
 * THE ONE CLASS THAT TALKS TO 3PAY (0174) — HTTP only: no money, no database.
 *
 * ## Every answer becomes one of a few meanings
 *
 * The callers (the adapter, the payout rail) must never branch on 3pay's
 * strings, so each response is classified here once:
 *
 *   ok           a 2xx whose JSON we could read.
 *   credentials  401 — the key or secret is wrong. Nothing was done.
 *   ip           403 — this server's address is not on 3pay's allowlist.
 *                Nothing was done.
 *   refused      400 / 404 / 409 / other 4xx — a definite no. Nothing was done.
 *   server       5xx — 3pay may have acted before failing (its own guide: a
 *                payout that answers 500 may still have been broadcast).
 *   unreachable  no answer: a network error or our timeout. It may have acted.
 *   unreadable   a 2xx we cannot read. It DID act, most likely.
 *   busy         429, or our own pacing (`threepay-rate-limit.ts`) —
 *                thrown as the contract's `ProviderBusyError`. Nothing sent.
 *
 * The last three "may have acted" kinds are why a payout is never retried by
 * this class: that decision is the core's, from 3pay's own records.
 *
 * ## Numbers
 *
 * Responses are parsed losslessly (`threepay-json.ts`): every amount arrives as
 * the exact text 3pay sent. Requests carry amounts as exact number literals.
 *
 * ## Timeouts
 *
 * Reads and link creation: 15 s. A withdrawal: 60 s — 3pay holds the request
 * open while it polls the chain for up to 40 s (guide §05), and cutting it
 * short would turn a payout that completed into an "unknown".
 *
 * ## The host is checked at CALL time too
 *
 * The console refuses a base URL on a private address when it is saved. A
 * public name can later RESOLVE to a private one (DNS rebinding), so the check
 * runs again before calls, cached for a minute.
 */

export type ThreePayCall = 'read' | 'create' | 'payout';

export type ThreePayFailure =
  'not_configured' | 'credentials' | 'ip' | 'refused' | 'server' | 'unreachable' | 'unreadable';

/** A 3pay call that did not return a readable success. `kind` is the only thing callers branch on. */
export class ThreePayRequestError extends Error {
  constructor(
    readonly kind: ThreePayFailure,
    message: string,
    readonly status: number | null = null,
    /** 3pay's own machine code (`error`), when it sent one. */
    readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = 'ThreePayRequestError';
  }

  /** Did 3pay DEFINITELY do nothing? False when it may have acted. */
  get definite(): boolean {
    return !['server', 'unreachable', 'unreadable'].includes(this.kind);
  }
}

export interface ThreePayResponse {
  status: number;
  body: Record<string, unknown>;
}

/** One page of a 3pay list, and how many pages there are. */
export interface ThreePayPage {
  items: Record<string, unknown>[];
  totalPages: number;
}

const TIMEOUT_MS: Readonly<Record<ThreePayCall, number>> = {
  read: 15_000,
  create: 15_000,
  payout: 60_000,
};

/** A little under 3pay's own limits (60 reads, 30 links, 30 payouts a minute). */
const PER_MINUTE: Readonly<Record<ThreePayCall, number>> = { read: 55, create: 28, payout: 28 };

/**
 * How long a caller may wait for a slot. A payout never waits: the core counts
 * payouts itself, and one refused here is simply requeued.
 */
const PATIENCE_MS: Readonly<Record<ThreePayCall, number>> = {
  read: 10_000,
  create: 5_000,
  payout: 0,
};

const HOST_CHECK_TTL_MS = 60_000;
/** 3pay's list pages hold at most 100 (guide §6.2). */
export const THREEPAY_PAGE_SIZE = 100;

@Injectable()
export class ThreePayClient {
  private readonly logger = new Logger(ThreePayClient.name);
  private readonly limits: Record<ThreePayCall, SlidingWindowLimit> = {
    read: new SlidingWindowLimit(PER_MINUTE.read),
    create: new SlidingWindowLimit(PER_MINUTE.create),
    payout: new SlidingWindowLimit(PER_MINUTE.payout),
  };
  private hostChecked: { url: string; at: number } | null = null;

  constructor(
    private readonly settings: ThreePayConfigService,
    private readonly config: ConfigService,
    /* Every exchange, kept 90 days (the guide, §10) — 0175. */
    private readonly exchanges: PaymentProviderExchangesStore,
  ) {}

  /** The configuration in force, or a definite refusal: nothing is sent without one. */
  async configured(): Promise<ThreePayConfig> {
    const config = await this.settings.resolve();
    if (!config) {
      throw new ThreePayRequestError(
        'not_configured',
        '3pay is not set up on this deployment (System → Payment providers → 3pay).',
      );
    }
    return config;
  }

  /** `reference`: ours, when the caller knows it — kept with the exchange for finding it later. */
  get(
    path: string,
    query: Record<string, string | undefined> = {},
    reference?: string,
  ): Promise<ThreePayResponse> {
    return this.request('read', 'GET', path, { query, reference });
  }

  /** A POST whose body is already exact JSON text (amounts as number literals). */
  post(
    call: 'create' | 'payout',
    path: string,
    body: string,
    reference?: string,
  ): Promise<ThreePayResponse> {
    return this.request(call, 'POST', path, { body, reference });
  }

  /** One page of `/transaction/list` or `/withdrawal-requests`. */
  async page(
    path: '/transaction/list' | '/withdrawal-requests',
    page: number,
    filters: Record<string, string | undefined>,
  ): Promise<ThreePayPage> {
    const { body } = await this.get(path, {
      ...filters,
      page: String(page),
      limit: String(THREEPAY_PAGE_SIZE),
    });
    const data = body['data'];
    if (!Array.isArray(data)) {
      throw new ThreePayRequestError('unreadable', `3pay ${path} returned no list.`);
    }
    const items = data.map(objectOf).filter((item) => item !== undefined);
    const pagination = objectOf(body['pagination']);
    const totalPages = countOf(pagination?.['totalPages']);
    // No page count: this page is all there is only if it is not full.
    return {
      items,
      totalPages: totalPages ?? (items.length < THREEPAY_PAGE_SIZE ? page : page + 1),
    };
  }

  private async request(
    call: ThreePayCall,
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Record<string, string | undefined>; body?: string; reference?: string },
  ): Promise<ThreePayResponse> {
    const config = await this.configured();
    await this.assertHost(config.baseUrl);
    // Pace BEFORE sending: a refusal here is a definite "nothing was sent".
    await this.limits[call].take(PATIENCE_MS[call]);

    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS[call]);
    const started = Date.now();
    /*
     * What was asked and what came back, whatever came back — the path with its
     * query (no credentials travel there) and the bodies; never the headers,
     * which carry the key and the secret.
     */
    const log = (status: number | null, responseBody: string | null, error?: string) =>
      this.exchanges.record({
        providerCode: 'threepay',
        direction: 'outbound',
        method,
        // The API path as the guide names it (the base URL is configuration), with its query.
        path: `${path}${url.search}`,
        requestBody: options.body ?? null,
        status,
        responseBody,
        error: error ?? null,
        durationMs: Date.now() - started,
        reference: options.reference ?? null,
      });
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method,
        headers: {
          apikey: config.apiKey,
          'x-api-secret': config.apiSecret,
          Accept: 'application/json',
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': 'OXShare-CRM/1.0',
        },
        body: options.body,
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      // No answer — 3pay may or may not have acted. The secret is in a header
      // and never reaches a log line; neither does the body.
      this.logger.warn(`3pay ${method} ${path} got no answer: ${messageOf(error)}`);
      log(null, null, messageOf(error));
      throw new ThreePayRequestError('unreachable', `3pay did not answer (${messageOf(error)}).`);
    } finally {
      clearTimeout(timer);
    }
    log(response.status, text);

    if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get('retry-after'));
      this.limits[call].pause(wait);
      this.logger.warn(`3pay ${method} ${path} answered 429; pausing ${Math.ceil(wait / 1000)}s.`);
      throw busy(wait);
    }

    let body: Record<string, unknown> | undefined;
    try {
      body = objectOf(parseLossless(text));
    } catch {
      body = undefined;
    }
    const ok = response.status >= 200 && response.status < 300;
    if (ok && body && body['success'] !== false) return { status: response.status, body };

    const message = textOf(body?.['message']) ?? `HTTP ${response.status}`;
    const providerCode = textOf(body?.['error']) ?? null;
    const kind: ThreePayFailure = ok
      ? 'unreadable'
      : response.status === 401
        ? 'credentials'
        : response.status === 403
          ? 'ip'
          : response.status >= 500
            ? 'server'
            : 'refused';
    const level = kind === 'refused' ? 'warn' : 'error';
    this.logger[level](
      `3pay ${method} ${path} answered HTTP ${response.status} (${kind}): ${truncate(message)}`,
    );
    throw new ThreePayRequestError(kind, message, response.status, providerCode);
  }

  /** The SSRF guard again at call time (a name may since resolve privately), cached a minute. */
  private async assertHost(baseUrl: string): Promise<void> {
    if (this.hostChecked?.url === baseUrl && Date.now() - this.hostChecked.at < HOST_CHECK_TTL_MS) {
      return;
    }
    const production = this.config.get<string>('NODE_ENV') === 'production';
    if (production && !baseUrl.startsWith('https://')) {
      throw new ThreePayRequestError('not_configured', '3pay’s base URL must use https.');
    }
    try {
      await assertPublicOutboundHost(baseUrl, {
        subject: '3pay · API base URL',
        allowLoopback: !production,
      });
    } catch (error) {
      throw new ThreePayRequestError('not_configured', messageOf(error));
    }
    this.hostChecked = { url: baseUrl, at: Date.now() };
  }
}

/** `Retry-After` in seconds or as a date; a minute when absent; bounded to 1 s – 10 min. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  let ms = 60_000;
  const text = header?.trim() ?? '';
  if (/^\d{1,6}$/.test(text)) ms = Number.parseInt(text, 10) * 1000;
  else if (text) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) ms = at - now;
  }
  return Math.min(Math.max(ms, 1000), 10 * 60_000);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string): string {
  return text.slice(0, 300).replace(/\s+/g, ' ').trim();
}
