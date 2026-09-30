import { Controller, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NoOriginCheck } from '../../../common/security/csrf.guard';
import { ProviderWebhookIngress } from '../core/provider-webhook-ingress.service';

/**
 * EVERY PROVIDER'S EVENTS, ONE DOOR (0168): `POST /v1/payments/providers/:code/webhook`.
 *
 * A new provider's events arrive here without a controller of its own. Its
 * receiver (`ProviderWebhookReceiver`, in its own folder) does the verifying
 * and the replay check; the core's `ProviderWebhookIngress` applies what it
 * verified. An unknown code answers 404 without reading the body.
 *
 * Unauthenticated at the HTTP layer because the caller is the provider's
 * server — nothing is trusted until the receiver has verified it.
 *
 * ── The decorators are the contract with the guard stack ───────────────────
 *
 *  - `@NoOriginCheck`: a server-to-server POST carries no Origin header, and
 *    the global CsrfGuard refuses origin-less writes by default — every
 *    delivery would die as a 403, which providers treat as PERMANENT.
 *  - `@Throttle` far above real traffic: a 429 is in every provider's
 *    RETRYABLE set, so a throttled genuine event survives.
 *  - `@ApiExcludeController`: machine-to-machine; publishing it in the OpenAPI
 *    document the frontends generate clients from would invite a browser call.
 *  - The status is set imperatively: the answer is a CONTROL SIGNAL to the
 *    provider's retry loop, decided by the receiver that knows its rules.
 */
@ApiExcludeController()
@Controller('payments/providers')
export class PaymentProviderWebhookController {
  constructor(private readonly ingress: ProviderWebhookIngress) {}

  @Post(':code/webhook')
  @NoOriginCheck(
    'Server-to-server delivery from a payment provider: each provider’s receiver authenticates ' +
      'the raw body with its own signature scheme before parsing. No browser, no cookie, no Origin.',
  )
  @Throttle({ default: { ttl: 60_000, limit: 240 } })
  async receive(
    @Param('code') code: string,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const answer = await this.ingress.receive(code, req.rawBody, headerOf(req));
    res.status(answer.status);
    return answer.body;
  }
}

/**
 * THE PRE-0168 DOOR: `POST /v1/payments/:code/webhook` — Rival's dashboard
 * holds `/v1/payments/rival/webhook` and keeps delivering there. Open only to a
 * provider whose adapter DECLARES that address (`webhookPath`); every other code
 * is a 404, so the old shape never becomes a second door for new providers.
 */
@ApiExcludeController()
@Controller('payments')
export class LegacyProviderWebhookController {
  constructor(private readonly ingress: ProviderWebhookIngress) {}

  @Post(':code/webhook')
  @NoOriginCheck(
    'Server-to-server delivery from a payment provider at the address its dashboard holds — ' +
      'authenticated by the provider’s own scheme over the raw body before parsing.',
  )
  @Throttle({ default: { ttl: 60_000, limit: 240 } })
  async receive(
    @Param('code') code: string,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!this.ingress.acceptsLegacyPath(code)) {
      res.status(404);
      return { received: false, outcome: 'unknown-provider' };
    }
    const answer = await this.ingress.receive(code, req.rawBody, headerOf(req));
    res.status(answer.status);
    return answer.body;
  }
}

function headerOf(req: Request): (name: string) => string | undefined {
  return (name) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
}
