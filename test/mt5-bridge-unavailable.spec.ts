import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import { ExternalServiceError } from '../src/common/errors/domain-errors';

/**
 * The bridge's 503 (7 Oct 2026): MT5 could not be ASKED — the bridge is
 * reconnecting after a network drop, or its one MT5 session is busy — and
 * nothing was sent. A READ gets one retry, so a ten-second reconnect is an
 * answer rather than an "unreachable" screen. A WRITE never does: its retry
 * belongs to the caller that owns the idempotency key.
 */

const config = {
  get: (key: string) => ({ MT5_BRIDGE_URL: 'http://bridge.test', MT5_BRIDGE_API_KEY: 'k' })[key],
} as unknown as ConfigService;

const unavailable = () =>
  new Response(
    JSON.stringify({ error: 'not connected', code: 'MT_RET_ERR_CONNECTION', retryable: true }),
    {
      status: 503,
    },
  );

const snapshot = { login: '1001', balance: '10.00' };

describe('Mt5BridgeClient on a 503 from the bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retries a read once, and answers with the retry', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const pending = new Mt5BridgeClient(config).getAccount('1001');
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual(snapshot);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a read only ONCE, then says MT5 is unavailable and nothing changed', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(unavailable()));
    vi.stubGlobal('fetch', fetch);

    const pending = new Mt5BridgeClient(config).getAccount('1001');
    const outcome = pending.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await outcome;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).upstreamStatus).toBe(503);
    expect((error as Error).message).toBe(
      'MT5 is temporarily unavailable (GET /accounts/1001). Nothing was changed; try again in a few seconds.',
    );
  });

  it('never retries a WRITE — the caller owns its idempotency key', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(unavailable()));
    vi.stubGlobal('fetch', fetch);

    const error = await new Mt5BridgeClient(config)
      .balance({
        login: '1001',
        amount: '5.00',
        type: 'balance',
        comment: 't',
        idempotencyKey: 'key-1',
      })
      .catch((e: unknown) => e);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as ExternalServiceError).upstreamStatus).toBe(503);
  });
});
