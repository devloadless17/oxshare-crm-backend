import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';

/**
 * The payer's way home — its own file because it is an UNAUTHENTICATED surface,
 * like the webhook controller, and those must stay greppable.
 *
 * The provider's redirect URLs point HERE (the API's public origin), never at
 * the portal, and this endpoint 302s the browser on to the portal's result
 * page. That indirection is the point (tech lead's direction):
 *
 *  - Only the API needs a payer-reachable address. The portal can be
 *    localhost in dev, an internal hostname on staging — the payment provider
 *    never sees it, so Rival's redirect-URL rule (D-68) is satisfied by the
 *    one origin that is public anyway for webhooks.
 *  - The portal address is CONFIG on our side, not state registered with a
 *    provider. Moving the portal never touches provider config again.
 *
 * ## Why this is safe with no session
 *
 * The payer arrives from the provider's page, carrying no cookie for this
 * origin. That is fine because this endpoint DOES NOTHING but bounce:
 *
 *  - It reads no row and changes no state — settlement belongs to the signed
 *    webhook, the poller, and the portal's authenticated status endpoint. An
 *    endpoint anyone can GET must not be a trigger for anything.
 *  - It discloses nothing: the redirect target is built from OUR config plus
 *    the reference/outcome the caller already knows (they are in the URL the
 *    caller just used).
 *  - It cannot become an open redirect: the HOST comes only from PORTAL_URL,
 *    and every interpolated value is allowlist-validated then URL-encoded. A
 *    reference of `../../evil` or a method of `//attacker.com` is refused,
 *    not forwarded.
 *
 * The outcome in the URL is the PROVIDER'S claim, not ours — the portal page
 * it lands on asks the API, which asks Rival (`ask-don't-trust`, see
 * `settleGatewayDeposit`). A payer editing `failure` to `success` in their
 * address bar changes which page asks the question, never the answer.
 */
@ApiExcludeController()
@Controller('payments/deposits')
export class PaymentsReturnController {
  constructor(private readonly config: ConfigService) {}

  @Get(':reference/return/:outcome')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  bounce(
    @Param('reference') reference: string,
    @Param('outcome') outcome: string,
    @Query('method') method: string | undefined,
    @Res() res: Response,
  ): void {
    const safeOutcome = outcome === 'success' ? 'success' : 'failure';
    // The reference format is ours (OX-…); anything else is not a deposit
    // reference and gets the failure page rather than a reflected value.
    const safeReference = /^[A-Z0-9-]{1,32}$/.test(reference) ? reference : '';
    // The namespace the link carried, or nothing: the portal then finds the
    // deposit by its reference and the signed-in owner (0168). Never a guess.
    const safeMethod = method && /^[a-z0-9_-]{1,40}$/.test(method) ? method : null;

    const base = (this.config.get<string>('PORTAL_URL') ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
    const target =
      `${base}/deposit/${safeOutcome}` +
      `?reference=${encodeURIComponent(safeReference)}` +
      (safeMethod ? `&method=${encodeURIComponent(safeMethod)}` : '');

    // 302, not 301: the portal address is config and must never be cached
    // into payers' browsers across a move.
    res.redirect(302, target);
  }
}
