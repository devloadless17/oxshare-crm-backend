import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { IbApplicationsService } from './ib-applications.service';
import { IbOverviewService } from './ib-overview.service';
import { IbWalletService } from './ib-wallet.service';
import { CreateIbApplicationDto, IbApplicationDto, IbStatusDto } from './dto/ib-application.dto';
import { IbCommissionRowDto, IbOverviewDto } from './dto/ib-overview.dto';
import { IbWalletTransferDto, IbWalletTransferResultDto } from './dto/ib-wallet.dto';
import { PublicAgencyDto } from '../products/dto/catalogue.dto';
import { ProductsStore } from '../../store/products.store';

/**
 * The client's own view of the partner programme.
 *
 * `EmailVerifiedGuard` alongside the auth guard, matching KYC: an unverified
 * address cannot receive the decision email, so an application from one is a
 * review whose outcome has nowhere to go.
 *
 * The KYC requirement is NOT a guard. It is a rule about eligibility that the
 * client should be told about before they fill anything in, so `GET /ib/status`
 * reports it as `eligible: false` with a sentence, and `POST /ib/apply`
 * enforces it. Explain first, refuse second — the same split used elsewhere.
 */
@ApiTags('ib')
@Controller('ib')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
export class IbController {
  constructor(
    private readonly applications: IbApplicationsService,
    private readonly overview: IbOverviewService,
    private readonly ibWallets: IbWalletService,
    /*
     * The `@Global()` store rather than `CatalogueService`, so this module does
     * not have to import ProductsModule (and through it TradingModule) for one
     * read. The shaping the DTO needs — product ids to product names — is two
     * lines and lives below.
     */
    private readonly catalogue: ProductsStore,
  ) {}

  /** Enabled agencies with their product names, for the applicant to read. */
  private async listOpenAgencies(): Promise<PublicAgencyDto[]> {
    const [agencies, products] = await Promise.all([
      this.catalogue.listAgencies(),
      this.catalogue.listProducts(),
    ]);
    const nameOf = new Map(products.map((product) => [product.id, product.name]));

    return agencies
      .filter((agency) => agency.enabled)
      .map((agency) => ({
        id: agency.id,
        name: agency.name,
        description: agency.description,
        products: agency.productIds
          .map((id) => nameOf.get(id))
          .filter((name): name is string => Boolean(name)),
      }));
  }

  @Get('status')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Where this client stands with the partner programme',
    description:
      'Returns the partner account if they have one AND their most recent application if they ' +
      'have made one. Both, because "never applied" and "rejected, here is why" are different ' +
      'states and a client shown a blank form after a refusal has been told nothing.',
  })
  @ApiOkResponse({ type: IbStatusDto })
  status(@Req() req: Request & { user: User }) {
    return this.applications.statusFor(req.user.id);
  }

  @Get('overview')
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      "An approved partner's own dashboard — level, earnings, referred clients, sub-partners",
    description:
      'Everything the partner area renders, in one request, because these figures are read ' +
      'together and a count from one instant beside a total from another is a screen that ' +
      'contradicts itself.\n\n' +
      '404s for a client who is not a partner: zeroes across the board would render as a partner ' +
      'dashboard belonging to somebody who is not one. Call GET /ib/status first.\n\n' +
      'IMPORTANT — `earnings.engineLive` is FALSE today. The commission engine was removed in ' +
      'migration 0028 and nothing writes commission entries yet, so the totals are true reads of ' +
      'an empty ledger rather than computed results. A client MUST label them as such instead of ' +
      'presenting a calculated-looking zero.',
  })
  @ApiOkResponse({ type: IbOverviewDto })
  overviewForMe(@Req() req: Request & { user: User }) {
    return this.overview.overviewFor(req.user.id);
  }

  @Get('commissions')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every commission this partner has earned, newest first',
    description:
      'The other half of the dashboard totals. Those read the LEDGER — money actually paid — so ' +
      'a partner whose accruals are still maturing sees zero there with no way to tell "nothing ' +
      'earned" from "earned, not yet released". Each row carries its status, so the two numbers ' +
      'explain each other.\n\n' +
      '`source: position` is a closed trade, which is the only thing that pays a revenue share. ' +
      '`transaction` rows are historical — commission is no longer earned on deposits.',
  })
  @ApiOkResponse({ type: [IbCommissionRowDto] })
  commissions(@Req() req: Request & { user: User }) {
    return this.overview.commissionsFor(req.user.id);
  }

  /*
   * ── `GET /ib/positions` IS GONE ──────────────────────────────────────────
   *
   * It queried the `positions` TABLE, which is created empty on purpose and
   * written by nothing — a stored profit is stale the moment it is saved. So
   * the endpoint answered `[]` on a platform with live trades, and the partner
   * screen read as "your clients are not trading".
   *
   * Reading it LIVE is what the account screen does, and it does not scale
   * here: one bridge call per client ACCOUNT, serialised behind the single MT5
   * session lock. A partner with fifty clients holding two accounts each is a
   * hundred round trips per page load, blocking every other client meanwhile.
   *
   * Removed rather than repaired. FR-IB-17 owes a partner visibility of their
   * sub-tree EARNINGS, and `GET /ib/commissions` carries every closed trade
   * that paid them.
   */

  @Get('agencies')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The partner programmes (وكالة) open for application',
    description:
      'What an applicant chooses between, with the products each one carries spelled out by ' +
      'name. Disabled agencies are ABSENT rather than greyed out: nobody here can answer "when ' +
      'does it reopen", and offering a choice that will be refused is a poor way to learn it is ' +
      'closed.\n\n' +
      'An empty list means no programme is configured yet. The portal should let the client ' +
      'apply anyway — an agency is optional on the application, so a deployment that has not set ' +
      'them up still takes partners.',
  })
  @ApiOkResponse({ type: [PublicAgencyDto] })
  openAgencies() {
    return this.listOpenAgencies();
  }

  @Get('wallet/transfers')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Commission moved out of the commission wallet, newest first',
    description:
      'Every transfer, newest first, with the wallet numbers at both ends. It was capped at TEN ' +
      'while it rendered as a short panel beside the balance it explains; it is now a paged tab ' +
      'of its own, and a cap that silently hid a partner’s older transfers was the reason it ' +
      'could not answer “where did my money go”. ' +
      'These rows also appear in `GET /payments/transactions` alongside every other movement — a ' +
      "partner's own money should not be split across two histories that have to be reconciled " +
      'against each other.',
  })
  @ApiOkResponse({ type: [IbWalletTransferResultDto] })
  myWalletTransfers(@Req() req: Request & { user: User }) {
    return this.ibWallets.listTransfers(req.user.id);
  }

  @Post('wallet/transfer')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Move commission earnings into the main wallet',
    description:
      'Same currency, same owner, both legs in one transaction — it commits whole or does not ' +
      'happen. There is no pending state to poll: unlike a wallet ⇄ trading-account transfer, ' +
      'nothing here crosses into a server this platform does not own.\n\n' +
      'Refuses a suspended partner, an amount above the available commission balance, and a ' +
      'currency the partner holds no commission wallet in — each with its own message, because ' +
      '"you have nothing to move" and "you have no such wallet" send a partner to different ' +
      'places.\n\n' +
      'Both legs are written to the ledger as `transfer`, NOT `commission`, so lifetime earnings ' +
      'are unchanged by moving money that was already earned.',
  })
  @ApiOkResponse({ type: IbWalletTransferResultDto })
  transferCommission(@Req() req: Request & { user: User }, @Body() dto: IbWalletTransferDto) {
    return this.ibWallets.transferToMain(req.user.id, dto);
  }

  @Post('apply')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Apply to become a partner',
    description:
      'Requires a verified identity (KYC level 1). Refuses a second application while one is ' +
      'still awaiting review, and refuses outright if the client is already a partner. ' +
      '`agencyId` names the programme applied for and must be one GET /ib/agencies returned.',
  })
  @ApiOkResponse({ type: IbApplicationDto })
  apply(@Req() req: Request & { user: User }, @Body() dto: CreateIbApplicationDto) {
    return this.applications.apply(req.user.id, dto);
  }
}
