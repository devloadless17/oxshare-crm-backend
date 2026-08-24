import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requestContext } from '../logging/request-context';
import { clientIp, trustedProxyHops } from '../security/client-ip';
import { ProxyDepthObserver, proxyDepthSummary } from '../security/proxy-depth';
import { ALERT_KINDS, raiseAlert } from '../logging/alerts';
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
  private readonly logger = new Logger(RequestIdMiddleware.name);

  /**
   * Held HERE because this middleware is the one thing that runs exactly once
   * per request, before anything has read the caller's address.
   *
   * Nest instantiates a middleware applied with `forRoutes('*')` once, so this
   * is a per-process counter — which is what the sample needs to mean anything.
   */
  private readonly proxyDepth = new ProxyDepthObserver();

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
    this.checkProxyDepth(req);

    requestContext.run(
      {
        requestId: id,
        method: req.method,
        path: safeLogPath(req.originalUrl),
        // Resolved once here, under the configured trust boundary, so every audit
        // row and log line downstream agrees about who the caller was.
        ip: clientIp(req),
      },
      next,
    );
  }

  /**
   * Is `TRUSTED_PROXY_HOPS` still telling the truth about the infrastructure?
   *
   * On the request path, so it is wrapped: a counter that has an opinion about
   * proxies must never be the reason a request fails. Whatever goes wrong here,
   * the request proceeds — the worst case is that a misconfiguration goes
   * unreported, which is exactly where this started.
   */
  private checkProxyDepth(req: Request): void {
    try {
      const hops = trustedProxyHops();
      const verdict = this.proxyDepth.observe(req.headers['x-forwarded-for'], hops);
      if (!verdict) return;

      raiseAlert(
        this.logger,
        ALERT_KINDS.PROXY_DEPTH_MISMATCH,
        /*
         * SHALLOWER is the spoofable one — the trusted address is caller-supplied
         * text, so an allowlist can be walked through. DEEPER corrupts the audit
         * trail and collapses the rate limiter, which is serious and is not an
         * attacker's lever.
         */
        verdict === 'too_high' ? 'page' : 'notify',
        proxyDepthSummary(verdict, hops),
        { configuredHops: hops, verdict },
      );
    } catch {
      // Deliberately swallowed — see the docblock.
    }
  }
}
