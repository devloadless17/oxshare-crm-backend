import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { WhishProvider } from '../src/modules/payments/whish.provider';

/**
 * The Whish gateway's HTTP seam.
 *
 * Every assertion here covers something that moves real money and does not
 * throw on its own: an amount Whish would reject silently costing a client their
 * deposit attempt, an indeterminate `code: 500` being read as a failure when a
 * payment may have succeeded, or a `pending` status being treated as settled.
 *
 * `fetch` is faked rather than hit. There is no other way to test a third-party
 * money API without credentials and a network, and the logic worth testing —
 * what we send, and how we read what comes back — is entirely on this side.
 *
 * Mutation-checked when written: each guarantee was broken deliberately and the
 * named test failed on the right assertion.
 */

const CONFIG = {
  WHISH_CHANNEL: 'test-channel',
  WHISH_SECRET: 'test-secret',
  WHISH_WEBSITE_URL: 'https://oxshare.test',
  WHISH_BASE_URL: 'https://partner.api.sbx.whish.money/itel-service/api',
};

function providerWith(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = { ...CONFIG, ...overrides };
  const config = {
    get: <T>(key: string) => values[key] as unknown as T,
  } as unknown as ConfigService;
  return new WhishProvider(config);
}

/** A fake `fetch` answering with Whish's envelope. */
function mockFetch(body: unknown, ok = true, statusCode = 200) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status: statusCode,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const COLLECT_INPUT = {
  externalId: 'OX7K2M9',
  amount: '50.00000000',
  currency: 'USD',
  invoice: 'Deposit OX7K2M9',
  successCallbackUrl: 'https://api.oxshare.test/v1/payments/gateway/whish/callback?outcome=success',
  failureCallbackUrl: 'https://api.oxshare.test/v1/payments/gateway/whish/callback?outcome=failure',
  successRedirectUrl: 'https://oxshare.test/deposit/success',
  failureRedirectUrl: 'https://oxshare.test/deposit/failure',
};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('isConfigured', () => {
  /*
   * A PARTIALLY configured gateway is worse than an absent one: it appears on
   * the deposit screen and dies at the moment the client commits, which reads as
   * "this platform is broken" rather than "this method is unavailable".
   */
  it('needs all four values, not some of them', () => {
    expect(providerWith().isConfigured()).toBe(true);

    for (const key of Object.keys(CONFIG)) {
      expect(providerWith({ [key]: undefined }).isConfigured()).toBe(false);
    }
  });
});

describe('createCollect — what goes on the wire', () => {
  it('sends the credentials as headers and the payment as a JSON body', async () => {
    const fetchSpy = mockFetch({
      status: true,
      code: null,
      data: { collectUrl: 'https://whish.money/pay/8nQS2mL' },
    });

    const result = await providerWith().createCollect(COLLECT_INPUT);
    expect(result.collectUrl).toBe('https://whish.money/pay/8nQS2mL');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CONFIG.WHISH_BASE_URL}/payment/whish`);

    const headers = init.headers as Record<string, string>;
    expect(headers.channel).toBe(CONFIG.WHISH_CHANNEL);
    expect(headers.secret).toBe(CONFIG.WHISH_SECRET);
    expect(headers.websiteUrl).toBe(CONFIG.WHISH_WEBSITE_URL);

    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body.externalId).toBe('OX7K2M9');
    expect(body.successCallbackUrl).toBe(COLLECT_INPUT.successCallbackUrl);
  });

  /*
   * THE money-shape regression. The ledger stores 8 decimal places and Whish
   * accepts at most 2 for USD — sending '50.00000000' is rejected at the
   * provider with an opaque code, so the client sees "payment refused" for an
   * amount that is perfectly valid.
   *
   * A STRING on the wire, because Whish wants a JSON string and a number would
   * round-trip through a float on the way out.
   */
  it('sends USD fixed at two decimals, as a string', async () => {
    const fetchSpy = mockFetch({
      status: true,
      code: null,
      data: { collectUrl: 'https://x.test' },
    });
    await providerWith().createCollect(COLLECT_INPUT);

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      amount: unknown;
    };
    expect(body.amount).toBe('50.00');
    expect(typeof body.amount).toBe('string');
  });

  it('sends LBP with no decimals at all', async () => {
    const fetchSpy = mockFetch({
      status: true,
      code: null,
      data: { collectUrl: 'https://x.test' },
    });
    await providerWith().createCollect({
      ...COLLECT_INPUT,
      amount: '150000.00000000',
      currency: 'LBP',
    });

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      amount: unknown;
    };
    expect(body.amount).toBe('150000');
  });

  it('refuses an amount below the provider floor before spending a round trip', async () => {
    const fetchSpy = mockFetch({
      status: true,
      code: null,
      data: { collectUrl: 'https://x.test' },
    });

    await expect(
      providerWith().createCollect({ ...COLLECT_INPUT, amount: '0.50' }),
    ).rejects.toThrow(/minimum/i);
    await expect(
      providerWith().createCollect({ ...COLLECT_INPUT, amount: '999', currency: 'LBP' }),
    ).rejects.toThrow(/minimum/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses more precision than the currency allows', async () => {
    mockFetch({ status: true, code: null, data: { collectUrl: 'https://x.test' } });

    await expect(
      providerWith().createCollect({ ...COLLECT_INPUT, amount: '10.005' }),
    ).rejects.toThrow(/two decimal/i);
    await expect(
      providerWith().createCollect({ ...COLLECT_INPUT, amount: '1500.5', currency: 'LBP' }),
    ).rejects.toThrow(/decimals/i);
  });

  /*
   * Whish settles USD and LBP only. Refusing here names the problem; letting it
   * through surfaces as an opaque provider code a client cannot act on.
   */
  it('refuses a currency the provider does not settle', async () => {
    const fetchSpy = mockFetch({ status: true, code: null, data: {} });
    await expect(
      providerWith().createCollect({ ...COLLECT_INPUT, currency: 'USDT' }),
    ).rejects.toThrow(/USD and LBP/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses when the provider accepts but returns no link', async () => {
    mockFetch({ status: true, code: null, data: {} });
    await expect(providerWith().createCollect(COLLECT_INPUT)).rejects.toThrow(/no payment link/i);
  });
});

describe('the response envelope', () => {
  /*
   * THE dangerous one. `code: '500'` means Whish does not know the outcome — a
   * payment may exist. Reporting it as an ordinary refusal invites the caller to
   * retry and create a SECOND payment, and tells a client who may have paid that
   * nothing happened.
   *
   * The message must send them to their history rather than to the button.
   */
  it('separates an indeterminate result from a refusal', async () => {
    mockFetch({ status: false, code: '500', data: null });
    await expect(providerWith().createCollect(COLLECT_INPUT)).rejects.toThrow(
      /did not confirm|check your payment history/i,
    );
  });

  it('refuses on any other error code', async () => {
    mockFetch({ status: false, code: 'INSUFFICIENT_FUNDS', data: null });
    await expect(providerWith().createCollect(COLLECT_INPUT)).rejects.toThrow(/refused/i);
  });

  /**
   * ⚠️ A non-200 refuses EVEN WHEN THE BODY CANNOT BE READ.
   *
   * The provider logs the response body on an HTTP error, because `answered
   * HTTP 401` and nothing else is the least actionable form of that failure —
   * 401, 403 and 404 all reach this branch and the body is what tells them
   * apart.
   *
   * This mock supplies `json` and no `text`, so `response.text()` throws
   * SYNCHRONOUSLY, and that is the case worth pinning. The read was first
   * guarded with `.catch()`, which only handles a REJECTED PROMISE — so the
   * throw escaped it and the caller received `response.text is not a function`
   * instead of a refusal. An unhandled TypeError on a money path, caused by a
   * log line.
   *
   * The assertion is that the caller's experience is unchanged whatever the
   * body does.
   */
  it('refuses on a non-200 even when the body cannot be read', async () => {
    mockFetch(null, false, 503);
    await expect(providerWith().createCollect(COLLECT_INPUT)).rejects.toThrow(/refused/i);
  });

  /** The ordinary case: a body exists, is read for the log, and changes nothing. */
  it('refuses on a non-200 and still refuses when the body reads fine', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve(null),
        text: () => Promise.resolve('{"error":"bad credentials"}'),
      }),
    );
    await expect(providerWith().createCollect(COLLECT_INPUT)).rejects.toThrow(/refused/i);
  });

  it('refuses when the provider cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(providerWith().createCollect(COLLECT_INPUT)).rejects.toThrow(
      /could not be reached/i,
    );
  });

  it('refuses before any call when the gateway is unconfigured', async () => {
    const fetchSpy = mockFetch({ status: true, code: null, data: {} });
    await expect(
      providerWith({ WHISH_SECRET: undefined }).createCollect(COLLECT_INPUT),
    ).rejects.toThrow(/not configured/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('getStatus', () => {
  it('reads the collect status and the payer', async () => {
    mockFetch({
      status: true,
      code: null,
      data: { collectStatus: 'success', payerPhoneNumber: '96170123456' },
    });

    const status = await providerWith().getStatus('OX7K2M9', 'USD');
    expect(status.collectStatus).toBe('success');
    expect(status.payerPhoneNumber).toBe('96170123456');
  });

  /*
   * An answered request with no body must not be guessed at. `unknown` is a real
   * Whish state and the honest mapping — the caller treats it as unsettled and
   * asks again, rather than settling on an assumption.
   */
  it('reports unknown rather than inventing a state when the body is empty', async () => {
    mockFetch({ status: true, code: null, data: null });
    const status = await providerWith().getStatus('OX7K2M9', 'USD');
    expect(status.collectStatus).toBe('unknown');
    expect(status.payerPhoneNumber).toBeNull();
  });

  it('sends the externalId and currency Whish matches on', async () => {
    const fetchSpy = mockFetch({ status: true, code: null, data: { collectStatus: 'pending' } });
    await providerWith().getStatus('OX7K2M9', 'usd');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CONFIG.WHISH_BASE_URL}/payment/collect/status`);
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body).toEqual({ externalId: 'OX7K2M9', currency: 'USD' });
  });
});
