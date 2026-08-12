import { Controller, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NoOriginCheck } from '../../../common/security/csrf.guard';
import { RivalWebhookService } from './rival-webhook.service';

/**
 * Where Rival tells us something happened — the ONE unauthenticated-by-cookie
 * route in the payments module, and a separate file so the unauthenticated
 * surface of this system stays greppable (the rule inherited from the deleted
 * `payment-callbacks.controller.ts`, whose anonymous-GET model this replaces).
 *
 * "Unauthenticated" here means no session: every delivery IS authenticated,
 * twice — a bearer key we minted, and an HMAC over the exact raw bytes — and
 * verified before it is parsed, with a single-use replay marker behind it.
 * `RivalWebhookService` owns all of that; this class only carries the
 * decorators and copies the verdict onto the response.
 *
 * ── Why the response status is set imperatively ────────────────────────────
 *
 * The answer is a CONTROL SIGNAL to Rival's retry loop (401 kills an event
 * forever, 503 schedules another attempt), so the service decides it next to
 * the logic that knows, and this handler must not round every answer to one
 * code the way `@HttpCode` would.
 *
 * ── The decorators are the contract with the guard stack ───────────────────
 *
 *  - `@NoOriginCheck`: a server-to-server POST carries no Origin header, and
 *    the global CsrfGuard refuses origin-less writes by default. Without this,
 *    every delivery dies as a 403 — which Rival treats as PERMANENT, so the
 *    event is not delayed but lost. (`csrf.spec.ts` tests exactly this branch,
 *    written for "Whish and USDT arriving the same way".)
 *  - `@Throttle` far above real traffic: if a flood ever trips it, 429 is in
 *    Rival's RETRYABLE set, so a throttled genuine event survives. Never
 *    answer rate-limiting with a 4xx here.
 *  - `@ApiExcludeController`: machine-to-machine; publishing it in the OpenAPI
 *    document the frontends generate clients from would invite a browser call.
 */
@ApiExcludeController()
@Controller('payments/rival')
export class RivalWebhookController {
  constructor(private readonly webhook: RivalWebhookService) {}

  @Post('webhook')
  @NoOriginCheck(
    'Server-to-server delivery from Rival: authenticated by a minted bearer key plus an HMAC ' +
      'over the raw body, verified before parsing. No browser, no cookie, no Origin.',
  )
  @Throttle({ default: { ttl: 60_000, limit: 240 } })
  async receive(@Req() req: RawBodyRequest<Request>, @Res({ passthrough: true }) res: Response) {
    const answer = await this.webhook.handle(req.rawBody, (name) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    });
    res.status(answer.status);
    return answer.body;
  }
}
