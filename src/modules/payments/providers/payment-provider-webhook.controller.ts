import { Controller, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NoOriginCheck } from '../../../common/security/csrf.guard';
import { PAYMENT_PROVIDER_WEBHOOKS, type ProviderWebhookReceiver } from './payment-provider';

/**
 * EVERY PROVIDER'S EVENTS, ONE DOOR (0168): `POST /v1/payments/providers/:code/webhook`.
 *
 * A new provider's events arrive here without a controller of its own: its
 * receiver (`ProviderWebhookReceiver`) does the verifying, the replay check and
 * the applying, and this only routes by code. Rival's own
 * `/v1/payments/rival/webhook` stays, because Rival's dashboard holds that
 * address; the two reach the same handling.
 *
 * Unauthenticated at the HTTP layer for the same reason Rival's route is: the
 * caller is the provider's server. Nothing is trusted until the receiver has
 * verified it, and an unknown code answers 404 without reading the body.
 */
@ApiExcludeController()
@Controller('payments/providers')
export class PaymentProviderWebhookController {
  private readonly receivers: Map<string, ProviderWebhookReceiver>;

  constructor(@Inject(PAYMENT_PROVIDER_WEBHOOKS) receivers: readonly ProviderWebhookReceiver[]) {
    this.receivers = new Map(receivers.map((receiver) => [receiver.providerCode, receiver]));
  }

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
    const receiver = this.receivers.get(code);
    if (!receiver) {
      res.status(404);
      return { received: false, outcome: 'unknown-provider' };
    }
    const answer = await receiver.receive(req.rawBody, (name) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    });
    res.status(answer.status);
    return answer.body;
  }
}
