import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter, clientClosedRequest } from './all-exceptions.filter';

/**
 * A client that hangs up mid-request is not a server failure. It used to be
 * logged as a 500 (eight KYC uploads from one phone on 16 Oct 2026), so the
 * error count said the API was failing when it was not.
 */
function run(exception: unknown, request: Record<string, unknown>) {
  const filter = new AllExceptionsFilter();
  const logger = (filter as unknown as { logger: { error: () => void; warn: () => void } }).logger;
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const sent = { status: 0, json: false, ended: false };
  const res = {
    headersSent: false,
    setHeader() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    json() {
      sent.json = true;
      return this;
    },
    end() {
      sent.ended = true;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({
        method: 'POST',
        url: '/v1/kyc/upload',
        id: 'r1',
        headers: {},
        ...request,
      }),
    }),
  } as unknown as ArgumentsHost;
  filter.catch(exception, host);
  return { sent, error, warn };
}

describe('a client that hangs up is a warning, not a server error', () => {
  it("logs multer's 'Request aborted' on an aborted request as 499, and sends nothing", () => {
    const { sent, error, warn } = run(new Error('Request aborted'), { aborted: true });
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('→ 499 CLIENT_CLOSED_REQUEST: Request aborted'),
    );
    expect(sent).toEqual({ status: 499, json: false, ended: true });
  });

  it("recognises body-parser's own marker", () => {
    expect(clientClosedRequest({ type: 'request.aborted' }, {})).toBe(true);
  });

  it('still logs a real failure on a live request as a 500', () => {
    const { sent, error } = run(new TypeError('boom'), {});
    expect(error).toHaveBeenCalled();
    expect(sent.status).toBe(500);
  });
});
