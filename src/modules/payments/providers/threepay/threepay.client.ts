import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertPublicOutboundHost } from '../../../../common/security/outbound-host';
import { PaymentProviderExchangesStore } from '../../../../store/payment-provider-exchanges.store';
import {
  amountOf,
  countOf,
  dateOf,
  firstText,
  flagOf,
  loggableBody,
  objectOf,
  parseLossless,
  textOf,
} from './threepay-json';
import {
  RequestBudget,
  budgetReadingOf,
  busy,
  type BudgetReading,
  type BudgetState,
  type ThreePayPriority,
} from './threepay-rate-limit';
import { ThreePayConfigService, type ThreePayConfig } from './threepay-config.service';

/**
 * THE ONE CLASS THAT TALKS TO 3PAY (0174; rebuilt 12 Oct 2026) — HTTP only: no
 * money, no database.
 *
 * ## Which 3pay this is
 *
 * 3pay has published two descriptions of its API that disagree — a PDF guide
 * and docs.3pa-y.com — and its live server (pay.3pa-y.com) follows neither
 * completely: the PATHS are the PDF's, the BEHAVIOUR is the online docs' (the
 * first production deposit was refused for sending `currencyType` in the body,
 * as the PDF says to). Everything here was checked against the live server
 * where it answers without credentials, and reads BOTH documented shapes
 * wherever a reply could not be seen. The backend CLAUDE.md lists what was
 * measured and what is still only documented.
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
 *   busy         429, or our own budget (`threepay-rate-limit.ts`) — thrown as
 *                the contract's `ProviderBusyError`. Nothing sent.
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
 * Reads 15 s; a payment link 20 s (3pay makes a wallet for it); a withdrawal
 * 60 s — 3pay holds the request open while it polls the chain for up to 40 s,
 * and cutting it short would turn a payout that completed into an "unknown".
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

/** One page of a 3pay list, and whether it was the last. */
export interface ThreePayPage {
  items: Record<string, unknown>[];
  last: boolean;
}

/** The two lists 3pay serves: every payment link, and every withdrawal. */
export type ThreePayList = '/transaction/list' | '/withdrawal-requests';

/**
 * 3pay's account as this platform reads it (`/getMerchantDetails`). The reply
 * also carries the account's WEBHOOK SECRET, which is kept in memory for
 * verifying deliveries and never written anywhere.
 */
export interface ThreePayAccount {
  /** `totalAmt`: what can be paid out now. */
  available: string;
  /** `pendingAmt`: locked in withdrawals under way. */
  inFlight?: string;
  /** Withdrawals are sent without a person approving them in 3pay's dashboard… */
  autoWithdraw?: boolean;
  /** …up to this amount. */
  maxAutoWithdraw?: string;
  /** `merchant` | `user` — who carries each fee. */
  depositFeePayer?: string;
  withdrawalFeePayer?: string;
  /** `approved` once 3pay has cleared the account. */
  approval?: string;
  /** Payouts above a threshold are forced to a cold wallet. */
  staticWallet?: boolean;
  webhookSecret?: string;
}

const TIMEOUT_MS: Readonly<Record<ThreePayCall, number>> = {
  read: 15_000,
  create: 20_000,
  payout: 60_000,
};

/** 3pay's windows are fifteen minutes (its `RateLimit-Policy: n;w=900`). */
const WINDOW_MS = 15 * 60_000;

const HOST_CHECK_TTL_MS = 60_000;
/** 3pay's list pages hold at most 100. */
export const THREEPAY_PAGE_SIZE = 100;
/** One list page is reused this long: two channels reconciled in one pass share a read. */
const PAGE_MEMO_MS = 10_000;
/** The account is re-read at most this often for the fee payer and the webhook secret. */
const ACCOUNT_TTL_MS = 15 * 60_000;

@Injectable()
export class ThreePayClient {
  private readonly logger = new Logger(ThreePayClient.name);
  private budgets = freshBudgets();
  private accountFailedAt = 0;
  private hostChecked: { url: string; at: number } | null = null;
  private readonly pages = new Map<string, { at: number; page: ThreePayPage }>();
  private accountRead: { at: number; baseUrl: string; account: ThreePayAccount } | null = null;

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

  /**
   * The settings changed: nothing read under the old ones is kept. The budgets
   * start again too — another account or address has windows of its own, and
   * the first reply's headers say where they stand.
   */
  forget(): void {
    this.budgets = freshBudgets();
    this.pages.clear();
    this.accountRead = null;
    this.accountFailedAt = 0;
    this.hostChecked = null;
  }

  /** `reference`: ours, when the caller knows it — kept with the exchange for finding it later. */
  get(
    path: string,
    query: Record<string, string | undefined> = {},
    options: { reference?: string; priority?: ThreePayPriority } = {},
  ): Promise<ThreePayResponse> {
    return this.request('read', 'GET', path, { query, ...options });
  }

  /** A POST: its fields in the query string, its body already exact JSON text. */
  post(
    call: 'create' | 'payout',
    path: string,
    options: { query?: Record<string, string | undefined>; body?: string; reference?: string },
  ): Promise<ThreePayResponse> {
    return this.request(call, 'POST', path, options);
  }

  /**
   * One page of a list, newest first.
   *
   * 3pay's two lists answer in different shapes, and its two guides describe a
   * third: the rows are `data` itself or `data.docs`, and the page count is
   * `pagination.totalPages`, `totalPages` or absent. Without a count, a page
   * that is not full is the last.
   */
  async page(
    path: ThreePayList,
    page: number,
    filters: Record<string, string | undefined>,
    priority: ThreePayPriority = 'normal',
  ): Promise<ThreePayPage> {
    const query = {
      ...filters,
      // 3pay's own default, stated: a walk stops at the first page older than it needs.
      sortBy: 'createdAt',
      sortOrder: 'desc',
      page: String(page),
      limit: String(THREEPAY_PAGE_SIZE),
    };
    const memoKey = `${path}?${new URLSearchParams(definedOnly(query)).toString()}`;
    const memo = this.pages.get(memoKey);
    if (memo && Date.now() - memo.at < PAGE_MEMO_MS) return memo.page;

    const { body } = await this.get(path, query, { priority });
    const data = body['data'];
    const rows = Array.isArray(data) ? data : objectOf(data)?.['docs'];
    if (!Array.isArray(rows)) {
      throw new ThreePayRequestError('unreadable', `3pay ${path} returned no list.`);
    }
    const items = rows.map(objectOf).filter((item) => item !== undefined);
    const totalPages =
      countOf(objectOf(body['pagination'])?.['totalPages']) ??
      countOf(body['totalPages']) ??
      countOf(objectOf(data)?.['totalPages']);
    const result: ThreePayPage = {
      items,
      last: totalPages !== undefined ? page >= totalPages : items.length < THREEPAY_PAGE_SIZE,
    };
    if (this.pages.size > 50) this.pages.clear();
    this.pages.set(memoKey, { at: Date.now(), page: result });
    return result;
  }

  /**
   * Walk a list from its newest record back to `since`, handing each record to
   * `visit` (which returns true to stop early). Resolves true when everything
   * since then was seen, false when the page cap came first.
   *
   * 3pay's lists take NO date filter (its newer guide says so; `fromDate` is
   * ignored), so the window is ours: the walk ends at the first page whose
   * oldest record is older than `since`. That relies on newest-first order,
   * which is asked for and CHECKED — a list that comes back out of order is
   * read to its last page instead of trusted.
   */
  async walk(
    path: ThreePayList,
    filters: Record<string, string | undefined>,
    options: { since: Date; maxPages: number; priority?: ThreePayPriority },
    visit: (record: Record<string, unknown>) => boolean,
  ): Promise<boolean> {
    let ordered = true;
    let newestSeen = Number.POSITIVE_INFINITY;
    for (let page = 1; page <= options.maxPages; page += 1) {
      const result = await this.page(path, page, filters, options.priority);
      let oldestOnPage = Number.POSITIVE_INFINITY;
      for (const record of result.items) {
        const created = dateOf(record['createdAt'])?.getTime();
        if (created === undefined || created > newestSeen) ordered = false;
        else newestSeen = created;
        if (created !== undefined) oldestOnPage = Math.min(oldestOnPage, created);
        if (visit(record)) return true;
      }
      if (result.last) return true;
      if (ordered && oldestOnPage < options.since.getTime()) return true;
    }
    return false;
  }

  /**
   * 3pay's account. `maxAgeMs` is how old a remembered reading may be: 0 asks
   * now, the default serves what a payout quote or a webhook needs without
   * spending a read each time.
   */
  async account(
    maxAgeMs: number = ACCOUNT_TTL_MS,
    priority: ThreePayPriority = 'normal',
  ): Promise<ThreePayAccount> {
    const config = await this.configured();
    const held = this.accountRead;
    // `0` always asks: two reads in one millisecond must not count as a remembered one.
    if (
      held &&
      maxAgeMs > 0 &&
      held.baseUrl === config.baseUrl &&
      Date.now() - held.at <= maxAgeMs
    ) {
      return held.account;
    }
    let body: Record<string, unknown>;
    try {
      ({ body } = await this.get('/getMerchantDetails', {}, { priority }));
    } catch (error) {
      this.accountFailedAt = Date.now();
      throw error;
    }
    const data = objectOf(body['data']);
    const available = amountOf(data?.['totalAmt']);
    if (!data || available === undefined) {
      this.accountFailedAt = Date.now();
      throw new ThreePayRequestError('unreadable', '3pay did not report a balance.');
    }
    const inFlight = amountOf(data['pendingAmt']);
    const maxAutoWithdraw = amountOf(data['maxAutoWithdrawAmount']);
    const account: ThreePayAccount = {
      available,
      ...(inFlight !== undefined ? { inFlight } : {}),
      autoWithdraw: flagOf(data['autoWithdraw']),
      ...(maxAutoWithdraw !== undefined ? { maxAutoWithdraw } : {}),
      depositFeePayer: textOf(data['depositFeePayer'])?.toLowerCase(),
      withdrawalFeePayer: textOf(data['withdrawalFeePayer'])?.toLowerCase(),
      approval: textOf(data['approved'])?.toLowerCase(),
      staticWallet: flagOf(objectOf(data['staticWallets'])?.['isEnabled']),
      webhookSecret: firstText(data, 'webhookSecret'),
    };
    this.accountRead = { at: Date.now(), baseUrl: config.baseUrl, account };
    return account;
  }

  /**
   * The webhook secret from the last account reading, however old. A delivery
   * must still be verifiable while the read budget is spent: refusing 3pay's
   * own report for want of a read would hold up the credit it announces.
   */
  async rememberedWebhookSecret(): Promise<string | undefined> {
    const config = await this.configured();
    const held = this.accountRead;
    return held && held.baseUrl === config.baseUrl ? held.account.webhookSecret : undefined;
  }

  /**
   * Each request allowance as it stands: the limit, what is left, and whether
   * 3pay has STATED it to this process (until a call of that kind is answered,
   * the limit is the one measured on 12 Oct 2026).
   */
  limits(): Record<'read' | 'create' | 'payout', BudgetState> {
    return {
      read: this.budgets.read.state(),
      create: this.budgets.create.state(),
      payout: this.budgets.payout.state(),
    };
  }

  /** Did a read of the account fail in the last `ms`? A delivery then does not jump the queue to repeat it. */
  accountFailedWithin(ms: number): boolean {
    return Date.now() - this.accountFailedAt < ms;
  }

  /** How old the remembered account reading is, or null when there is none. */
  accountAgeMs(): number | null {
    return this.accountRead ? Date.now() - this.accountRead.at : null;
  }

  private async request(
    call: ThreePayCall,
    method: 'GET' | 'POST',
    path: string,
    options: {
      query?: Record<string, string | undefined>;
      body?: string;
      reference?: string;
      priority?: ThreePayPriority;
    },
  ): Promise<ThreePayResponse> {
    const config = await this.configured();
    await this.assertHost(config.baseUrl);
    // Budgeted BEFORE sending: a refusal here is a definite "nothing was sent".
    this.budgets[call].take(options.priority ?? 'high');

    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const logPath = `${path}${url.search}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS[call]);
    const started = Date.now();
    /*
     * What was asked and what came back, whatever came back — the path with its
     * query (no credentials travel there) and the bodies; never the headers,
     * which carry the key and the secret, and never a credential 3pay put in a
     * reply (`loggableBody`).
     */
    const log = (
      status: number | null,
      responseBody: string | null,
      error?: string,
      rate?: BudgetReading,
    ) =>
      this.exchanges.record({
        providerCode: 'threepay',
        direction: 'outbound',
        method,
        // The API path as the guide names it (the base URL is configuration), with its query.
        path: logPath,
        requestBody: options.body ?? null,
        status,
        responseBody: loggableBody(path, responseBody),
        error: error ?? null,
        durationMs: Date.now() - started,
        reference: options.reference ?? null,
        rate: rate ?? null,
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
    // What 3pay states about its allowance is kept with the exchange: its PDF guides print other limits.
    const allowance = budgetReadingOf((name) => response.headers.get(name));
    log(response.status, text, undefined, allowance);
    this.budgets[call].observe(allowance);

    if (response.status === 429) {
      const wait = retryAfterMs(
        response.headers.get('retry-after') ?? response.headers.get('ratelimit-reset'),
      );
      this.budgets[call].pause(wait);
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

    const message = refusalText(body, response.status);
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

/** Measured on 3pay's live server, 12 Oct 2026; corrected by every response's headers. */
function freshBudgets(): Record<ThreePayCall, RequestBudget> {
  return {
    /*
     * What each kind of read leaves for the ones above it, at 3pay's 100 (a
     * stated limit that differs scales them). `normal` — the sweep, or a waiting
     * screen asking again — leaves 60 for what 3pay itself reports: at most 20
     * links open per window, each asked about when 3pay rings and up to twice
     * more until its API agrees. `low` leaves 75.
     */
    read: new RequestBudget(100, WINDOW_MS, { high: 0, normal: 60, low: 75 }),
    create: new RequestBudget(20, WINDOW_MS),
    payout: new RequestBudget(30, WINDOW_MS),
  };
}

/**
 * What 3pay said when it refused, whole: `message`, and the detail it puts
 * beside it (`errors`: "currencyType is required"). The detail is what tells an
 * engineer which field was wrong; "Validation failed" alone told nobody.
 */
function refusalText(body: Record<string, unknown> | undefined, status: number): string {
  const message = textOf(body?.['message']) ?? `HTTP ${status}`;
  const errors = body?.['errors'];
  const detail = Array.isArray(errors)
    ? errors
        .map((entry) => textOf(entry) ?? textOf(objectOf(entry)?.['message']))
        .filter((entry) => entry !== undefined)
        .join('; ')
    : textOf(errors);
  return detail && detail !== message ? `${message}: ${detail}` : message;
}

/** `Retry-After` in seconds or as a date; a minute when absent; bounded to 1 s – 15 min. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  let ms = 60_000;
  const text = header?.trim() ?? '';
  if (/^\d{1,6}$/.test(text)) ms = Number.parseInt(text, 10) * 1000;
  else if (text) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) ms = at - now;
  }
  return Math.min(Math.max(ms, 1000), WINDOW_MS);
}

function definedOnly(query: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string): string {
  return text.slice(0, 300).replace(/\s+/g, ' ').trim();
}
