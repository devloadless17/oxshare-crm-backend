import { Body, Controller, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BridgeSecretGuard } from './bridge-secret.guard';
import { Mt5DealsService } from './mt5-deals.service';
import { Mt5DealDto } from './dto/mt5-deal.dto';

/**
 * Where the MT5 bridge posts closed deals — the push half of ARCHITECTURE
 * §3.1's "push + sweep".
 *
 * ── This endpoint always answers 200, even for a duplicate ─────────────────
 *
 * The bridge treats 2xx and 409 as delivered and retries everything else with
 * backoff, forever, because a deal it cannot deliver is a financial event the
 * CRM would never learn about. So the contract here is deliberately generous:
 * a re-delivered ticket is `{ ingested: false }` and a 200, not an error.
 *
 * The only 4xx it can produce is a malformed body (validation) or a bad secret,
 * and both are conditions a retry cannot fix — which is exactly why they must be
 * distinguishable from "the CRM is having a bad minute".
 *
 * ── Not in the public API docs ─────────────────────────────────────────────
 *
 * `@ApiExcludeController`: this is a private machine-to-machine surface on an
 * internal network, and publishing it in the OpenAPI document the admin console
 * generates its client from would invite somebody to call it from a browser.
 */
@ApiTags('mt5')
@ApiExcludeController()
@Controller('webhooks/mt5')
@UseGuards(BridgeSecretGuard)
export class Mt5WebhooksController {
  constructor(private readonly deals: Mt5DealsService) {}

  @Post('deals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ingest one closed deal from the MT5 bridge' })
  @ApiOkResponse({
    description:
      '`ingested: false` means the ticket was already stored — the expected outcome for the ' +
      'second of the two deliveries every deal gets.',
  })
  async ingestDeal(
    @Body() deal: Mt5DealDto,
    /**
     * Which path delivered it. Recorded rather than acted on: when one of the
     * two ingestion routes breaks, "every deal for the last day arrived via
     * sweep" is the line that says so.
     */
    @Query('source') source?: string,
  ) {
    const result = await this.deals.ingest(deal, source === 'sweep' ? 'sweep' : 'push');
    return { dealId: deal.dealId, ...result };
  }
}
