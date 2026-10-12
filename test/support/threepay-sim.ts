import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Decimal from 'decimal.js';

/**
 * A 3PAY SIMULATOR, in process, on a random local port (0174; rebuilt 12 Oct
 * 2026 to behave like 3pay's LIVE server).
 *
 * The first version was written from 3pay's PDF guide, and every test passed
 * against it while the first production deposit was refused: the live server
 * reads a payment link's fields from the query string, answers in other
 * shapes, signs webhooks another way and allows a tenth of the requests. So
 * the default here is what was MEASURED on pay.3pa-y.com (12 Oct 2026) and
 * what its online reference documents, on the paths the server really serves:
 *
 *   - `POST /transaction/create` validates `currencyType` from the QUERY, before
 *     it checks the key; replies `{ url, transactionId, invoiceNo }` at the top.
 *   - `/transaction/verify` takes `transactionId`; `/transaction/list` answers
 *     `{ data: { docs, page, limit } }` and takes no date filter.
 *   - `/withdrawal-requests` answers `{ data: [...], totalPages }`, names the
 *     destination `clientWallet`; `/payout/get?id=` returns one.
 *   - A withdrawal waits `pending` for approval unless auto-withdraw covers it.
 *   - Webhooks: `{ success, message, data }`, `X-Webhook-Signature: sha256=…`
 *     keyed by the account's webhook secret.
 *   - Every reply carries `RateLimit-*` headers.
 *
 * `shape = 'guide'` answers as the PDF guide describes instead, so the adapter
 * is proven to read both. Amounts are JSON NUMBERS either way, so the lossless
 * parse is exercised for real.
 */

export interface SimInvoice {
  _id: string;
  transactionId: string;
  invoiceNo: string;
  referenceId?: string;
  description?: string;
  amount: string;
  actualBalance: string;
  fee: string;
  netAmount: string;
  currencyType: string;
  walletAddress: string;
  status: 'initiated' | 'amount confirmed' | 'confirmed' | 'expired' | 'failed' | 'cancelled';
  createdAt: string;
  confirmedAt?: string;
  /** Where 3pay was told to report (`webhookUrl`) and to send the payer (`callbackUrl`). */
  webhookUrl?: string;
  callbackUrl?: string;
  timer?: string;
}

export interface SimWithdrawal {
  _id: string;
  invoiceNo: string;
  amount: string;
  fee: string;
  netAmount: string;
  currencyType: string;
  /** Where it went — `clientWallet` on the live API, `walletAddress` in the guide. */
  clientWallet: string;
  transactionHash?: string;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'rejected';
  createdAt: string;
  processedAt?: string;
}

/** How the NEXT withdrawal request is answered. */
export type WithdrawalAnswer =
  | 'completed' // 200, confirmed within 3pay's window
  | 'executing' // 202, broadcast, confirmation pending
  | 'recorded-then-500' // recorded (and broadcast), then a 500 — "may still have moved money"
  | 'recorded-then-drop' // recorded, then the connection dies: the answer is lost
  | 'reject-400' // refused before broadcast
  | 'rate-429'; // over the limit

/** One request as the simulator received it. */
export interface SimRequest {
  query: Record<string, string>;
  body: string;
}

export class ThreePaySim {
  readonly apiKey = 'mk_live_sim';
  readonly apiSecret = `sk_live_${randomBytes(12).toString('hex')}`;
  webhookSecret = randomBytes(32).toString('hex');
  readonly invoices: SimInvoice[] = [];
  readonly withdrawals: SimWithdrawal[] = [];
  /** Every withdrawal request body as received, raw text — what 3pay was asked. */
  readonly payoutRequests: string[] = [];
  readonly createRequests: SimRequest[] = [];
  /** Every request path with its query, in order — what the adapter spent its budget on. */
  readonly calls: string[] = [];
  /** Answers for the next withdrawal requests, first in first out; default `completed`. */
  readonly nextWithdrawal: WithdrawalAnswer[] = [];
  /** The next payment-link creation loses its answer after the invoice is made. */
  dropNextCreate = false;
  /** `live`: what the server does. `guide`: what the PDF says it does. */
  shape: 'live' | 'guide' = 'live';
  /** 3pay's real withdrawal fee per network (a test may change it). */
  fees: Record<string, string> = { 'USDT-TRC20': '2.00', 'USDT-ERC20': '2.50' };
  /** Who carries the withdrawal fee: `user` takes it out of the amount, `merchant` charges it on top. */
  withdrawalFeePayer: 'user' | 'merchant' | null = 'user';
  /** Withdrawals up to `maxAutoWithdraw` are sent without approval in the dashboard. */
  autoWithdraw = true;
  maxAutoWithdraw = '100000';
  /** Force-route payouts to this address ("Static Wallet"). */
  forceRouteTo: string | null = null;
  /** Say what arrived (`actualBalance`) on verify. */
  reportsArrival = true;
  /** Say `currencyType` on verify. */
  verifyNamesNetwork = true;
  /** Put the webhook secret in the account reply, as the live server does. */
  accountShowsWebhookSecret = true;
  ipBlocked = false;
  /**
   * Requests made in the current fifteen-minute window, per budget — what the
   * `RateLimit-*` headers are computed from. A test sets `used.read = 100` to
   * exhaust the reads.
   */
  used = { read: 0, create: 0, payout: 0 };
  private windowStartedAt = Date.now();
  /**
   * The merchant balance, moved as the guide's table says: a confirmed deposit
   * adds its net; an accepted payout leaves `totalAmt` for `pendingAmt` at
   * once, and leaves for good when completed or comes back when failed.
   */
  balance = '10000.00';
  pending = '0.00';

  private server: Server | null = null;
  private seq = 0;

  get baseUrl(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) throw new Error('The 3pay simulator is not running.');
    return `http://127.0.0.1:${address.port}/api/v1`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  reset(): void {
    this.invoices.length = 0;
    this.withdrawals.length = 0;
    this.payoutRequests.length = 0;
    this.createRequests.length = 0;
    this.calls.length = 0;
    this.nextWithdrawal.length = 0;
    this.dropNextCreate = false;
    this.shape = 'live';
    this.fees = { 'USDT-TRC20': '2.00', 'USDT-ERC20': '2.50' };
    this.withdrawalFeePayer = 'user';
    this.autoWithdraw = true;
    this.maxAutoWithdraw = '100000';
    this.forceRouteTo = null;
    this.reportsArrival = true;
    this.verifyNamesNetwork = true;
    this.accountShowsWebhookSecret = true;
    this.ipBlocked = false;
    this.used = { read: 0, create: 0, payout: 0 };
    this.windowStartedAt = Date.now();
    this.balance = '10000.00';
    this.pending = '0.00';
  }

  /* ── what happens on the chain, and in 3pay's dashboard ─────────────────── */

  /** The payer sent `arrived` USDT; 3pay confirms the payment. */
  confirm(paymentId: string, arrived: string): SimInvoice {
    const invoice = this.invoice(paymentId);
    const fee = '1.00';
    invoice.status = 'confirmed';
    invoice.actualBalance = arrived;
    invoice.fee = fee;
    invoice.netAmount = new Decimal(arrived).minus(fee).toFixed(2);
    invoice.confirmedAt = new Date().toISOString();
    this.balance = new Decimal(this.balance).plus(invoice.netAmount).toFixed(2);
    return invoice;
  }

  /** The link expired — with `arrived` on it, when some came in unconfirmed. */
  expire(paymentId: string, arrived = '0'): SimInvoice {
    const invoice = this.invoice(paymentId);
    invoice.status = this.shape === 'live' ? 'failed' : 'expired';
    invoice.actualBalance = arrived;
    return invoice;
  }

  finish(withdrawalId: string, status: 'completed' | 'failed' | 'rejected'): SimWithdrawal {
    const withdrawal = this.withdrawal(withdrawalId);
    withdrawal.status = status;
    withdrawal.processedAt = new Date().toISOString();
    if (status === 'completed') withdrawal.transactionHash = randomBytes(16).toString('hex');
    const cost = this.costOf(withdrawal);
    this.pending = new Decimal(this.pending).minus(cost).toFixed(2);
    if (status !== 'completed') this.balance = new Decimal(this.balance).plus(cost).toFixed(2);
    return withdrawal;
  }

  /** Somebody approves a pending withdrawal in 3pay's dashboard: it is sent. */
  approve(withdrawalId: string): SimWithdrawal {
    return this.finish(withdrawalId, 'completed');
  }

  /** A payout made by hand in 3pay's dashboard — nothing on our side asked for it. */
  manualWithdrawal(amount: string, wallet: string, createdAt: Date): SimWithdrawal {
    const withdrawal = this.newWithdrawal(amount, wallet, 'USDT-TRC20', createdAt);
    return this.finish(withdrawal._id, 'completed');
  }

  /**
   * A webhook exactly as 3pay would POST it: the raw body and its headers.
   * Live: `{ success, message, data }`, `X-Webhook-Signature: sha256=<hex>`
   * keyed by the webhook secret. Guide: the event at the top,
   * `x-3pay-signature: <hex>` keyed by the API secret.
   */
  webhook(
    event: Record<string, unknown>,
    options: { secret?: string; shape?: 'live' | 'guide' } = {},
  ): { body: Buffer; headers: Record<string, string>; signature: string } {
    const shape = options.shape ?? this.shape;
    const payload =
      shape === 'live'
        ? { success: true, message: 'Transaction status update', data: event }
        : event;
    const body = Buffer.from(numbersOut(payload));
    const key = options.secret ?? (shape === 'live' ? this.webhookSecret : this.apiSecret);
    const signature = createHmac('sha256', key).update(body).digest('hex');
    return {
      body,
      signature,
      headers:
        shape === 'live'
          ? {
              'x-webhook-signature': `sha256=${signature}`,
              'x-webhook-source': '3Pay-Payment-Processor',
            }
          : { 'x-3pay-signature': signature },
    };
  }

  /** A payment by either of its names. */
  invoice(paymentId: string): SimInvoice {
    const invoice = this.invoices.find(
      (i) => i.transactionId === paymentId || i.invoiceNo === paymentId,
    );
    if (!invoice) throw new Error(`No simulated payment ${paymentId}.`);
    return invoice;
  }

  withdrawal(withdrawalId: string): SimWithdrawal {
    const withdrawal = this.withdrawals.find((w) => w._id === withdrawalId);
    if (!withdrawal) throw new Error(`No simulated withdrawal ${withdrawalId}.`);
    return withdrawal;
  }

  /** The id our rows hold for a payment: the transaction id live, the invoice number per the guide. */
  paymentIdOf(invoice: SimInvoice): string {
    return this.shape === 'live' ? invoice.transactionId : invoice.invoiceNo;
  }

  /* ── the HTTP side ─────────────────────────────────────────────────────── */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim');
    const body = await readBody(req);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    this.calls.push(`${req.method} ${path}${url.search}`);
    const isCreate = req.method === 'POST' && path === '/transaction/create';

    // The windows 3pay's server states on every reply (measured on the live API).
    const budget = isCreate
      ? 'create'
      : req.method === 'POST' && path === '/withdrawal-request'
        ? 'payout'
        : 'read';
    const limit = { read: 100, create: 20, payout: 30 }[budget];
    if (Date.now() - this.windowStartedAt >= 900_000) {
      this.used = { read: 0, create: 0, payout: 0 };
      this.windowStartedAt = Date.now();
    }
    const resetIn = Math.ceil((this.windowStartedAt + 900_000 - Date.now()) / 1000);
    res.setHeader('RateLimit-Policy', `${limit};w=900`);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Reset', String(resetIn));
    if (this.used[budget] >= limit) {
      res.setHeader('RateLimit-Remaining', '0');
      return send(res, 429, {
        success: false,
        message: 'API rate limit exceeded. Try again in 15 minutes.',
      });
    }
    this.used[budget] += 1;
    res.setHeader('RateLimit-Remaining', String(limit - this.used[budget]));

    // A payment link's fields are validated BEFORE the key is checked (measured).
    if (isCreate) {
      const network = url.searchParams.get('currencyType');
      if (!network) return send(res, 400, invalid('currencyType is required'));
      if (network !== 'USDT-TRC20' && network !== 'USDT-ERC20') {
        return send(res, 400, invalid('Invalid currencyType'));
      }
    }
    if (!req.headers['apikey']) {
      return send(res, 401, {
        success: false,
        message: 'API key required',
        error: 'Unauthorized access',
      });
    }
    if (!req.headers['x-api-secret'] && !isCreate) {
      return send(res, 401, {
        success: false,
        message: 'x-api-secret header is required for this endpoint',
      });
    }
    if (
      req.headers['apikey'] !== this.apiKey ||
      (req.headers['x-api-secret'] !== undefined && req.headers['x-api-secret'] !== this.apiSecret)
    ) {
      return send(res, 401, { success: false, message: 'Invalid API credentials' });
    }
    if (this.ipBlocked) {
      return send(res, 403, {
        success: false,
        message: 'Requesting server/platform IP not whitelisted',
      });
    }

    if (req.method === 'GET' && path === '/getMerchantDetails') {
      return send(res, 200, {
        success: true,
        message: 'Merchant retrieved successfully',
        data: {
          _id: 'm1',
          name: 'Sim Owner',
          email: 'owner@merchant.test',
          phoneNo: '009610000000',
          companyName: 'Sim Merchant',
          totalAmt: num(this.balance),
          pendingAmt: num(this.pending),
          approved: 'approved',
          autoWithdraw: this.autoWithdraw,
          maxAutoWithdrawAmount: num(this.maxAutoWithdraw),
          depositFeePayer: 'merchant',
          ...(this.withdrawalFeePayer ? { withdrawalFeePayer: this.withdrawalFeePayer } : {}),
          staticWallets: { isEnabled: this.forceRouteTo !== null },
          ...(this.accountShowsWebhookSecret ? { webhookSecret: this.webhookSecret } : {}),
        },
      });
    }
    if (isCreate) return this.create(res, url, body);
    if (req.method === 'GET' && path === '/transaction/verify') return this.verify(res, url);
    if (req.method === 'GET' && path === '/transaction/list') return this.listInvoices(res, url);
    if (req.method === 'POST' && path === '/withdrawal-request') return this.withdraw(res, body);
    if (req.method === 'GET' && path === '/withdrawal-requests')
      return this.listWithdrawals(res, url);
    if (req.method === 'GET' && path === '/payout/get' && this.shape === 'live') {
      const id = url.searchParams.get('id');
      if (!id) return send(res, 400, { success: false, message: 'Withdrawal ID is required' });
      const withdrawal = this.withdrawals.find((w) => w._id === id);
      if (!withdrawal) return send(res, 404, { success: false, message: 'Withdrawal not found' });
      const { _id, ...rest } = this.withdrawalRecord(withdrawal);
      return send(res, 200, {
        success: true,
        message: 'Payout retrieved successfully',
        data: { id: _id, ...rest },
      });
    }
    // An unknown route answers with Express's HTML page, not JSON.
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      `<!DOCTYPE html><html><body><pre>Cannot ${req.method} ${url.pathname}</pre></body></html>`,
    );
  }

  private create(res: ServerResponse, url: URL, raw: string): void {
    const query = Object.fromEntries(url.searchParams.entries());
    this.createRequests.push({ query, body: raw });
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const amount = query['amount'];
    const network = query['currencyType'];
    if (!amount || new Decimal(amount).lt(1)) {
      return send(res, 400, { success: false, message: 'Missing required fields' });
    }
    this.seq += 1;
    const invoice: SimInvoice = {
      _id: randomBytes(12).toString('hex'),
      transactionId: randomUUID(),
      invoiceNo: `INV-${Date.now()}-${this.seq}`,
      referenceId: (parsed['referenceId'] ?? parsed['clientReference']) as string | undefined,
      description: parsed['description'] as string | undefined,
      amount,
      actualBalance: '0',
      fee: '0',
      netAmount: '0',
      currencyType: network,
      walletAddress: 'TRygAGEkC4rF6wnyweM91vtcsFdnAQxWjf',
      status: 'initiated',
      createdAt: new Date().toISOString(),
      webhookUrl: query['webhookUrl'],
      callbackUrl: query['callbackUrl'] ?? (parsed['callbackUrl'] as string | undefined),
      timer: query['timer'],
    };
    this.invoices.push(invoice);
    if (this.dropNextCreate) {
      this.dropNextCreate = false;
      res.socket?.destroy();
      return;
    }
    if (this.shape === 'live') {
      return send(res, 200, {
        success: true,
        message: 'Payment link generated successfully',
        url: `https://pay.3pa-y.example/s/${invoice._id}`,
        transactionId: invoice.transactionId,
        invoiceNo: invoice.invoiceNo,
      });
    }
    return send(res, 200, {
      success: true,
      data: {
        invoiceNo: invoice.invoiceNo,
        paymentUrl: `https://pay.3pa-y.example/checkout/${invoice._id}`,
        walletAddress: invoice.walletAddress,
        amount: num(invoice.amount),
        currencyType: invoice.currencyType,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
    });
  }

  private verify(res: ServerResponse, url: URL): void {
    let invoice: SimInvoice | undefined;
    if (this.shape === 'live') {
      const id = url.searchParams.get('transactionId');
      if (!id) {
        return send(res, 400, {
          success: false,
          message: 'Invalid request parameters, transactionId is required',
        });
      }
      invoice = this.invoices.find((i) => i.transactionId === id);
    } else {
      invoice = this.invoices.find((i) => i.invoiceNo === url.searchParams.get('invoiceNo'));
    }
    if (!invoice) return send(res, 404, { success: false, message: 'Transaction not found' });
    return send(res, 200, {
      success: true,
      message: 'Transaction retrieved successfully',
      data: {
        ...(this.shape === 'live' ? { transactionId: invoice.transactionId, type: 'deposit' } : {}),
        invoiceNo: invoice.invoiceNo,
        status: invoice.status,
        amount: num(invoice.amount),
        ...(this.reportsArrival ? { actualBalance: num(invoice.actualBalance) } : {}),
        fee: num(invoice.fee),
        netAmount: num(invoice.netAmount),
        walletAddress: invoice.walletAddress,
        createdAt: invoice.createdAt,
        ...(invoice.confirmedAt ? { confirmedAt: invoice.confirmedAt } : {}),
        ...(this.verifyNamesNetwork ? { currencyType: invoice.currencyType } : {}),
      },
    });
  }

  private listInvoices(res: ServerResponse, url: URL): void {
    const status = url.searchParams.get('status');
    const search = url.searchParams.get('search');
    const type = url.searchParams.get('type');
    // The lists take NO date filter: `fromDate` is ignored, as on the live server.
    const matching = (type && type !== 'deposit' ? [] : this.invoices)
      .filter((i) => !status || i.status === status)
      .filter(
        (i) =>
          !search ||
          [i.invoiceNo, i.referenceId ?? '', i.walletAddress].some((f) => f.includes(search)),
      )
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const { page, limit, rows, totalPages } = paged(url, matching);
    const docs = rows.map((i) =>
      numbered({
        _id: i._id,
        ...(this.shape === 'live'
          ? { transactionId: i.transactionId, type: 'deposit', referenceId: i.referenceId }
          : { transactionType: 'deposit', clientReference: i.referenceId }),
        invoiceNo: i.invoiceNo,
        amount: i.amount,
        actualBalance: i.actualBalance,
        fee: i.fee,
        netAmount: i.netAmount,
        currencyType: i.currencyType,
        status: i.status,
        createdAt: i.createdAt,
        ...(i.confirmedAt ? { confirmedAt: i.confirmedAt } : {}),
      }),
    );
    if (this.shape === 'live') {
      return send(res, 200, {
        success: true,
        message: 'Transaction retrieved successfully',
        data: { docs, page, limit },
      });
    }
    return send(res, 200, {
      success: true,
      data: docs,
      pagination: { total: matching.length, page, limit, totalPages },
    });
  }

  private withdrawalRecord(w: SimWithdrawal): Record<string, unknown> {
    const { clientWallet, ...rest } = w;
    return numbered({
      ...rest,
      ...(this.shape === 'live'
        ? { clientWallet, type: 'withdrawal' }
        : { walletAddress: clientWallet }),
    });
  }

  private listWithdrawals(res: ServerResponse, url: URL): void {
    const status = url.searchParams.get('status');
    const matching = this.withdrawals
      .filter((w) => !status || w.status === status)
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const { page, limit, rows, totalPages } = paged(url, matching);
    const data = rows.map((w) => this.withdrawalRecord(w));
    if (this.shape === 'live') {
      return send(res, 200, {
        success: true,
        data,
        totalPages,
        currentPage: page,
        total: matching.length,
      });
    }
    return send(res, 200, {
      success: true,
      data,
      pagination: { total: matching.length, page, limit, totalPages },
    });
  }

  private withdraw(res: ServerResponse, raw: string): void {
    this.payoutRequests.push(raw);
    const answer = this.nextWithdrawal.shift() ?? 'completed';
    if (answer === 'rate-429') {
      res.setHeader('Retry-After', '1');
      return send(res, 429, { success: false, message: 'Too many requests' });
    }
    const request = JSON.parse(raw) as Record<string, unknown>;
    if (answer === 'reject-400') {
      return send(res, 400, {
        success: false,
        message: 'Insufficient balance. Available: 100.5 USDT, Requested: 500 USDT',
        error: 'Insufficient funds',
      });
    }
    const withdrawal = this.newWithdrawal(
      numberText(raw),
      this.forceRouteTo ?? String(request['walletAddress']),
      String(request['currencyType']),
      new Date(),
    );
    if (answer === 'recorded-then-500') {
      withdrawal.status = 'executing';
      return send(res, 500, { success: false, message: 'Blockchain service unavailable' });
    }
    if (answer === 'recorded-then-drop') {
      withdrawal.status = 'executing';
      res.socket?.destroy();
      return;
    }
    // Held for approval in the dashboard: auto-withdraw off, or above its threshold.
    if (!this.autoWithdraw || new Decimal(withdrawal.amount).gt(this.maxAutoWithdraw)) {
      return send(res, 201, {
        success: true,
        message: 'Withdrawal request submitted successfully. Awaiting approval.',
        data: {
          withdrawal: {
            id: withdrawal._id,
            amount: num(withdrawal.amount),
            currencyType: withdrawal.currencyType,
            status: 'pending',
            clientWallet: withdrawal.clientWallet,
            createdAt: withdrawal.createdAt,
            estimatedProcessingTime: 'Pending merchant approval',
          },
        },
      });
    }
    if (answer === 'executing') {
      withdrawal.status = 'executing';
      return send(res, 202, {
        success: true,
        message: 'Withdrawal submitted, awaiting blockchain confirmation',
        data: { withdrawal: { _id: withdrawal._id, status: 'executing' } },
      });
    }
    this.finish(withdrawal._id, 'completed');
    return send(res, 200, {
      success: true,
      data: {
        withdrawalId: withdrawal._id,
        status: 'completed',
        amount: num(withdrawal.amount),
        fee: num(withdrawal.fee),
        netAmount: num(withdrawal.netAmount),
        transactionHash: withdrawal.transactionHash,
        ...(this.shape === 'live'
          ? { clientWallet: withdrawal.clientWallet }
          : { walletAddress: withdrawal.clientWallet }),
        currencyType: withdrawal.currencyType,
      },
    });
  }

  /** What a withdrawal takes from the balance: its amount, plus the fee when the merchant carries it. */
  private costOf(withdrawal: SimWithdrawal): string {
    return this.withdrawalFeePayer === 'merchant'
      ? new Decimal(withdrawal.amount).plus(withdrawal.fee).toFixed(2)
      : withdrawal.amount;
  }

  private newWithdrawal(
    amount: string,
    wallet: string,
    currencyType: string,
    createdAt: Date,
  ): SimWithdrawal {
    this.seq += 1;
    const fee = this.fees[currencyType] ?? '2.00';
    const withdrawal: SimWithdrawal = {
      _id: randomBytes(12).toString('hex'),
      invoiceNo: `WD-${createdAt.getTime()}-${this.seq}`,
      amount,
      fee,
      // `merchant`: the client receives the amount whole and the fee is charged on top.
      netAmount:
        this.withdrawalFeePayer === 'merchant'
          ? new Decimal(amount).toFixed(2)
          : new Decimal(amount).minus(fee).toFixed(2),
      currencyType,
      clientWallet: wallet,
      status: 'pending',
      createdAt: createdAt.toISOString(),
    };
    this.withdrawals.push(withdrawal);
    // Taken at once, atomically (guide §05, step 3).
    const cost = this.costOf(withdrawal);
    this.balance = new Decimal(this.balance).minus(cost).toFixed(2);
    this.pending = new Decimal(this.pending).plus(cost).toFixed(2);
    return withdrawal;
  }
}

function paged<T>(url: URL, matching: readonly T[]) {
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
  return {
    page,
    limit,
    rows: matching.slice((page - 1) * limit, page * limit),
    totalPages: Math.max(1, Math.ceil(matching.length / limit)),
  };
}

/* ── JSON the way 3pay writes it: amounts as NUMBERS ─────────────────────── */

const MONEY = new Set([
  'amount',
  'actualBalance',
  'fee',
  'netAmount',
  'depositedAmount',
  'totalAmt',
  'pendingAmt',
]);

/** A decimal string marked to be written as a raw JSON number. */
function num(value: string): { __num: string } {
  return { __num: value };
}

function numbered(item: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(item)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, value]) => [
        key,
        MONEY.has(key) && typeof value === 'string' ? num(value) : value,
      ]),
  );
}

function numbersOut(value: unknown): string {
  return JSON.stringify(value).replace(/\{"__num":"(-?\d+(?:\.\d+)?)"\}/g, '$1');
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(numbersOut(payload));
}

/** The live server's validation refusal, word for word. */
function invalid(errors: string): Record<string, unknown> {
  return { success: false, message: 'Validation failed', errors };
}

/** The `amount` literal exactly as the request wrote it — what 3pay was asked. */
function numberText(raw: string): string {
  const match = /"amount":\s*(-?\d+(?:\.\d+)?)/.exec(raw);
  if (!match) throw new Error(`No numeric amount in ${raw}`);
  return match[1];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
