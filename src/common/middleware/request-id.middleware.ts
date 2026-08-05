import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requestContext } from '../logging/request-context';
import { safeLogPath } from '../logging/redact';

/**
 * Correlation ID for every request.
 *
 * The working agreement requires "structured JSON logging with a correlation ID
 * through the request and into queued jobs". There was none — a 500 gave the
 * caller nothing to quote and gave us nothing to grep.
 *
 * Accepts an inbound `x-request-id` so a trace survives across services, and
 * echoes it on the response.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction): void {
    const inbound = req.header('x-request-id');
    // Only trust an inbound id that looks like one — it lands in logs.
    const id = inbound && /^[\w-]{8,128}$/.test(inbound) ? inbound : randomUUID();
    req.id = id;
    res.setHeader('x-request-id', id);

    // Everything downstream of here — including code that never sees `req` —
    // can reach this id through currentRequestId().
    /*
     * `safeLogPath`, not the raw URL: this path is stamped by JsonLogger onto
     * EVERY line of the request, so a `?token=` in it was written to the log
     * repeatedly rather than once (R-6.3).
     */
    requestContext.run(
      { requestId: id, method: req.method, path: safeLogPath(req.originalUrl) },
      next,
    );
  }
}
