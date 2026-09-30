import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Decimal from 'decimal.js';

/**
 * A 3PAY SIMULATOR — every endpoint of 3pay's guide (docs/integration-guide.pdf),
 * in process, on a random local port (0174).
 *
 * 3pay has no sandbox, so this is where the adapter meets 3pay's documented
 * behaviour — and its documented FAILURES — before a single real USDT moves:
 * amounts as JSON NUMBERS (so the lossless parse is exercised for real), the
 * 401/403 auth answers, 429 with Retry-After, a payout that answers 500 after
 * it was already recorded, an answer lost after the invoice was made, a payout
 * force-routed to another wallet, a fee that changed. The go-live test with
 * real money is still the owner's (the plan's runbook); this is everything
 * short of it.
 */

export interface SimInvoice {
  _id: string;
  invoiceNo: string;
  clientReference?: string;
  description?: string;
  amount: string;
  actualBalance: string;
  fee: string;
  netAmount: string;
  currencyType: string;
  walletAddress: string;
  status: 'initiated' | 'pending' | 'confirmed' | 'expired' | 'failed';
  createdAt: string;
  confirmedAt?: string;
  callbackUrl?: string;
}

export interface SimWithdrawal {
  _id: string;
  invoiceNo: string;
  amount: string;
  fee: string;
  netAmount: string;
  currencyType: string;
  walletAddress: string;
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

export class ThreePaySim {
  readonly apiKey = 'mk_live_sim';
  readonly apiSecret = `sk_live_${randomBytes(12).toString('hex')}`;
  readonly invoices: SimInvoice[] = [];
  readonly withdrawals: SimWithdrawal[] = [];
  /** Every withdrawal request body as received, raw text — what 3pay was asked. */
  readonly payoutRequests: string[] = [];
  readonly createRequests: string[] = [];
  /** Answers for the next withdrawal requests, first in first out; default `completed`. */
  readonly nextWithdrawal: WithdrawalAnswer[] = [];
  /** The next payment-link creation loses its answer after the invoice is made. */
  dropNextCreate = false;
  /** 3pay's real withdrawal fee per network (a test may change it). */
  fees: Record<string, string> = { 'USDT-TRC20': '2.00', 'USDT-ERC20': '2.50' };
  /** Force-route payouts to this address ("Static Wallet"). */
  forceRouteTo: string | null = null;
  /** Say `currencyType` on verify (the guide's example omits it). */
  verifyNamesNetwork = true;
  ipBlocked = false;
  balance = '10000.00';

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
    this.nextWithdrawal.length = 0;
    this.dropNextCreate = false;
    this.fees = { 'USDT-TRC20': '2.00', 'USDT-ERC20': '2.50' };
    this.forceRouteTo = null;
    this.verifyNamesNetwork = true;
    this.ipBlocked = false;
    this.balance = '10000.00';
  }

  /* ── what happens on the chain ─────────────────────────────────────────── */

  /** The payer sent `arrived` USDT; 3pay confirms the invoice. */
  confirm(invoiceNo: string, arrived: string): SimInvoice {
    const invoice = this.invoice(invoiceNo);
    const fee = '2.00';
    invoice.status = 'confirmed';
    invoice.actualBalance = arrived;
    invoice.fee = fee;
    invoice.netAmount = new Decimal(arrived).minus(fee).toFixed(2);
    invoice.confirmedAt = new Date().toISOString();
    return invoice;
  }

  /** The link expired — with `arrived` on it, when some came in unconfirmed. */
  expire(invoiceNo: string, arrived = '0'): SimInvoice {
    const invoice = this.invoice(invoiceNo);
    invoice.status = 'expired';
    invoice.actualBalance = arrived;
    return invoice;
  }

  finish(withdrawalId: string, status: 'completed' | 'failed'): SimWithdrawal {
    const withdrawal = this.withdrawals.find((w) => w._id === withdrawalId);
    if (!withdrawal) throw new Error(`No simulated withdrawal ${withdrawalId}.`);
    withdrawal.status = status;
    withdrawal.processedAt = new Date().toISOString();
    if (status === 'completed') withdrawal.transactionHash = randomBytes(16).toString('hex');
    return withdrawal;
  }

  /** A payout made by hand in 3pay's dashboard — nothing on our side asked for it. */
  manualWithdrawal(amount: string, walletAddress: string, createdAt: Date): SimWithdrawal {
    const withdrawal = this.newWithdrawal(amount, walletAddress, 'USDT-TRC20', createdAt);
    withdrawal.status = 'completed';
    return withdrawal;
  }

  /** A webhook exactly as 3pay would POST it: the raw body and its signature. */
  webhook(
    payload: Record<string, unknown>,
    secret = this.apiSecret,
  ): {
    body: Buffer;
    signature: string;
  } {
    const body = Buffer.from(numbersOut(payload));
    return { body, signature: createHmac('sha256', secret).update(body).digest('hex') };
  }

  invoice(invoiceNo: string): SimInvoice {
    const invoice = this.invoices.find((i) => i.invoiceNo === invoiceNo);
    if (!invoice) throw new Error(`No simulated invoice ${invoiceNo}.`);
    return invoice;
  }

  /* ── the HTTP side ─────────────────────────────────────────────────────── */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim');
    const body = await readBody(req);
    if (!req.headers['apikey']) return send(res, 401, fail('API key required'));
    if (!req.headers['x-api-secret']) return send(res, 401, fail('API secret required'));
    if (req.headers['apikey'] !== this.apiKey || req.headers['x-api-secret'] !== this.apiSecret) {
      return send(res, 401, fail('Invalid API credentials'));
    }
    if (this.ipBlocked)
      return send(res, 403, fail('Requesting server/platform IP not whitelisted'));

    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (req.method === 'GET' && path === '/getMerchantDetails') {
      return send(res, 200, {
        success: true,
        data: {
          _id: 'm1',
          name: 'Sim Merchant',
          totalAmt: num(this.balance),
          pendingAmt: num('0'),
        },
      });
    }
    if (req.method === 'POST' && path === '/transaction/create') return this.create(res, body);
    if (req.method === 'GET' && path === '/transaction/verify') {
      const invoice = this.invoices.find((i) => i.invoiceNo === url.searchParams.get('invoiceNo'));
      if (!invoice) return send(res, 404, fail('Not found'));
      const { invoiceNo, status, amount, actualBalance, netAmount, confirmedAt, currencyType } =
        invoice;
      return send(res, 200, {
        success: true,
        data: {
          invoiceNo,
          status,
          amount: num(amount),
          actualBalance: num(actualBalance),
          netAmount: num(netAmount),
          ...(confirmedAt ? { confirmedAt } : {}),
          ...(this.verifyNamesNetwork ? { currencyType } : {}),
        },
      });
    }
    if (req.method === 'GET' && path === '/transaction/list') {
      return send(
        res,
        200,
        this.list(url, this.invoices, (i) => [i.invoiceNo, i.clientReference ?? '']),
      );
    }
    if (req.method === 'POST' && path === '/withdrawal-request') return this.withdraw(res, body);
    if (req.method === 'GET' && path === '/withdrawal-requests') {
      return send(
        res,
        200,
        this.list(url, this.withdrawals, (w) => [w.invoiceNo]),
      );
    }
    return send(res, 404, fail('Not found'));
  }

  private create(res: ServerResponse, raw: string): void {
    this.createRequests.push(raw);
    const request = JSON.parse(raw) as Record<string, unknown>;
    if (typeof request['amount'] !== 'number' || request['amount'] < 1) {
      return send(res, 400, fail('Missing required fields'));
    }
    this.seq += 1;
    const invoice: SimInvoice = {
      _id: randomBytes(12).toString('hex'),
      invoiceNo: `INV-${Date.now()}-${this.seq}`,
      clientReference: request['clientReference'] as string | undefined,
      description: request['description'] as string | undefined,
      amount: numberText(raw),
      actualBalance: '0',
      fee: '0',
      netAmount: '0',
      currencyType: String(request['currencyType']),
      walletAddress: 'TRygAGEkC4rF6wnyweM91vtcsFdnAQxWjf',
      status: 'pending',
      createdAt: new Date().toISOString(),
      callbackUrl: request['callbackUrl'] as string | undefined,
    };
    this.invoices.push(invoice);
    if (this.dropNextCreate) {
      this.dropNextCreate = false;
      res.socket?.destroy();
      return;
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

  private withdraw(res: ServerResponse, raw: string): void {
    this.payoutRequests.push(raw);
    const answer = this.nextWithdrawal.shift() ?? 'completed';
    if (answer === 'rate-429') {
      res.setHeader('Retry-After', '1');
      return send(res, 429, fail('Too many requests'));
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
      return send(res, 500, fail('Blockchain service unavailable'));
    }
    if (answer === 'recorded-then-drop') {
      withdrawal.status = 'executing';
      res.socket?.destroy();
      return;
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
        walletAddress: withdrawal.walletAddress,
        currencyType: withdrawal.currencyType,
      },
    });
  }

  private newWithdrawal(
    amount: string,
    walletAddress: string,
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
      netAmount: new Decimal(amount).minus(fee).toFixed(2),
      currencyType,
      walletAddress,
      status: 'pending',
      createdAt: createdAt.toISOString(),
    };
    this.withdrawals.push(withdrawal);
    return withdrawal;
  }

  /** 3pay's list shape, with its filters and pages (guide §6.2). */
  private list<T extends { status: string; currencyType: string; createdAt: string }>(
    url: URL,
    items: readonly T[],
    searchable: (item: T) => string[],
  ): Record<string, unknown> {
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
    const status = url.searchParams.get('status');
    const network = url.searchParams.get('currencyType');
    const search = url.searchParams.get('search');
    const from = url.searchParams.get('fromDate');
    const to = url.searchParams.get('toDate');
    const matching = items
      .filter((item) => !status || item.status === status)
      .filter((item) => !network || item.currencyType === network)
      .filter((item) => !search || searchable(item).some((field) => field.includes(search)))
      .filter((item) => !from || Date.parse(item.createdAt) >= Date.parse(from))
      .filter((item) => !to || Date.parse(item.createdAt) <= Date.parse(to))
      .reverse(); // newest first
    const totalPages = Math.max(1, Math.ceil(matching.length / limit));
    return {
      success: true,
      data: matching.slice((page - 1) * limit, page * limit).map(numbered),
      pagination: { total: matching.length, page, limit, totalPages },
    };
  }
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
    Object.entries(item).map(([key, value]) => [
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

function fail(message: string): Record<string, unknown> {
  return { success: false, message, error: message.toUpperCase().replace(/\W+/g, '_') };
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
